// =====================================================================
// TabungFamily — Telegram bot + scheduled jobs + admin actions
// Supabase Edge Function "tabung" (deploy with --no-verify-jwt)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const TOKEN = env("TG_TOKEN");
const TG = `https://api.telegram.org/bot${TOKEN}`;
const ADMIN = Number(env("ADMIN_CHAT_ID"));
const GROUP = env("GROUP_CHAT_ID");
const DASH = env("DASHBOARD_URL");
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const BULAN = ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ogo", "Sep", "Okt", "Nov", "Dis"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------- helpers
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const rm = (n: number) => "RM" + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const myt = () => new Date(Date.now() + 8 * 3600e3); // Malaysia time, read with getUTC*
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const mIdx = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1; // "YYYY-MM.." -> month index
const idxDate = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
const idxLabel = (i: number) => `${BULAN[i % 12]} ${Math.floor(i / 12)}`;
const nowIdx = () => { const d = myt(); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

async function tg(method: string, body: Any) {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(method, JSON.stringify(j));
  return j;
}
const send = (chat_id: number | string, text: string, extra: Any = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
const btn = (text: string, data: string) => ({ text, callback_data: data });

// ---------------------------------------------------------------- data
async function setting(key: string, d = "") {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? d;
}
const monthlyDue = async () => Number(await setting("monthly_due", "100")) || 100;

/** Months a member owes, ascending, up to and including month index `upto`. */
function dueMonths(m: Any, breaks: Any[], upto: number) {
  const s = mIdx(m.start_month);
  const br = breaks.filter((b) => b.member_id === m.id).map((b) => [mIdx(b.from_month), b.to_month ? mIdx(b.to_month) : Infinity]);
  const out: number[] = [];
  for (let i = s; i <= upto; i++) if (!br.some(([a, z]) => i >= a && i <= z)) out.push(i);
  return out;
}
const isStopped = (m: Any, breaks: Any[]) => breaks.some((b) => b.member_id === m.id && !b.to_month && mIdx(b.from_month) <= nowIdx());

/** Every member with how much they owe right now. */
async function standing() {
  const due = await monthlyDue();
  const [{ data: mem }, { data: br }, { data: pay }] = await Promise.all([
    db.from("members").select("id,name,start_month,tg_chat_id").order("id"),
    db.from("member_breaks").select("member_id,from_month,to_month"),
    db.from("cash_in").select("member_id,amount").eq("status", "approved").eq("kind", "yuran"), // sumbangan does not pay dues
  ]);
  const breaks = br ?? [];
  const now = nowIdx();
  const rows = (mem ?? []).map((m: Any) => {
    const paid = (pay ?? []).filter((p: Any) => p.member_id === m.id).reduce((s: number, p: Any) => s + Number(p.amount), 0);
    const owedMonths = dueMonths(m, breaks, now);
    const expected = owedMonths.length * due;
    const owe = Math.max(0, expected - paid);
    return { ...m, paid, expected, owe, months: Math.ceil(owe / due - 1e-9), stopped: isStopped(m, breaks) };
  });
  return { due, rows };
}

async function fund(to?: string, from?: string) {
  let qi = db.from("cash_in").select("amount").eq("status", "approved");
  let qo = db.from("cash_out").select("amount");
  if (from) { qi = qi.gte("paid_on", from); qo = qo.gte("spent_on", from); }
  if (to) { qi = qi.lte("paid_on", to); qo = qo.lte("spent_on", to); }
  const [i, o, ob] = await Promise.all([qi, qo, setting("opening_balance", "0")]);
  const sum = (r: Any[] | null) => (r ?? []).reduce((s, x) => s + Number(x.amount), 0);
  const tin = sum(i.data), tout = sum(o.data);
  return { tin, tout, bal: (from ? 0 : Number(ob) || 0) + tin - tout };
}

// ---------------------------------------------------------------- receipts
async function tgFile(file_id: string) {
  const j = await tg("getFile", { file_id });
  const path: string = j.result.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), ext: (path.split(".").pop() || "jpg").toLowerCase() };
}

