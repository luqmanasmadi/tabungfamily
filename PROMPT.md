# Build prompt — TabungFamily (family fund app)

Paste this whole file into your coding assistant. It is the complete spec agreed during design.
If the folder already has `supabase/schema.sql`, `supabase/cron.sql`, `supabase/functions/tabung/index.ts` and `apps-script/Code.gs`, treat them as a first draft: review them against this spec, fix gaps, then build what is missing (mainly `web/index.html`, `web/import-template.csv` and `README.md`).

---

## 1. Goal

Build **TabungFamily**: a web app for a family treasurer to manage a monthly family fund.

- 5–6 family members each pay a **fixed RM100/month** (the amount can be changed in settings).
- **Anyone** with the link can view the dashboard (read-only).
- **Only the treasurer (admin)** can change data.
- Members pay by bank transfer and send the receipt photo to a **Telegram bot**. The bot reads it with AI, saves the photo to **Google Drive**, and records it as *pending*. The admin taps **Approve** and the dashboard updates.
- Everything must run on **free tiers**.
- Language: **Bahasa Melayu by default, with an English toggle** (BM/EN) on every page.
- Must work well on **laptop and phone**.

## 2. Stack (all free)

| Part | Tool |
|---|---|
| Web dashboard + admin | One static `web/index.html`, hosted on **GitHub Pages** |
| Database + admin login | **Supabase** (Postgres, Auth email+password, Row Level Security) |
| Bot + scheduled jobs + admin actions | **Supabase Edge Function** `tabung` (Deno, deployed `--no-verify-jwt`) |
| Schedules | **pg_cron** + **pg_net** in Supabase |
| Bot | **Telegram Bot API** (webhook to the edge function, secret-token header) |
| Read receipts | **Gemini API** (free tier, model name in env `GEMINI_MODEL`, JSON output) |
| Receipt storage + backup | **Google Apps Script** web app (Drive + Google Sheet) |
| PDF statements | `pdf-lib` inside the edge function |

WhatsApp was ruled out: the official API is paid and can't post to groups; unofficial bots risk a ban. Use Telegram for everything, plus a one-tap **"share to WhatsApp"** link (`https://wa.me/?text=...`) the admin can forward manually.

## 3. Data model (Postgres)

**settings** (key/value):
- `admin_email`
- `fund_name`
- `monthly_due` (default `100`)
- `opening_balance` (money before the first record)
- `last_backup_at`
- `backup_sheet_url`
- `backup_hook_url`
- `backup_secret`

The public can read only `fund_name`, `monthly_due`, `opening_balance` and `last_backup_at`.

**members**:
- `id`, `name` (unique)
- `start_month` (date, first of month: first month they owe)
- `tg_chat_id` (unique, set when linked to the bot)
- `created_at`

**member_breaks**: months a member does NOT owe.
- `id`, `member_id`
- `from_month` (first month not owed)
- `to_month` (null = still stopped)
- `reason`, `created_at`
- "Stop contributing" = insert an open break.
- "Reactivate" = close the break with `to_month` = last month before now, or delete it if it started this month or later.

**cash_in**:
- `id`, `member_id`, `paid_on`, `amount > 0`
- `method` (`transfer`|`cash`), `ref` (bank/DuitNow reference), `receipt_url` (Drive, private)
- `tg_file_uid` (duplicate check)
- `batch_id` (uuid; one receipt can be split across several members)
- `sent_by` (member who sent the receipt), `source` (`bot`|`manual`|`import`)
- `status` (`pending`|`approved`|`rejected`), `note`, `created_at`
- Unique `(ref, member_id)` where ref is not null and status ≠ rejected.

**cash_out**:
- `id`, `spent_on`, `description`, `category` (`kenduri`, `perubatan`, `raya`, `rumah`, `kecemasan`, `lain`…), `amount > 0`
- `receipt_url` (Drive, **public** link)
- `legacy` (bool): old imported record with no receipt
- `tg_file_uid`, `source`, `created_at`
- Check: `receipt_url is not null or legacy`. A receipt is mandatory for every new spending.

