# TabungFamily — tabung keluarga yang telus

Web app untuk bendahari keluarga urus tabung bulanan (RM100 / ahli / bulan).

- **Semua orang** boleh lihat dashboard (baca sahaja).
- **Bendahari (admin) sahaja** boleh ubah data.
- Ahli bayar → hantar gambar resit ke **bot Telegram** → AI (Gemini) baca resit → simpan ke **Google Drive** → status *pending* → admin tekan **Sahkan** → dashboard dikemas kini.
- Semua guna **tier percuma**: GitHub Pages, Supabase, Telegram, Gemini, Google Apps Script.

```
tabungfamily/
  README.md                          ← fail ini
  supabase/schema.sql                ← jadual, RLS, is_admin(), trigger backup
  supabase/cron.sql                  ← jadual harian + tahunan
  supabase/functions/tabung/index.ts ← bot Telegram + tugas berjadual + aksi admin
  apps-script/Code.gs                ← Google Drive + Google Sheet backup
  web/index.html                     ← dashboard awam + admin (satu fail)
  web/import-template.csv            ← templat import rekod lama
```

> **Cuba dulu tanpa setup:** buka `web/index.html` terus dalam browser. Bila `SUPABASE_URL` kosong, app jalan dalam **mod demo** dengan data contoh. Pergi ke `#admin` dan log masuk dengan apa-apa emel/kata laluan.

Sediakan satu fail nota peribadi untuk simpan nilai-nilai di bawah (token, ID, secret). **Jangan** letak dalam GitHub.

---

## 1. Telegram

1. Dalam Telegram, cari **@BotFather** → `/newbot` → beri nama (cth *Tabung Kami*) dan username (cth `TabungKamiBot`).
   Simpan **token** → ini `TG_TOKEN`.
2. Cari chat id anda: hantar apa-apa mesej kepada **@userinfobot**. Nombor `Id` → ini `ADMIN_CHAT_ID`.
3. Group keluarga:
   - Tambah bot anda ke group keluarga (Add member → cari username bot).
   - Tambah juga **@RawDataBot** sekejap ke group; ia akan papar `chat.id` (nombor negatif, cth `-1001234567890`) → ini `GROUP_CHAT_ID`. Kemudian buang @RawDataBot.
4. Buat satu teks rawak panjang untuk `TG_SECRET` (cth jalankan `openssl rand -hex 24`, atau taip 40 huruf/nombor rawak). Hanya huruf, nombor, `_` dan `-`.

## 2. Google Apps Script (Drive + backup Sheet)

1. Pergi ke <https://script.google.com> → **New project** → namakan *TabungFamily*.
2. Padam kod contoh, tampal seluruh isi `apps-script/Code.gs`, simpan.
3. ⚙️ **Project Settings**:
   - **Time zone** = `(GMT+08:00) Kuala Lumpur`.
   - **Script properties** → tambah:
     | Property | Nilai |
     |---|---|
     | `SECRET` | teks rawak panjang (sama nilai untuk `DRIVE_SECRET` dan `backup_secret` nanti) |
     | `SUPABASE_URL` | `https://xxxx.supabase.co` (dapat di langkah 4 — boleh isi kemudian) |
     | `SERVICE_KEY` | Supabase **service_role** key (langkah 4) — rahsia! |
4. Selepas Supabase siap (langkah 4) dan `schema.sql` dijalankan: pilih fungsi **`setup`** → **Run** → benarkan semua permission.
   Ia akan cipta `My Drive/Tabung Family/TabungFamily Backup` (Google Sheet), tab-tab, Dashboard, trigger jam 3 pagi + onEdit, dan snapshot pertama.
   Resit disimpan dalam:
   - `My Drive/Tabung Family/Cash In/YYYY-MM-DD_Nama.jpg` (peribadi, tarikh bayar)
   - `My Drive/Tabung Family/Cash Out/YYYY-MM-DD_Kategori_Perkara.jpg` (sesiapa dengan link boleh lihat)
5. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Salin URL `https://script.google.com/macros/s/…/exec` → ini `DRIVE_URL`.
   > Bila tukar kod nanti: Deploy → Manage deployments → ✏️ → Version: *New version* (URL kekal sama).

## 3. Gemini API key

1. Pergi ke <https://aistudio.google.com/apikey> → **Create API key** → ini `GEMINI_KEY`.
2. `GEMINI_MODEL` = `gemini-2.5-flash` (atau model "flash" terkini yang ada tier percuma).

> ⚠️ **Privasi:** tier percuma Gemini mungkin guna input (gambar resit) untuk menambah baik produk Google. Jika ini membimbangkan, aktifkan billing (tier berbayar — masih sangat murah untuk beberapa resit sebulan); data tier berbayar tidak digunakan begitu.

## 4. Supabase

1. <https://supabase.com> → **New project** → Region **Southeast Asia (Singapore)**. Simpan kata laluan database.
2. **Settings → API**: salin `Project URL`, `anon public` key dan `service_role` key.
   - `anon` → untuk `web/index.html` (selamat untuk awam).
   - `service_role` → **rahsia**, hanya untuk Apps Script (`SERVICE_KEY`). Jangan letak dalam web.
3. Buka `supabase/schema.sql`, tukar `YOUR_EMAIL@gmail.com` kepada emel admin anda. **SQL Editor → New query** → tampal → **Run**.
4. Sambung backup real-time (SQL Editor):
   ```sql
   update settings set value = 'https://script.google.com/macros/s/XXXX/exec' where key = 'backup_hook_url';
   update settings set value = 'SECRET_YANG_SAMA_DENGAN_APPS_SCRIPT'          where key = 'backup_secret';
   ```
5. **Authentication → Users → Add user → Create new user**: emel admin (sama seperti di atas) + kata laluan. Tanda *Auto Confirm User*.
6. **Authentication → Sign In / Providers** (atau *Settings*): **matikan "Allow new users to sign up"**. Hanya akaun admin wujud.
7. Kembali ke langkah 2.4 (Apps Script) dan jalankan `setup`.

## 5. Edge function (bot + jadual + aksi admin)

Perlu [Supabase CLI](https://supabase.com/docs/guides/cli) (Mac: `brew install supabase/tap/supabase`). Dalam folder `tabungfamily/`:

```bash
supabase login
```

```bash
supabase init
```

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

```bash
supabase secrets set TG_TOKEN=123:abc TG_SECRET=rawak_panjang ADMIN_CHAT_ID=123456789 GROUP_CHAT_ID=-1001234567890 DASHBOARD_URL=https://username.github.io/tabungfamily/ GEMINI_KEY=AIza... GEMINI_MODEL=gemini-2.5-flash DRIVE_URL=https://script.google.com/macros/s/XXXX/exec DRIVE_SECRET=SECRET_APPS_SCRIPT CRON_SECRET=rawak_lain
```

```bash
supabase functions deploy tabung --no-verify-jwt
```

`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` disediakan automatik oleh Supabase.
`YOUR_PROJECT_REF` = bahagian `xxxx` dalam `https://xxxx.supabase.co`.

## 6. Sambung Telegram ke function (webhook)

Buka URL ini dalam browser (ganti nilai):

```
https://api.telegram.org/botTG_TOKEN/setWebhook?url=https://YOUR_PROJECT_REF.supabase.co/functions/v1/tabung&secret_token=TG_SECRET&allowed_updates=["message","callback_query"]
```

Patut keluar `{"ok":true,...}`. Semak: `https://api.telegram.org/botTG_TOKEN/getWebhookInfo`.

## 7. Jadual automatik

Buka `supabase/cron.sql`, ganti `YOUR_PROJECT_REF` dan `YOUR_CRON_SECRET` (sama dengan `CRON_SECRET`), kemudian jalankan dalam SQL Editor.

| Bila (waktu Malaysia) | Apa |
|---|---|
| Setiap hari 8:00pm | Kekalkan projek percuma aktif. Jika esok 1hb → hantar peringatan bulanan ke group + DM ahli + DM admin (dengan pautan *Kongsi ke WhatsApp*). |
| 1 Januari 9:00am | Penyata tahunan PDF ke setiap ahli (tahun lepas). |
| Setiap malam 3:00am | Snapshot penuh ke Google Sheet (trigger Apps Script). |
| Mingguan | Salinan Sheet ke `Tabung Family/Backup mingguan/`, simpan 12 terkini. |

## 8. Web (GitHub Pages)

1. Buka `web/index.html`, isi bahagian `CONFIG` di atas:
   ```js
   SUPABASE_URL: 'https://xxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...anon...',
   BOT_USERNAME: 'TabungKamiBot',
   ```
2. Buat repo GitHub baru (cth `tabungfamily`), upload **semua** isi folder `web/` (`index.html`, `import-template.csv`, `logo-mark.png`, `logo.jpg`) ke root repo.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)` → Save.
4. URL akan jadi `https://username.github.io/tabungfamily/`. Letak URL ini sebagai `DASHBOARD_URL`:
   ```bash
   supabase secrets set DASHBOARD_URL=https://username.github.io/tabungfamily/
   ```