const PROMPT = `You read Malaysian payment receipts (bank transfer, DuitNow, e-wallet screenshots) and shop receipts.
Return JSON only:
{"is_receipt": boolean, "amount": number|null, "date": "YYYY-MM-DD"|null, "ref": string|null, "payee": string|null}
amount = total paid in RM. ref = transaction / reference number exactly as printed. payee = recipient name.
Use null when unsure. Never guess.`;

async function readReceipt(bytes: Uint8Array, mime: string): Promise<Any> {
  if (!env("GEMINI_KEY")) return {};
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env("GEMINI_MODEL", "gemini-2.5-flash")}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env("GEMINI_KEY") },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: encodeBase64(bytes) } }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    const j = await r.json();
    if (j.error) console.error("gemini", JSON.stringify(j.error));
    return JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
  } catch (e) {
    console.error("gemini", e);
    return {};
  }
}

async function appsScript(payload: Any) {
  const url = env("DRIVE_URL") || (await setting("backup_hook_url"));
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ secret: env("DRIVE_SECRET"), ...payload }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Google: " + j.error);
  return j;
}
const toDrive = async (bytes: Uint8Array, mime: string, name: string, folder: string, isPublic: boolean) =>
  (await appsScript({ action: "upload", name, mime, folder, public: isPublic, data: encodeBase64(bytes) })).url as string;

function pickFile(msg: Any) {
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { id: p.file_id, uid: p.file_unique_id, mime: "image/jpeg" };
  }
  const d = msg.document;
  if (d && /^(image\/|application\/pdf)/.test(d.mime_type ?? "")) return { id: d.file_id, uid: d.file_unique_id, mime: d.mime_type };
  return null;
}

/** Caption "Mak" or "Humairah, Mak" -> members. Returns {found, unknown}. */
async function membersFromCaption(caption: string) {
  const parts = caption.split(/,|&|\+|\bdan\b|\band\b/i).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { found: [] as Any[], unknown: [] as string[] };
  const { data: all } = await db.from("members").select("id,name,start_month,tg_chat_id");
  const found: Any[] = [], unknown: string[] = [];
  for (const p of parts) {
    const m = (all ?? []).find((x: Any) => x.name.toLowerCase() === p.toLowerCase());
    if (m) { if (!found.some((f) => f.id === m.id)) found.push(m); } else unknown.push(p);
  }
  return { found, unknown };
}

// ---------------------------------------------------------------- bot: messages
async function onMessage(msg: Any) {
  if (msg.chat?.type !== "private") return; // bot only talks in private chats
  const chat: number = msg.chat.id;
  const isAdmin = chat === ADMIN;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");
  const file = pickFile(msg);
  const { data: me } = await db.from("members").select("*").eq("tg_chat_id", chat).maybeSingle();

  if (isAdmin && /^\/?out$/.test(cmd)) return cashOut(text, file);
  if (cmd === "/start") return start(msg, me);
  if (cmd === "/status") return status(chat, me);
  if (cmd === "/baki") {
    const f = await fund();
    return send(chat, `💰 Baki tabung: <b>${rm(f.bal)}</b>${DASH ? `\n${DASH}` : ""}`);
  }
  if (isAdmin && cmd === "/pending") return listPending();
  if (isAdmin && cmd === "/ingat") return reminder(true);
  if (isAdmin && cmd === "/penyata") return statements(Number(text.split(/\s+/)[1]) || myt().getUTCFullYear(), chat);
  if (file) {
    if (!me) return send(chat, "Akaun belum disambung. Tekan /start dulu.");
    return cashIn(chat, me, file, msg.caption ?? "");
  }
  return help(chat, isAdmin);
}

function help(chat: number, isAdmin: boolean) {
  let t = `<b>TabungFamily</b>\n\n📸 Hantar gambar / PDF resit bayaran ke sini. Tak perlu tulis apa-apa.\n` +
    `Bayar untuk orang lain? Tulis nama dia dalam caption (cth: <code>Mak</code> atau <code>Mak, Abah</code>).\n\n` +
    `/status — tunggakan saya\n/baki — baki tabung`;
  if (isAdmin) {
    t += `\n\n<b>Admin</b>\n📸 + caption <code>/out 50 kenduri Majlis Pak Long</code> — rekod duit keluar\n` +
      `Kategori: ${CATS.join(", ")}\n` +
      `/pending — resit menunggu\n/ingat — hantar peringatan sekarang\n/penyata 2026 — preview penyata tahunan`;
  }
  return send(chat, t);
}