## 4. Money rules

- **Dues owed** by a member = every month from `start_month` up to the current month (Malaysia time, UTC+8), **excluding months inside any break**, × `monthly_due`.
- **Outstanding** = max(0, dues owed − total approved payments). Only `approved` payments count anywhere public.
- **Allocation is FIFO.** Payments fill the oldest owed month first. Extra money counts as paid in advance and shows future months as paid.
- **Member month status** (for the grid):
  - *paid*: fully covered;
  - *partial*;
  - *unpaid*: past or current month not covered;
  - *upcoming*: future month not covered;
  - *not a member / stopped*: before `start_month` or inside a break.
- **Fund balance**:
  - current = `opening_balance` + all approved cash-in − all cash-out;
  - per year: brought forward = opening + everything before 1 Jan; closing = brought forward + year in − year out.
- **Stopped member**: no dues after their last month, so no outstanding for those months. Old payments stay on record and still show on the dashboard. Default "last month" in the stop dialog = the member's last fully-paid month, so outstanding becomes RM0. Show "outstanding now" vs "after stopping" before confirming.

## 5. Telegram bot

### Linking (once per person)
1. The person sends `/start` to the bot.
2. The admin gets a DM: "X wants to connect. Who is this?" with one button per unlinked member, plus **Ignore**.
3. The admin taps a name. That member's `tg_chat_id` is saved and the person gets a welcome message.

### Paying (members): no text needed
1. The member sends a **photo or PDF** of the receipt; the caption is optional.
2. The bot replies "⏳ Membaca resit…", downloads the file and asks Gemini for JSON: `{is_receipt, amount, date, ref, payee}`.
3. Rejections:
   - Not a receipt → ask for a clearer photo.
   - Same Telegram file already used (not rejected) → tell them.
   - Same `ref` already used → auto-reject and tell the admin.
4. **Who the payment is for:**

   | Caption | Result |
   |---|---|
   | Empty | Payment is for the sender |
   | A member name, e.g. `Mak` | Payment is for that member |
   | Several names, e.g. `Mak, Abah` (also `&`, `+`, `dan`, `and`) | Amount split equally, one row per member, same `batch_id`; last share takes the rounding remainder |
   | Only unknown names | Record for the sender and ask them with buttons "who is this payment for?" (only the sender can answer, only while pending) |

   Paying several months at once needs no caption; FIFO handles it.
5. The photo is uploaded to Drive (`TabungFamily/Resit/YYYY-MM/`, private) through Apps Script.
6. Rows are inserted as **pending**. If AI couldn't read the amount, use `monthly_due` and note "AI tak dapat baca jumlah — semak".
7. The bot tells the sender: received, amount, for whom, waiting for the treasurer.
8. The admin gets one message per receipt (batch):
   - each member and amount, total, "sent by X" if paying for others, date, ref, payee name, note, receipt link;
   - buttons **✅ Sahkan / ❌ Tolak**.
9. **Approve:** the batch becomes approved. The members and the sender get a DM, the family group gets "✅ X bayar RMy. Terima kasih!", and the button changes to "✅ Disahkan".
10. **Reject:** the members and the sender are told to contact the treasurer.

### Admin commands
- **Photo + caption `/out 150 lain Hadiah konvo Adik`** → cash-out (amount, category, description).
  - The receipt is required. It goes to Drive with a **public** link.
  - The admin and the group get "💸 Duit keluar …" with the receipt link and the new balance.
- `/pending` lists receipts waiting for approval.
- `/ingat` sends the reminder now.
- `/penyata 2026` previews the yearly statements (sent to the admin only).

### Member commands
- `/status`: own outstanding, months, total paid, advance, or "stopped, no outstanding".
- `/baki`: fund balance plus the dashboard link.
- Any other text shows help.

The bot ignores group chats except to post announcements.

## 6. Schedules