5. Admin: buka `https://username.github.io/tabungfamily/#admin` → log masuk.

## 9. Ahli & Telegram

1. Admin → **Ahli & Telegram** → **+ Tambah ahli** (nama, bulan mula).
2. Minta setiap ahli buka bot dan tekan **Start** (`/start`).
3. Anda (admin) dapat DM: *"X nak sambung ke bot. Siapa ni?"* → tekan nama yang betul. Ahli terima mesej selamat datang.

Cara bayar untuk ahli: hantar gambar/PDF resit ke bot. Tak perlu tulis apa-apa.
Bayar untuk orang lain: tulis nama dalam caption (`Mak`, atau `Mak, Abah` — jumlah dibahagi sama rata).

Arahan admin di Telegram:

| Arahan | Fungsi |
|---|---|
| 📸 + caption `/out 150 lain Hadiah konvo Adik` | Rekod duit keluar (jumlah, kategori, keterangan). Resit wajib, dikongsi umum. Kategori: `kereta, rumah, melancong, kampung, kenduri, perubatan, raya, kecemasan, lain`. |
| `/pending` | Senarai resit menunggu |
| `/ingat` | Hantar peringatan sekarang |
| `/penyata 2026` | Preview penyata tahunan (dihantar ke admin sahaja) |

Ahli: `/status` (tunggakan sendiri), `/baki` (baki tabung + pautan dashboard).

## 10. Import rekod lama

**Rekod sebenar dari Google Sheet lama sudah disediakan** dalam folder `data/` (jangan upload folder ini ke GitHub — ada nota peribadi):
- `data/seed.sql` — jalankan **sekali** dalam SQL Editor selepas `schema.sql`. Masukkan 5 ahli, Adib berhenti selepas Dis 2022, 249 duit masuk, 29 duit keluar. Kemudian tekan **Backup sekarang** di admin.
- `data/SEMAKAN.md` — ringkasan baki, tunggakan setiap ahli, dan perkara yang perlu anda semak.
- `data/rekod-sebenar.csv` — sama, untuk skrin Import (atau cuba dulu: `index.html?demo=kosong#admin`).

Untuk fail lain, guna skrin Import:

Admin → **Import rekod lama**:
1. Muat turun templat (atau guna `web/import-template.csv`).
   Lajur: `tarikh, ahli, jenis, jumlah, keterangan, kategori, rujukan, untuk_bulan`.
   - `untuk_bulan` (pilihan, cth `2024-03`): bulan yuran yang dibayar. Kosong = isi bulan tertunggak paling lama dulu.
   - Duit masuk dengan kategori `sumbangan` = duit tambahan, bukan yuran. Ahli `Lain-lain` = duit bukan dari ahli.
   - Tarikh: `DD/MM/YYYY`, `D/M/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY` atau tarikh Excel.
   - Jumlah: boleh ada `RM`, koma, ruang.
   - Jenis: `masuk`/`in` atau `keluar`/`out`.
   - Nama lajur BM atau English diterima; lajur lain diabaikan. Jika ada lajur `status`, hanya `approved` diimport.