async function start(msg: Any, me: Any) {
  const chat = msg.chat.id;
  if (me) return send(chat, `Hai <b>${esc(me.name)}</b> 👋 akaun anda dah disambung.\n\nHantar gambar resit ke sini selepas bayar. /status untuk semak tunggakan.`);
  const { data: free } = await db.from("members").select("id,name").is("tg_chat_id", null).order("name");
  const who = esc([msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || chat);
  if (!free?.length) {
    await send(ADMIN, `⚠️ ${who} tekan /start tapi semua ahli dah disambung. Tambah ahli di dashboard dulu.`);
    return send(chat, "Permintaan dihantar ke bendahari. ⏳");
  }
  const rows = free.map((m: Any) => [btn(m.name, `link:${m.id}:${chat}`)]);
  rows.push([btn("❌ Abaikan", `ignore:0:${chat}`)]);
  await send(ADMIN, `🔗 <b>${who}</b> nak sambung ke bot. Siapa ni?`, { reply_markup: { inline_keyboard: rows } });
  return send(chat, "Terima kasih! Tunggu bendahari sahkan akaun anda. ⏳");
}

async function status(chat: number, me: Any) {
  if (!me) return send(chat, "Akaun belum disambung. Tekan /start.");
  const { rows, due } = await standing();
  const r = rows.find((x: Any) => x.id === me.id);
  if (!r) return send(chat, "Rekod tak dijumpai.");
  if (r.stopped && r.owe === 0) return send(chat, `Hai ${esc(me.name)}, sumbangan anda dihentikan. Tiada tunggakan. Terima kasih atas sumbangan ${rm(r.paid)}!`);
  if (r.owe > 0) return send(chat, `Hai ${esc(me.name)}, tunggakan: <b>${rm(r.owe)}</b> (${r.months} bulan × ${rm(due)}).\nJumlah dah bayar: ${rm(r.paid)}`);
  const extra = r.paid > r.expected ? `\nBayar awal: ${rm(r.paid - r.expected)}` : "";
  return send(chat, `Hai ${esc(me.name)} ✅ tiada tunggakan. Terima kasih!\nJumlah sumbangan: ${rm(r.paid)}${extra}`);
}

async function cashIn(chat: number, me: Any, file: Any, caption: string) {
  const { data: seen } = await db.from("cash_in").select("id,status").eq("tg_file_uid", file.uid).neq("status", "rejected").limit(1);
  if (seen?.length) return send(chat, `Resit ini dah diterima sebelum ni (#${seen[0].id}, ${seen[0].status}).`);
  await send(chat, "⏳ Membaca resit…");

  const { bytes, ext } = await tgFile(file.id);
  const r = await readReceipt(bytes, file.mime);
  if (r.is_receipt === false) return send(chat, "❓ Ini tak nampak macam resit bayaran. Cuba hantar gambar yang lebih jelas.");

  const ref = r.ref ? String(r.ref).trim() : null;
  if (ref) {
    const { data: dup } = await db.from("cash_in").select("id").eq("ref", ref).neq("status", "rejected").limit(1);
    if (dup?.length) {
      await send(ADMIN, `⚠️ Resit pendua dari ${esc(me.name)} (ref ${esc(ref)}, sama dengan #${dup[0].id}). Ditolak automatik.`);
      return send(chat, `⚠️ No. rujukan ${esc(ref)} dah pernah direkod. Ditolak.`);
    }
  }

  // Who is this payment for?
  const { found, unknown } = await membersFromCaption(caption);
  const targets = found.length ? found : [me];
  const due = await monthlyDue();
  const total = Number(r.amount) > 0 ? Number(r.amount) : null;
  const paid_on = /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") ? r.date : ymd(myt());
  const url = await toDrive(bytes, file.mime, `IN_${targets.map((t) => t.name).join("+")}_${paid_on}_${ref ?? file.uid}.${ext}`, paid_on.slice(0, 7), false);

  const batch_id = crypto.randomUUID();
  const each = total ? Math.round((total / targets.length) * 100) / 100 : due;
  const notes: string[] = [];
  if (!total) notes.push("AI tak dapat baca jumlah — semak");
  if (unknown.length) notes.push(`Nama tak dikenali dalam caption: ${unknown.join(", ")}`);
  const rows = targets.map((t, i) => ({
    member_id: t.id, paid_on,
    // last share takes the rounding remainder so the split adds up exactly
    amount: total && i === targets.length - 1 ? Math.round((total - each * (targets.length - 1)) * 100) / 100 : each,
    method: "transfer", ref, receipt_url: url, tg_file_uid: file.uid, batch_id, sent_by: me.id, source: "bot",
    status: "pending", note: notes.join(" · ") || null, payee: r.payee ? String(r.payee).slice(0, 120) : null,
  }));
  const { error } = await db.from("cash_in").insert(rows);
  if (error) throw error;

  const forWho = targets.map((t) => t.name).join(", ");
  const other = targets.length > 1 || targets[0].id !== me.id;
  await send(chat, `✅ Resit diterima: <b>${total ? rm(total) : "jumlah belum dibaca"}</b>` +
    (other ? ` untuk <b>${esc(forWho)}</b>` : "") + ` (${paid_on}).\nMenunggu pengesahan bendahari.`);
  if (unknown.length && !found.length) {
    const { data: all } = await db.from("members").select("id,name").order("name");
    const kb = (all ?? []).map((m: Any) => [btn(m.name, `for:${batch_id}:${m.id}`)]);
    await send(chat, `Saya tak kenal nama <b>${esc(unknown.join(", "))}</b>. Bayaran ini untuk siapa?`, { reply_markup: { inline_keyboard: kb } });
  }
  return notifyBatch(batch_id);
}

async function notifyBatch(batch_id: string) {
  const { data: rows } = await db.from("cash_in").select("*, member:members!cash_in_member_id_fkey(name), sender:members!cash_in_sent_by_fkey(name)")
    .eq("batch_id", batch_id).order("id");
  if (!rows?.length) return;
  const r0 = rows[0];
  const total = rows.reduce((s: number, r: Any) => s + Number(r.amount), 0);
  const lines = rows.map((r: Any) => `• ${esc(r.member?.name)}: ${rm(r.amount)}`).join("\n");
  const sender = r0.sender?.name && rows.some((r: Any) => r.member_id !== r0.sent_by) ? `\nDihantar oleh: ${esc(r0.sender.name)}` : "";
  return send(ADMIN,
    `🧾 <b>Resit baru #${r0.id}</b>\n${lines}\nJumlah: <b>${rm(total)}</b>${sender}\nTarikh: ${r0.paid_on}\nRef: ${esc(r0.ref ?? "-")}\nPenerima: ${esc(r0.payee ?? "-")}` +
    (r0.note ? `\n⚠️ ${esc(r0.note)}` : "") + (r0.receipt_url ? `\n<a href="${esc(r0.receipt_url)}">📎 Lihat resit</a>` : "") +
    `\n\nJumlah salah? Betulkan di dashboard admin sebelum sahkan.`,
    { reply_markup: { inline_keyboard: [[btn("✅ Sahkan", `ok:${batch_id}`), btn("❌ Tolak", `no:${batch_id}`)]] } });
}

async function listPending() {
  const { data } = await db.from("cash_in").select("batch_id").eq("status", "pending").order("id");
  const batches = [...new Set((data ?? []).map((r: Any) => r.batch_id))];
  if (!batches.length) return send(ADMIN, "Tiada resit menunggu. 👍");
  for (const b of batches) await notifyBatch(b as string);
}

/** Approve or reject a whole receipt. Used by the bot buttons and the web admin. */
async function decideBatch(batch_id: string, approve: boolean, amounts?: Record<string, number>) {
  if (approve && amounts) {
    for (const [id, amount] of Object.entries(amounts)) {
      if (Number(amount) > 0) await db.from("cash_in").update({ amount: Number(amount) }).eq("id", Number(id)).eq("status", "pending");
    }
  }
  const status = approve ? "approved" : "rejected";
  const { data: rows } = await db.from("cash_in").update({ status }).eq("batch_id", batch_id).eq("status", "pending")
    .select("*, member:members!cash_in_member_id_fkey(name,tg_chat_id), sender:members!cash_in_sent_by_fkey(name,tg_chat_id)");
  if (!rows?.length) return 0;
  const total = rows.reduce((s: number, r: Any) => s + Number(r.amount), 0);
  const names = rows.map((r: Any) => r.member?.name).join(", ");
  const told = new Set<number>();
  for (const r of rows) {
    for (const who of [r.member, r.sender]) {
      if (!who?.tg_chat_id || told.has(who.tg_chat_id)) continue;
      told.add(who.tg_chat_id);
      await send(who.tg_chat_id, approve
        ? `✅ Bayaran ${rm(total)} (${esc(names)}) disahkan. Terima kasih!`
        : `❌ Resit ${rm(total)} (${rows[0].paid_on}) ditolak bendahari. Sila hubungi bendahari.`);
    }
  }
  if (approve && GROUP) await send(GROUP, `✅ ${esc(names)} bayar ${rm(total)}. Terima kasih!`);
  return rows.length;
}

// Spending categories (same slugs as the web app). Unknown words become "lain".
const CATS = ["kereta", "rumah", "melancong", "kampung", "kenduri", "perubatan", "raya", "kecemasan", "lain"];
const CAT_SYN: Record<string, string> = { car: "kereta", kenderaan: "kereta", house: "rumah", travel: "melancong", percutian: "melancong",
  balik: "kampung", kg: "kampung", majlis: "kenduri", ubat: "perubatan", hospital: "perubatan", medical: "perubatan",
  emergency: "kecemasan", bantuan: "kecemasan", "lain-lain": "lain", other: "lain" };
const catSlug = (w: string) => { const v = w.toLowerCase(); return CATS.includes(v) ? v : CAT_SYN[v] ?? "lain"; };

async function cashOut(text: string, file: Any) {
  const m = text.match(/^\/?out\s+(?:rm\s*)?([\d.,]+)\s+(\S+)\s*(.*)$/i);
  if (!m) return send(ADMIN, `Format: hantar gambar resit + caption\n<code>/out 50 kenduri Majlis Pak Long</code>\nKategori: ${CATS.join(", ")}`);
  if (!file) return send(ADMIN, "❗ Resit wajib. Hantar gambar resit dengan caption tu.");
  const amount = Number(m[1].replace(/,/g, ""));
  if (!(amount > 0)) return send(ADMIN, "Jumlah tak sah.");
  const { data: seen } = await db.from("cash_out").select("id").eq("tg_file_uid", file.uid).limit(1);
  if (seen?.length) return send(ADMIN, `Resit ini dah direkod (#${seen[0].id}).`);
  const category = catSlug(m[2]);
  const description = m[3].trim() || category;
  const day = ymd(myt());
  const { bytes, ext } = await tgFile(file.id);
  const url = await toDrive(bytes, file.mime, `OUT_${day}_${category}_${amount}.${ext}`, day.slice(0, 7), true);
  const { data: row, error } = await db.from("cash_out")
    .insert({ spent_on: day, description, category, amount, receipt_url: url, tg_file_uid: file.uid, source: "bot" }).select().single();
  if (error) throw error;
  const f = await fund();
  const t = `💸 <b>Duit keluar</b> ${rm(amount)} — ${esc(description)} (${esc(category)})\n<a href="${esc(url)}">📎 Resit</a>\nBaki tabung: <b>${rm(f.bal)}</b>`;
  await send(ADMIN, `✅ Direkod #${row.id}\n${t}`);
  if (GROUP) await send(GROUP, t);
}

// ---------------------------------------------------------------- bot: buttons
async function onCallback(cq: Any) {
  const done = (text = "") => tg("answerCallbackQuery", { callback_query_id: cq.id, text });
  const [act, a, b] = String(cq.data).split(":");
  const msgRef = { chat_id: cq.message.chat.id, message_id: cq.message.message_id };
  const mark = (label: string) => tg("editMessageReplyMarkup", { ...msgRef, reply_markup: { inline_keyboard: [[btn(label, "x:0")]] } });

  // A member choosing who their payment is for (allowed for the sender, not only admin)
  if (act === "for") {
    const { data: me } = await db.from("members").select("id").eq("tg_chat_id", cq.from.id).maybeSingle();
    const { data: rows } = await db.from("cash_in").select("id,sent_by,status,note").eq("batch_id", a);
    if (!rows?.length || !me || rows[0].sent_by !== me.id || rows.some((r: Any) => r.status !== "pending")) return done("Tak boleh ubah");
    const { data: target } = await db.from("members").select("name").eq("id", Number(b)).single();
    // keep the AI note, drop only the "unknown name" note
    for (const r of rows) {
      const note = String(r.note ?? "").split(" · ").filter((x) => x && !x.startsWith("Nama tak dikenali")).join(" · ") || null;
      await db.from("cash_in").update({ member_id: Number(b), note }).eq("id", r.id).eq("status", "pending");
    }
    await mark(`➡️ ${target?.name}`);
    await send(ADMIN, `ℹ️ Resit dikemaskini: bayaran untuk <b>${esc(target?.name)}</b>.`);
    await notifyBatch(a);
    return done("Dikemaskini");
  }

  if (cq.from?.id !== ADMIN) return done("Admin sahaja");

  if (act === "ok" || act === "no") {
    const n = await decideBatch(a, act === "ok");
    await mark(n ? (act === "ok" ? "✅ Disahkan" : "❌ Ditolak") : "Sudah diproses");
    return done(n ? (act === "ok" ? "Disahkan" : "Ditolak") : "Sudah diproses");
  }
  if (act === "link") {
    const { data: m, error } = await db.from("members").update({ tg_chat_id: Number(b) }).eq("id", Number(a)).is("tg_chat_id", null).select().maybeSingle();
    if (error || !m) { await mark("Gagal / sudah disambung"); return done(); }
    await mark(`🔗 ${m.name}`);
    await send(Number(b), `✅ Akaun disambung sebagai <b>${esc(m.name)}</b>.\n\n📸 Hantar gambar resit ke sini selepas bayar. Tak perlu tulis apa-apa.\n/status — tunggakan\n/baki — baki tabung`);
    return done("Disambung");
  }
  if (act === "ignore") { await mark("Diabaikan"); return done(); }
  return done();
}

// ---------------------------------------------------------------- scheduled: reminder
async function reminder(force = false) {
  const now = myt();
  const tomorrow = new Date(now.getTime() + 864e5);
  if (!force && tomorrow.getUTCDate() !== 1) return { skipped: true };
  const { rows, due } = await standing();
  const owing = rows.filter((r: Any) => r.owe > 0);
  const counted = rows.filter((r: Any) => !r.stopped || r.owe > 0);
  const f = await fund();
  const total = owing.reduce((s: number, r: Any) => s + r.owe, 0);
  const head = `📢 TabungFamily — ${BULAN[now.getUTCMonth()]} ${now.getUTCFullYear()}\nYuran ${rm(due)}/bulan\n\n`;
  const body = owing.length
    ? `Belum lunas (${owing.length}/${counted.length} orang):\n` +
      owing.map((r: Any, i: number) => `${i + 1}. ${r.name} — ${r.months} bulan (${rm(r.owe)})`).join("\n") +
      `\n\nJumlah tertunggak: ${rm(total)}`
    : "✅ Semua dah bayar. Terima kasih semua!";
  const plain = head + body + `\n\n💰 Baki tabung: ${rm(f.bal)}` + (DASH ? `\n📊 ${DASH}` : "") + "\n\nBayar & hantar resit ke bot Telegram. 🙏";
  if (GROUP) await tg("sendMessage", { chat_id: GROUP, text: plain, link_preview_options: { is_disabled: true } });
  await send(ADMIN, `📋 Peringatan dihantar.\n\n<a href="https://wa.me/?text=${encodeURIComponent(plain)}">📲 Kongsi ke WhatsApp</a>`);
  for (const r of owing) {
    if (r.tg_chat_id) await send(r.tg_chat_id, `🔔 Peringatan mesra: tunggakan anda <b>${rm(r.owe)}</b> (${r.months} bulan). Hantar resit ke sini selepas bayar. Terima kasih! 🙏`);
  }
  return { sent: true, owing: owing.length };
}

// ---------------------------------------------------------------- scheduled: yearly statement
async function statementPdf(m: Any, breaks: Any[], year: number, due: number) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const { data: pays } = await db.from("cash_in").select("paid_on,amount,ref,method,kind,for_month").eq("member_id", m.id).eq("status", "approved").order("paid_on");
  const all = pays ?? [];
  const fees = all.filter((p: Any) => p.kind !== "sumbangan"); // only monthly fees count against dues
  const inYear = all.filter((p: Any) => p.paid_on >= from && p.paid_on <= to);
  const sum = (a: Any[]) => a.reduce((s, p) => s + Number(p.amount), 0);
  const paidYear = sum(inYear.filter((p: Any) => p.kind !== "sumbangan"));
  const paidToDate = sum(fees.filter((p: Any) => p.paid_on <= to));
  const endIdx = Math.min(year * 12 + 11, nowIdx());
  const dueAll = dueMonths(m, breaks, endIdx);
  const monthsYear = dueAll.filter((i) => Math.floor(i / 12) === year).length;
  const owe = dueAll.length * due - paidToDate; // negative = paid in advance
  const fy = await fund(to, from);
  const fAll = await fund(to);

  const pdf = await PDFDocument.create();
  let page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.16, 0.36), blue = rgb(0.25, 0.36, 0.71), grey = rgb(0.35, 0.4, 0.6);
  let y = 790;
  const safe = (s: string) => s.replace(/[^\x20-\x7E]/g, "?");
  const line = (t: string, x = 50, size = 11, f = font, color = ink) => page.drawText(safe(t), { x, y, size, font: f, color });
  const next = (dy = 18) => { y -= dy; if (y < 60) { page = pdf.addPage([595, 842]); y = 790; } };
  const kv = (k: string, v: string, b = false) => { line(k, 50, 11, b ? bold : font); line(v, 430, 11, b ? bold : font); next(); };

  line("TabungFamily", 50, 24, bold, blue); next(28);
  line(`Penyata Tahunan / Annual Statement ${year}`, 50, 13, bold); next(30);
  line(`Ahli / Member: ${m.name}`); next();
  line(`Yuran / Monthly fee: ${rm(due)}`); next();
  line(`Mula / Since: ${m.start_month.slice(0, 7)}`); next(30);
  line("Tarikh / Date", 50, 10, bold, grey); line("Perkara / Item", 170, 10, bold, grey); line("Jumlah / Amount", 430, 10, bold, grey); next(16);
  if (!inYear.length) { line("Tiada bayaran / No payments", 50, 10); next(); }
  for (const p of inYear) {
    const what = p.kind === "sumbangan" ? "Sumbangan / Contribution" : p.for_month ? `Yuran ${idxLabel(mIdx(p.for_month))}` : String(p.ref ?? p.method ?? "-");
    line(p.paid_on, 50, 10); line(what.slice(0, 40), 170, 10); line(rm(p.amount), 430, 10); next(16);
  }
  next(10);
  kv(`Dibayar ${year} / Paid in ${year}`, rm(paidYear));
  kv(`Perlu dibayar ${year} / Due in ${year}`, rm(monthsYear * due));
  kv(owe > 0 ? `Tunggakan / Outstanding (31 Dis ${year})` : `Lebihan / Advance (31 Dis ${year})`, rm(Math.abs(owe)), true);
  next(14);
  line("Ringkasan Tabung / Fund Summary", 50, 12, bold, blue); next(20);
  kv(`Jumlah masuk ${year} / Total in`, rm(fy.tin));
  kv(`Jumlah keluar ${year} / Total out`, rm(fy.tout));
  kv(`Baki / Balance (31 Dis ${year})`, rm(fAll.bal), true);
  next(20);
  line(`Dijana / Generated ${ymd(myt())}${DASH ? " · " + DASH : ""}`, 50, 8, font, grey);
  return { bytes: await pdf.save(), owe };
}