| When (Malaysia time) | What |
|---|---|
| Every day 8:00pm (pg_cron 12:00 UTC → edge `?task=daily`) | Keep the free project awake. **If tomorrow is the 1st, send the monthly reminder.** |
| Monthly reminder | Post to the family Telegram group the list of members not fully paid (name, months, RM), total outstanding, fund balance and the dashboard link. DM each member who owes. DM the admin "Reminder sent" plus a **"📲 Kongsi ke WhatsApp"** link with the same text. Stopped members with RM0 outstanding are not listed. |
| 1 January 9:00am (`?task=statement`) | Yearly **PDF statement** to each member by Telegram DM, for the previous year. Contents: member, fee, start month, each payment (date, ref, amount), paid this year, due this year, outstanding or advance at 31 Dec, fund summary (in, out, balance). Header in BM / EN. The admin gets a summary listing who hasn't linked Telegram. |
| Every night 3:00am (Apps Script time trigger) | Full backup snapshot to the Google Sheet. |
| Weekly (inside the nightly run) | Copy the Sheet to `TabungFamily/Backup mingguan/` and keep the newest 12 copies. |

Scheduled calls need the header `x-cron-secret`.

## 7. Edge function admin endpoint

`POST /functions/v1/tabung?admin` with `Authorization: Bearer <admin session token>`. Verify that the token's user email equals `settings.admin_email`; send CORS headers.

| Action | Body | Does |
|---|---|---|
| `approve` / `reject` | `{batch_id, amounts?: {rowId: amount}}` | Same as the bot buttons, including notifications. Lets the admin correct amounts before approving. |
| `backup` | — | Calls Apps Script `snapshot`; returns the time |
| `remind` | — | Sends the monthly reminder now |
| `upload` | `{name, mime, data(base64), public}` | Uploads a receipt from the web admin to Drive; returns the URL |

## 8. Google Apps Script (one standalone script, deployed as a web app)

**Script properties:**
- `SECRET` (same value as `DRIVE_SECRET` and `settings.backup_secret`)
- `SUPABASE_URL`
- `SERVICE_KEY`

Time zone: Kuala Lumpur.

`doPost` actions (all require the secret):

- **`upload`**: save the file to `My Drive/TabungFamily/Resit/YYYY-MM/`. If `public`, set anyone-with-link can view. Return `{ok, url}`.
- **`change`**: real-time sync.
  - A Postgres trigger (`after insert/update/delete` on members, member_breaks, cash_in, cash_out, using `pg_net`) posts every row change with the member name.
  - Upsert or delete the same row in the matching tab by `id`.
  - Append to the `log` tab and refresh the dashboard.
  - The trigger must never block a save if the backup is unreachable.
- **`snapshot`**:
  - read all tables from Supabase REST with the service key;
  - rewrite the data tabs;
  - write the time;
  - refresh the dashboard;
  - weekly copy;
  - write `last_backup_at` and `backup_sheet_url` back to Supabase settings.

A `setup()` function, run once:
- creates the Sheet "TabungFamily Backup" in `My Drive/TabungFamily/`;
- builds the tabs and Dashboard;
- installs the 3am trigger and an onEdit trigger;
- runs the first snapshot.

**Sheet tabs.** Column names match the Import feature, so a tab saved as CSV can be imported back as a restore.
- `Dashboard` (first)
- `ahli`: id, nama, mula, telegram, dicipta
- `rehat`: id, ahli_id, ahli, dari, hingga, sebab
- `duit_masuk`: id, tarikh, ahli, jenis=`masuk`, jumlah, cara, rujukan, status, resit, sumber, keterangan, kategori, dihantar_oleh
- `duit_keluar`: id, tarikh, ahli (blank), jenis=`keluar`, jumlah, keterangan, kategori, rujukan, resit, rekod_lama
- `tetapan` (hide the secret keys)
- `log`

**Dashboard tab** (theme colours navy/blue):
- Title, last backup time, and a **year dropdown** (B3) that drives everything.
- KPI row, using **formulas** so it works even if the app is down:
  - brought forward;
  - in (year);
  - out (year);
  - closing (year);
  - current balance;
  - outstanding now.