2. Muat naik fail `.xlsx` / `.csv`.
3. Semak tanda setiap baris (✓ sah, ⚠ pendua, ⚠ keluar tanpa resit → rekod lama, ✕ ahli tiada, ✕ tarikh/jumlah salah), pilih pilihan, tekan **Import N rekod**.

**Restore dari backup:** tab `duit_masuk` / `duit_keluar` dalam Google Sheet guna nama lajur yang sama — *File → Download → CSV* dan import semula.

## 11. Ujian (sebelum umum ke keluarga)

- [ ] Buka dashboard dalam tetingkap *incognito*: tiada no. rujukan, tiada pautan resit duit masuk, tiada emel admin. Tukar BM/EN — semua teks bertukar. Tukar tahun — semua nombor bertukar.
- [ ] Telefon (lebar 360px): tiada skrol ke tepi untuk halaman; jadual skrol dalam kad sendiri; menu bawah berfungsi.
- [ ] Hantar resit ke bot → admin dapat mesej dengan butang ✅/❌ → Sahkan → ahli dapat DM, group dapat "✅ X bayar RMy", dashboard dikemas kini.
- [ ] Hantar resit **sama** sekali lagi → ditolak. Resit lain dengan **no. rujukan sama** → ditolak automatik + admin dimaklumkan.
- [ ] Caption `Mak, Abah` dengan resit RM200 → dua baris RM100 pending, satu mesej kelulusan, kedua-dua ahli + penghantar dimaklumkan.
- [ ] Admin: hentikan sumbangan ahli → tunggakan selepas berhenti = seperti dalam dialog. Aktifkan semula → yuran dikira dari bulan ini sahaja.
- [ ] Import `import-template.csv` → bilangan baris betul, pendua dilangkau, ahli baru dicipta hanya jika ditanda.
- [ ] Ubah satu rekod → baris dalam Google Sheet berubah dalam beberapa saat. **Backup sekarang** → semua tab dikemas kini. Tukar tahun (B3) dalam Dashboard Sheet → grid ahli berubah.
- [ ] `/ingat` → group dapat senarai ahli yang tertunggak sahaja (tunggakan > RM0).
- [ ] `/penyata 2026` → PDF sampai ke admin.

## Keselamatan (ringkas)

- Row Level Security pada setiap jadual. Awam hanya boleh **baca** lajur tertentu:
  ahli (id, nama, bulan mula), rehat (tanpa sebab), duit masuk (*approved* sahaja, tanpa rujukan/resit), duit keluar (semua — resit sengaja umum), tetapan (`fund_name`, `monthly_due`, `opening_balance`, `last_backup_at` sahaja).
- `is_admin()` = emel JWT sama dengan `settings.admin_email`. Daftar akaun baru dimatikan.
- Bot & Apps Script guna `service_role` key di server sahaja.
- Webhook Telegram semak `X-Telegram-Bot-Api-Secret-Token`; cron semak `x-cron-secret`; Apps Script semak `SECRET`.
- Resit duit masuk = fail Drive **peribadi**. Resit duit keluar = *anyone with the link*.

## Masalah biasa

| Masalah | Semak |
|---|---|
| Bot tak balas | `getWebhookInfo` (ada `last_error_message`?). Supabase → Edge Functions → tabung → Logs. |
| "Google: unauthorized" | `DRIVE_SECRET` mesti sama dengan `SECRET` dalam Apps Script. |
| Sheet tak berubah | `backup_hook_url` / `backup_secret` dalam `settings`; Apps Script → Executions. |
| Admin "not admin" | Emel login mesti sama dengan `admin_email` dalam `settings`. |
| Peringatan tak keluar | `select * from cron.job_run_details order by start_time desc limit 10;` |