async function statements(year: number, previewTo?: number) {
  const due = await monthlyDue();
  const [{ data: mem }, { data: br }] = await Promise.all([
    db.from("members").select("*").order("id"),
    db.from("member_breaks").select("member_id,from_month,to_month"),
  ]);
  const breaks = br ?? [];
  let n = 0;
  const missing: string[] = [];
  for (const m of mem ?? []) {
    if (dueMonths(m, breaks, year * 12 + 11).filter((i) => Math.floor(i / 12) === year).length === 0) continue; // not a member that year
    const { bytes, owe } = await statementPdf(m, breaks, year, due);
    const to = previewTo ?? m.tg_chat_id;
    if (!to) { missing.push(m.name); continue; }
    const fd = new FormData();
    fd.append("chat_id", String(to));
    fd.append("caption", `📄 Penyata TabungFamily ${year} — ${m.name}` + (owe > 0 ? `\nTunggakan: ${rm(owe)}` : "\nTerima kasih! ✅"));
    fd.append("document", new Blob([bytes], { type: "application/pdf" }), `TabungFamily_${year}_${m.name.replace(/\W+/g, "_")}.pdf`);
    await fetch(`${TG}/sendDocument`, { method: "POST", body: fd });
    n++;
  }
  if (!previewTo) {
    await send(ADMIN, `📄 Penyata ${year} dihantar ke ${n} ahli.` + (missing.length ? `\n⚠️ Belum sambung Telegram: ${esc(missing.join(", "))}` : ""));
  }
  return { sent: n, missing };
}