- Monthly table Jan–Dec (in, out) with formulas, plus a column chart.
- **Member grid**: member × Jan–Dec (✓ / ½ / ! / —, coloured cells), paid this year, outstanding, Active/Stopped. The script computes it from the Sheet's own tabs (same rules as section 4) and refreshes it on every change, snapshot and year edit.
- Outstanding list sorted by amount.
- Spending by category for the year (QUERY formula).

## 9. Web app (`web/index.html`, single file, GitHub Pages)

**Config at the top:**
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BOT_USERNAME`
- If empty, run **demo mode** with the sample data in section 12 so it can be previewed.

**Libraries:**
- supabase-js v2 from jsdelivr;
- SheetJS (`xlsx`) from jsdelivr, lazy-loaded only for import.

**Design theme** (match the reference deck):
- Font **Inter** 400–800.
- Colours:
  - ink/navy `#1F2A5C`, muted `#5A6699`, background paper `#F6F3FD`
  - blush `#DDE3F8`, rose `#AEBDEA`, blue `#3F5BB5`
  - amber `#F9B774`, sun `#F7E58F`, mint `#A8E0B5`, red `#E5484D`, line `#D6DCF2`
- Cards: white, 1px line border, radius 18px.
- Hero card: gradient `linear-gradient(150deg,#1F2A5C,#3F5BB5)` with white text, a shadow, and a small tilted yellow chip ("LIVE", or "DITUTUP" for past years).
- Eyebrow labels: uppercase, 0.14em letter-spacing, blue.
- Headings: 800 weight, tight letter-spacing, one key word in blue.
- Paid = blue filled circle with ✓. Unpaid = orange (`#FBEBDD` bg, `#C0661B` border, `#8A420B` text). Upcoming = dashed rose. Not a member / stopped = grey `#E4E6EE`.
- Tabular numbers. Touch targets ≥ 44px. Labels on all inputs. Real buttons and links.

**Layout:**
- **Laptop**: top header with logo, nav (Ringkasan / Ahli / Duit keluar), BM|EN toggle, Admin button; content max-width 1200px.
- **Phone** (<760px): header with logo and BM|EN; sections stacked; fixed **bottom nav** (Utama, Ahli, Keluar, Admin); wide tables scroll inside their card.
- The language choice is saved in localStorage (wrapped in try/catch).
- `#admin` hash opens the admin view.

### Public dashboard

- **Year filter**: buttons for each year that has data (e.g. 2025 | 2026); default = current year. It changes every section below.
- **Hero**:
  - eyebrow "Tabung keluarga · Nov 2026";
  - headline "Duit keluarga, *telus* untuk semua.";
  - one-line explanation;
  - yellow chip "RM100 / ahli / bulan";
  - if `BOT_USERNAME` is set, "Hantar resit ke @bot".
- **Balance card**:
  - current year: "Baki semasa"; past year: "Baki akhir 2025";
  - big amount;
  - updated time;
  - three tiles: brought forward, in (year), out (year).
- **4 KPI cards**: in (latest month of the view), out (latest month), outstanding (RM + number of members), active members paid up (e.g. 3 / 5).
- **Bar chart** Jan–Dec, in vs out (simple CSS bars, no chart library).
- **Recent transactions** (approved in + out for the year, newest 5–6).
- **Member payment grid** for the year:
  - columns: member, Jan–Dec, paid (year), outstanding;
  - stopped members show "Berhenti · <last month>" and outstanding "Berhenti";
  - hide members who weren't members that year;
  - legend.
- **Spending table**: date, item, category chip, amount, "Lihat resit" (public Drive link) or "Rekod lama" for legacy.
- **Footer**: "Peringatan auto · hari terakhir bulan, 8:00pm".

### Admin view (login: email + password via Supabase Auth; then check `is_admin()`; sign-ups disabled)

Dark navy header with an "ADMIN" chip, BM|EN, and Log keluar.

**1. Pending receipts:**
- grouped by `batch_id`;
- receipt thumbnail or link, member(s) with an **editable amount** each, date, ref;
- AI tag: green "read by AI · payee", or orange "AI couldn't read amount";
- "sent by" when relevant;
- **Tolak / Sahkan** call the edge admin endpoint, so members still get Telegram notifications.

**2. Add record**, tabs *Duit masuk / Duit keluar*:
- **In** (cash payments): member, date, amount, method → `approved`, source `manual`.
- **Out**: description, category, amount, date, then either a receipt file (uploaded through the edge `upload` action, public) or a tick for "rekod lama tanpa resit" (legacy).

**3. Members & Telegram:**
- table: name, start month, Telegram linked or not, outstanding, status (Aktif / Berhenti · last month);
- actions:
  - **Hentikan sumbangan** (stop);
  - **Aktifkan semula** (reactivate);
  - unlink Telegram;
  - delete (only if the member has no payments);
- **+ Tambah ahli** (name, start month);
- **Stop dialog**:
  - "last month contributing" (defaults to the last fully-paid month);
  - optional reason;
  - info "Yuran selepas bulan ini tidak dikira. Rekod lama kekal. Boleh aktifkan semula bila-bila masa.";
  - outstanding now vs after stopping (RM0);
  - Batal / Sahkan berhenti.

**4. Import past records** (Excel `.xlsx` or CSV), 3 steps:
1. **Download template** (generated client-side): columns `tarikh, ahli, jenis, jumlah, keterangan, kategori, rujukan`.
2. **Upload file.**
3. **Review & import.**

Parsing:
- Dates: `DD/MM/YYYY`, `D/M/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY`, or Excel dates.
- Amounts: `RM`, commas and spaces allowed.
- Type: `masuk/in` or `keluar/out`.
- Header synonyms in English and BM: date/tarikh, member/nama/ahli, type/jenis, amount/jumlah, description/keterangan/note, category/kategori, ref/rujukan.
- Unknown columns are ignored.
- If a `status` column exists, rows not `approved` are skipped.

Each row is marked:
- ✓ valid;
- ⚠ possible duplicate (same member + date + amount in the database or earlier in the file; for cash-out, same date + amount + description);
- ⚠ cash-out without receipt → marked legacy;
- ✕ member not found;
- ✕ bad date or amount.

The review shows the file name, row counts per mark, and a preview table.

Options:
- create unknown members automatically (start month = their first payment month);
- skip duplicates (on by default);
- opening balance before the first record (saved to settings).

The **Import N records** button inserts members first, then cash_in (`approved`, source `import`), then cash_out. It ends with a success banner, "Lihat dashboard <year>", and "Import fail lain".

**5. Google Sheet backup card:**
- status "Aktif";
- last full snapshot time;
- "real-time: every change";
- "12 weekly copies";
- buttons **Buka Google Sheet** and **Backup sekarang** (calls the edge `backup` action; shows "Sedang backup…" then "Siap ✓").

**6. Settings and automation:**
- monthly fee, fund name, opening balance;
- automation card: next reminder date, next yearly statement, receipt storage = Google Drive;
- button "Hantar peringatan sekarang".

## 10. Security

- RLS on every table.
- The public (`anon`) gets **column-limited** read:
  - members: id, name, start_month;
  - member_breaks: no reason;
  - cash_in: approved only, no ref or receipt link;
  - cash_out: all (receipts are public on purpose);
  - settings: only the public keys.
- `is_admin()` = JWT email equals `settings.admin_email`. The admin has full access.
- The bot and Apps Script use the service-role key, kept server-side only.
- Disable public sign-ups in Supabase Auth.
- The Telegram webhook checks `X-Telegram-Bot-Api-Secret-Token`. Cron checks `x-cron-secret`. Apps Script checks `SECRET`.
- Cash-in receipts are private Drive files. Cash-out receipts are anyone-with-link.
- Note in the README: the Gemini free tier may use inputs to improve Google products. Enable billing (paid tier, still cheap) if that is a concern.