// ---------------------------------------------------------------- web admin actions (needs admin login)
async function isAdminRequest(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await db.auth.getUser(token);
  const email = data?.user?.email?.toLowerCase();
  return !!email && email === (await setting("admin_email")).toLowerCase();
}

async function adminAction(body: Any) {
  if (body.action === "approve" || body.action === "reject") {
    const n = await decideBatch(body.batch_id, body.action === "approve", body.amounts);
    return { ok: true, updated: n };
  }
  if (body.action === "backup") {
    const r = await appsScript({ action: "snapshot" });
    return { ok: true, at: r.at };
  }
  if (body.action === "remind") return { ok: true, ...(await reminder(true)) };
  if (body.action === "upload") {
    // receipt picked in the web admin (cash-out) -> Google Drive
    const folder = String(body.folder || ymd(myt()).slice(0, 7));
    const r = await appsScript({ action: "upload", name: body.name, mime: body.mime, folder, public: !!body.public, data: body.data });
    return { ok: true, url: r.url };
  }
  return { ok: false, error: "unknown action" };
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  try {
    // Scheduled jobs (pg_cron)
    if (task) {
      if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return new Response("unauthorized", { status: 401 });
      await db.from("settings").select("key").limit(1); // keeps the free project awake
      if (task === "daily") return Response.json(await reminder(false));
      if (task === "reminder") return Response.json(await reminder(true));
      if (task === "statement") return Response.json(await statements(Number(url.searchParams.get("year")) || myt().getUTCFullYear() - 1));
      return new Response("unknown task", { status: 400 });
    }
    // Web admin
    if (url.searchParams.get("admin") !== null) {
      if (!(await isAdminRequest(req))) return Response.json({ ok: false, error: "not admin" }, { status: 401, headers: CORS });
      return Response.json(await adminAction(await req.json()), { headers: CORS });
    }
    // Telegram webhook
    if (req.headers.get("x-telegram-bot-api-secret-token") !== env("TG_SECRET")) return new Response("unauthorized", { status: 401 });
    const upd = await req.json();
    if (upd.message) await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch (e) {
    console.error(e);
    if (url.searchParams.get("admin") !== null) return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500, headers: CORS });
    await send(ADMIN, "⚠️ TabungFamily error: " + esc((e as Error)?.message ?? e)).catch(() => {});
  }
  return new Response("ok");
});