## 11. Edge function environment variables

`TG_TOKEN`, `TG_SECRET`, `ADMIN_CHAT_ID`, `GROUP_CHAT_ID`, `DASHBOARD_URL`, `GEMINI_KEY`, `GEMINI_MODEL`, `DRIVE_URL` (Apps Script web app URL), `DRIVE_SECRET`, `CRON_SECRET`.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

## 12. Demo / sample data (also for testing)

- Members: Abah, Mak, Angah, Along, Achik, Adik. All start **Jul 2025**. RM100/month.
- **2025** (imported): everyone paid Jul–Dec.
  - Out: 22/08/2025 Kenduri kahwin Angah RM1,000 (kenduri); 18/12/2025 Bantuan banjir rumah Mak Long RM500 (kecemasan).
  - Closing 2025 = **RM2,100**.
- **2026** (today = 4 Nov 2026), paid months:
  - Abah, Mak, Angah: Jan–Nov;
  - Along: Jan–Oct;
  - Achik: Jan–Sep, then **stopped** (last month Sep 2026);
  - Adik: Jan–Aug.
  - In 2026 = RM6,000.
  - Out 2026:
    - 07/03 Kenduri arwah Tok Wan RM850
    - 15/03 Hamper Raya RM600
    - 09/06 Ubat Mak RM320
    - 14/08 Baiki bumbung rumah kampung RM1,200
    - 02/11 Hadiah konvo Adik RM150
    - Total RM3,120.
  - Current balance **RM4,980**. Outstanding **RM400** (Along RM100, Adik RM300). Active members paid up **3 / 5**.
- Pending:
  - Along RM100, 3 Nov, ref DN2611030045, read by AI;
  - Adik, 4 Nov, no ref, AI couldn't read amount.
- Adik has not linked Telegram yet.

## 13. Deliverables

```
tabungfamily/
  README.md                        # step-by-step setup in Malay (simple English terms ok)
  supabase/schema.sql              # tables, RLS, is_admin(), backup trigger
  supabase/cron.sql                # daily + yearly schedules
  supabase/functions/tabung/index.ts
  apps-script/Code.gs
  web/index.html
  web/import-template.csv
```

**README order:**
1. Telegram: BotFather token, your chat id, family group id; add the bot to the group.
2. Google Apps Script: script properties, time zone, run `setup`, deploy the web app.
3. Gemini API key.
4. Supabase: create the project in the Singapore region; run `schema.sql` after editing the admin email; set `backup_hook_url` / `backup_secret`; create the admin user; disable sign-ups.
5. Edge function: `supabase init / link / secrets set / functions deploy tabung --no-verify-jwt`.
6. Telegram `setWebhook` with `secret_token`.
7. Run `cron.sql`.
8. Web: fill CONFIG; push to GitHub; turn on Pages; put the URL in `DASHBOARD_URL`.
9. Add members, have everyone `/start`, link them.
10. Import old records.
11. Tests.

## 14. Acceptance checks

- The public page shows nothing private (no refs, no cash-in receipt links, no admin email or secrets) and cannot write anything.
- The BM/EN toggle changes all text. The year filter changes all numbers. Phone layout works at 360px wide with no sideways page scroll.
- Sending the same receipt twice, or a receipt with the same ref, is blocked.
- Caption `Mak, Abah` with RM200 creates two RM100 pending rows, one approval message, and notifies both members and the sender.
- Stopping a member removes future dues; outstanding after stop matches the dialog; reactivating restores dues from the current month only.
- Importing the template with sample rows produces the right counts. Duplicates are skipped. Unknown members are created only when ticked.
- Changing a record updates the Google Sheet row within seconds. "Backup sekarang" refreshes all tabs. The Sheet Dashboard year dropdown updates the grid.
- The reminder posts only on the last day of the month (or `/ingat`) and lists exactly the members with outstanding > 0.
