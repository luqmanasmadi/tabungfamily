/**
 * =====================================================================
 * TabungFamily — Google side (Apps Script web app)
 *  1. Saves receipts to Google Drive:
 *       My Drive / Tabung Family / Cash In  / YYYY-MM-DD_Name.jpg               (private)
 *       My Drive / Tabung Family / Cash Out / YYYY-MM-DD_Category_Item.jpg      (anyone with the link)
 *  2. Keeps a backup Google Sheet in sync   (every change + full snapshot every night)
 *  3. Builds a Dashboard tab in that Sheet  (works even if the app is down)
 *  4. Keeps 12 weekly copies of the Sheet   (My Drive / Tabung Family / Backup mingguan)
 *
 * SETUP (once):
 *  a. Project Settings > Script properties, add:
 *       SECRET        = a long random text (same as DRIVE_SECRET / backup_secret)
 *       SUPABASE_URL  = https://xxxx.supabase.co
 *       SERVICE_KEY   = Supabase service_role key (Settings > API)  — keep private
 *  b. Project Settings > Time zone = (GMT+08:00) Kuala Lumpur
 *  c. Run the function `setup` once (Run button) and allow the permissions.
 *  d. Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone > copy URL.
 * =====================================================================
 */

const ROOT = 'Tabung Family';
const OLD_ROOT = 'TabungFamily'; // earlier name: renamed automatically the first time
const MON = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogo', 'Sep', 'Okt', 'Nov', 'Dis'];
const NAVY = '#1F2A5C', BLUE = '#3F5BB5', BLUSH = '#DDE3F8', PAPER = '#F6F3FD', SUN = '#F7E58F';
const PAID_BG = '#3F5BB5', DUE_BG = '#FBEBDD', NONE_BG = '#E4E6EE', OK_FG = '#2F6B3F', DUE_FG = '#8A420B';
const HIDDEN_SETTINGS = ['backup_secret', 'backup_hook_url', 'admin_email'];

// Tab layout. Column names match the Import feature, so a tab saved as CSV can be imported back.
const TABS = {
  ahli:        { table: 'members',       head: ['id', 'nama', 'mula', 'telegram', 'dicipta'] },
  rehat:       { table: 'member_breaks', head: ['id', 'ahli_id', 'ahli', 'dari', 'hingga', 'sebab'] },
  duit_masuk:  { table: 'cash_in',       head: ['id', 'tarikh', 'ahli', 'jenis', 'jumlah', 'cara', 'rujukan', 'status', 'resit', 'sumber', 'keterangan', 'kategori', 'dihantar_oleh', 'untuk_bulan'] },
  duit_keluar: { table: 'cash_out',      head: ['id', 'tarikh', 'ahli', 'jenis', 'jumlah', 'keterangan', 'kategori', 'rujukan', 'resit', 'rekod_lama'] },
  tetapan:     { table: 'settings',      head: ['kunci', 'nilai'] },
};
const TABLE_TO_TAB = { members: 'ahli', member_breaks: 'rehat', cash_in: 'duit_masuk', cash_out: 'duit_keluar' };

const props = () => PropertiesService.getScriptProperties();
const prop = (k) => props().getProperty(k) || '';

// ------------------------------------------------------------------ web app entry
function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (!prop('SECRET') || p.secret !== prop('SECRET')) return out_({ ok: false, error: 'unauthorized' });
    if (p.action === 'upload' || !p.action) return out_(upload_(p));
    if (p.action === 'change') return out_(withLock_(() => change_(p)));
    if (p.action === 'snapshot') return out_(withLock_(() => snapshot()));
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}
function doGet() { return out_({ ok: true, app: 'TabungFamily' }); }

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ 1. receipts to Drive
function upload_(p) {
  // kind 'in' -> Cash In (private), 'out' -> Cash Out (public). Older callers only sent `public`.
  const out = p.kind ? p.kind === 'out' : !!p.public;
  const folder = folder_(root_(), out ? 'Cash Out' : 'Cash In');
  const name = uniqueName_(folder, safeName_(p.name || 'resit'));
  const blob = Utilities.newBlob(Utilities.base64Decode(p.data), p.mime || 'application/octet-stream', name);
  const file = folder.createFile(blob);
  // Money-out receipts are public (anyone with the link) for transparency; money-in receipts stay private.
  if (p.public) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, id: file.getId(), url: file.getUrl() };
}
/** "2026-11-05_Kereta_Servis/minyak?.jpg" -> safe for Drive, max 150 chars. */
function safeName_(n) {
  return String(n).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'resit';
}
/** Adds " (2)", " (3)"… before the extension if the name is already used in that folder. */
function uniqueName_(folder, name) {
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = name, k = 2;
  while (folder.getFilesByName(n).hasNext()) n = base + ' (' + (k++) + ')' + ext;
  return n;
}
/** My Drive / Tabung Family (renames the older "TabungFamily" folder if that is what exists). */
function root_() {
  const drive = DriveApp.getRootFolder();
  if (!drive.getFoldersByName(ROOT).hasNext()) {
    const old = drive.getFoldersByName(OLD_ROOT);
    if (old.hasNext()) old.next().setName(ROOT);
  }
  return folder_(drive, ROOT);
}
function folder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ------------------------------------------------------------------ 2. backup sheet
function ss_() {
  const id = prop('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted: make a new one */ } }
  const ss = SpreadsheetApp.create('TabungFamily Backup');
  ss.setSpreadsheetTimeZone('Asia/Kuala_Lumpur');
  DriveApp.getFileById(ss.getId()).moveTo(root_());
  props().setProperty('SHEET_ID', ss.getId());
  buildTabs_(ss);
  return ss;
}

function buildTabs_(ss) {
  let dash = ss.getSheetByName('Dashboard');
  if (!dash) dash = ss.getSheets()[0].setName('Dashboard');
  Object.keys(TABS).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[name].head.length).setValues([TABS[name].head])
      .setFontWeight('bold').setBackground(NAVY).setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  });
  let log = ss.getSheetByName('log');
  if (!log) {
    log = ss.insertSheet('log');
    log.getRange(1, 1, 1, 5).setValues([['masa', 'jadual', 'operasi', 'id', 'ringkasan']])
      .setFontWeight('bold').setBackground(NAVY).setFontColor('#FFFFFF');
    log.setFrozenRows(1);
  }
  buildDashboard_(ss);
}

const d_ = (s) => (s ? new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) : '');

function toRow_(tab, r, names) {
  switch (tab) {
    case 'ahli':        return [r.id, r.name, d_(r.start_month), r.tg_chat_id ? 'Ya' : 'Belum', r.created_at || ''];
    case 'rehat':       return [r.id, r.member_id, names[r.member_id] || r.member_name || '', d_(r.from_month), d_(r.to_month), r.reason || ''];
    case 'duit_masuk':  return [r.id, d_(r.paid_on), r.member_id ? (names[r.member_id] || r.member_name || '') : 'Lain-lain', 'masuk', Number(r.amount), r.method || '', r.ref || '',
                                r.status, r.receipt_url || '', r.source || '', r.note || '', r.kind || 'yuran', names[r.sent_by] || '', d_(r.for_month)];
    case 'duit_keluar': return [r.id, d_(r.spent_on), '', 'keluar', Number(r.amount), r.description, r.category, '', r.receipt_url || '', r.legacy ? 'Ya' : ''];
  }
}

function memberNames_(ss) {
  const names = {};
  const sh = ss.getSheetByName('ahli');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach((v) => { names[v[0]] = v[1]; });
  return names;
}

/** One row changed in the app -> update the same row in the sheet. */
function change_(p) {
  const tab = TABLE_TO_TAB[p.table];
  if (!tab) return { ok: true, skipped: true };
  const ss = ss_();
  const sh = ss.getSheetByName(tab);
  const names = memberNames_(ss);
  if (p.member_name && p.row.member_id) names[p.row.member_id] = p.member_name;
  const id = p.row.id;
  const found = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext() : null;
  if (p.op === 'DELETE') {
    if (found) sh.deleteRow(found.getRow());
  } else {
    const row = toRow_(tab, p.row, names);
    if (found) sh.getRange(found.getRow(), 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
  }
  log_(ss, p.table, p.op, id, summary_(p));
  refreshDashboard_(ss);
  return { ok: true };
}

function summary_(p) {
  const r = p.row;
  if (p.table === 'cash_in') return (p.member_name || 'Lain-lain') + ' RM' + r.amount + ' ' + r.status;
  if (p.table === 'cash_out') return r.description + ' RM' + r.amount;
  if (p.table === 'members') return r.name;
  if (p.table === 'member_breaks') return (p.member_name || '') + ' berhenti dari ' + r.from_month + (r.to_month ? ' hingga ' + r.to_month : '');
  return '';
}

function log_(ss, table, op, id, text) {
  const sh = ss.getSheetByName('log');
  sh.appendRow([new Date(), table, op, id, text]);
  if (sh.getLastRow() > 3000) sh.deleteRows(2, 500);
}

function sb_(path, opts) {
  const res = UrlFetchApp.fetch(prop('SUPABASE_URL') + '/rest/v1/' + path, Object.assign({
    headers: { apikey: prop('SERVICE_KEY'), Authorization: 'Bearer ' + prop('SERVICE_KEY'), 'Content-Type': 'application/json' },
    muteHttpExceptions: true,
  }, opts || {}));
  if (res.getResponseCode() >= 300) throw new Error('Supabase ' + res.getResponseCode() + ': ' + res.getContentText());
  const t = res.getContentText();
  return t ? JSON.parse(t) : null;
}

/** Full copy of every table. Runs every night and from the "Backup sekarang" button. */
function snapshot() {
  const ss = ss_();
  const data = {};
  ['members', 'member_breaks', 'cash_in', 'cash_out'].forEach((t) => { data[t] = sb_(t + '?select=*&order=id'); });
  const settings = sb_('settings?select=key,value&order=key');
  const names = {};
  data.members.forEach((m) => { names[m.id] = m.name; });

  Object.keys(TABLE_TO_TAB).forEach((table) => {
    const tab = TABLE_TO_TAB[table];
    ss.getSheetByName(tab).getRange(1, 1, 1, TABS[tab].head.length).setValues([TABS[tab].head]); // keeps headers current
    write_(ss.getSheetByName(tab), data[table].map((r) => toRow_(tab, r, names)), TABS[tab].head.length);
  });
  write_(ss.getSheetByName('tetapan'), settings.filter((s) => HIDDEN_SETTINGS.indexOf(s.key) < 0).map((s) => [s.key, s.value]), 2);

  const at = new Date();
  ss.getSheetByName('Dashboard').getRange('B2').setValue(at);
  log_(ss, '*', 'SNAPSHOT', '', 'Backup penuh: ' + data.cash_in.length + ' masuk, ' + data.cash_out.length + ' keluar');
  refreshDashboard_(ss);
  weeklyCopy_(ss);

  sb_('settings?on_conflict=key', {
    method: 'post',
    headers: { apikey: prop('SERVICE_KEY'), Authorization: 'Bearer ' + prop('SERVICE_KEY'), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    payload: JSON.stringify([{ key: 'last_backup_at', value: at.toISOString() }, { key: 'backup_sheet_url', value: ss.getUrl() }]),
  });
  return { ok: true, at: at.toISOString(), url: ss.getUrl() };
}

function write_(sh, rows, width) {
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(width, sh.getLastColumn())).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function weeklyCopy_(ss) {
  const last = Number(prop('LAST_WEEKLY') || 0);
  if (Date.now() - last < 6.5 * 864e5) return;
  const folder = folder_(root_(), 'Backup mingguan');
  DriveApp.getFileById(ss.getId()).makeCopy('TabungFamily Backup ' + Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'yyyy-MM-dd'), folder);
  props().setProperty('LAST_WEEKLY', String(Date.now()));
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(12).forEach((f) => f.setTrashed(true)); // keep the newest 12 (about 3 months)
}

// ------------------------------------------------------------------ 3. dashboard tab
const RM = '"RM"#,##0.00';

function buildDashboard_(ss) {
  const sh = ss.getSheetByName('Dashboard');
  sh.clear();
  sh.getCharts().forEach((c) => sh.removeChart(c));
  sh.setHiddenGridlines(true);
  sh.getRange('A1:P200').setFontFamily('Inter').setFontColor(NAVY);
  sh.setColumnWidth(1, 170);
  for (let c = 2; c <= 16; c++) sh.setColumnWidth(c, 92);

  sh.getRange('A1').setValue('TabungFamily — Dashboard').setFontSize(20).setFontWeight('bold');
  sh.getRange('A2').setValue('Backup terakhir');
  sh.getRange('B2:D2').merge().setNumberFormat('d mmm yyyy, h:mm am/pm').setFontColor(BLUE);
  sh.getRange('A3').setValue('Tahun').setFontWeight('bold');
  sh.getRange('B3').setValue(new Date().getFullYear()).setBackground(SUN).setFontWeight('bold').setHorizontalAlignment('center');
  const years = [];
  for (let y = 2020; y <= new Date().getFullYear() + 1; y++) years.push(y);
  sh.getRange('B3').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(years.map(String), true).build());
  sh.getRange('C3').setValue('← tukar tahun').setFontColor('#5A6699').setFontSize(9);

  const OPEN = 'IFERROR(VALUE(VLOOKUP("opening_balance",tetapan!A:B,2,FALSE)),0)';
  const IN = (cond) => 'SUMIFS(duit_masuk!E:E,duit_masuk!H:H,"approved"' + cond + ')';
  const OUT = (cond) => 'SUMIFS(duit_keluar!E:E' + (cond ? ',' + cond.slice(1) : ',duit_keluar!E:E,">0"') + ')';
  const Y0 = 'DATE($B$3,1,1)', Y1 = 'DATE($B$3,12,31)';
  const kpis = [
    ['Baki bawa ke hadapan', '=' + OPEN + '+' + IN(',duit_masuk!B:B,"<"&' + Y0) + '-' + OUT(',duit_keluar!B:B,"<"&' + Y0)],
    ['Masuk (tahun)', '=' + IN(',duit_masuk!B:B,">="&' + Y0 + ',duit_masuk!B:B,"<="&' + Y1)],
    ['Keluar (tahun)', '=' + OUT(',duit_keluar!B:B,">="&' + Y0 + ',duit_keluar!B:B,"<="&' + Y1)],
    ['Baki akhir tahun', '=A6+B6-C6'],
    ['Baki semasa', '=' + OPEN + '+' + IN('') + '-' + OUT('')],
    ['Tertunggak (sekarang)', 0],
  ];
  kpis.forEach((k, i) => {
    sh.getRange(5, i + 1).setValue(k[0]).setFontSize(9).setFontColor('#5A6699').setWrap(true);
    sh.getRange(6, i + 1).setValue(k[1]).setNumberFormat(RM).setFontSize(14).setFontWeight('bold').setBackground(PAPER);
  });
  sh.getRange('E6').setBackground(NAVY).setFontColor('#FFFFFF');
  sh.getRange('F6').setFontColor(DUE_FG);
  sh.setRowHeight(6, 36);

  sh.getRange('A8').setValue('Masuk vs Keluar bulanan').setFontWeight('bold').setFontSize(12);
  sh.getRange('A9:C9').setValues([['Bulan', 'Masuk', 'Keluar']]).setFontWeight('bold').setBackground(BLUSH);
  for (let m = 1; m <= 12; m++) {
    const a = 'DATE($B$3,' + m + ',1)', z = 'EOMONTH(' + a + ',0)';
    sh.getRange(9 + m, 1, 1, 3).setValues([[MON[m - 1],
      '=' + IN(',duit_masuk!B:B,">="&' + a + ',duit_masuk!B:B,"<="&' + z),
      '=' + OUT(',duit_keluar!B:B,">="&' + a + ',duit_keluar!B:B,"<="&' + z)]]);
  }
  sh.getRange('B10:C21').setNumberFormat(RM);
  const chart = sh.newChart().asColumnChart().addRange(sh.getRange('A9:C21'))
    .setNumHeaders(1).setColors([BLUE, '#F9B774']).setOption('title', 'Masuk vs Keluar')
    .setOption('legend', { position: 'top' }).setPosition(8, 5, 0, 0).setOption('width', 620).setOption('height', 300).build();
  sh.insertChart(chart);
  refreshDashboard_(ss);
}

/** Member grid + outstanding list, worked out from the sheet's own tabs. */
function refreshDashboard_(ss) {
  const sh = ss.getSheetByName('Dashboard');
  if (!sh) return;
  const year = Number(sh.getRange('B3').getValue()) || new Date().getFullYear();
  const tv = rows_(ss, 'tetapan');
  const fee = Number((tv.find((r) => r[0] === 'monthly_due') || [])[1]) || 100;
  const members = rows_(ss, 'ahli').filter((r) => r[0] !== '');
  const breaks = rows_(ss, 'rehat');
  // only approved monthly fees pay dues (kategori 'sumbangan' = extra money, not dues)
  const pays = rows_(ss, 'duit_masuk').filter((r) => r[7] === 'approved' && r[11] !== 'sumbangan');
  const now = new Date();
  const nowI = now.getFullYear() * 12 + now.getMonth();
  const idx = (d) => (d instanceof Date ? d.getFullYear() * 12 + d.getMonth() : null);

  const START = 24;
  sh.getRange(START, 1, 200, 16).clear();
  sh.getRange(START, 1).setValue('Status bayaran ahli').setFontWeight('bold').setFontSize(12);
  const head = ['Ahli'].concat(MON, ['Dibayar (tahun)', 'Tunggakan', 'Status']);
  sh.getRange(START + 1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground(BLUSH);

  const grid = [], colours = [], owing = [];
  let oweTotal = 0;
  members.forEach((m) => {
    const id = m[0], name = m[1], s = idx(m[2]);
    if (s === null) return;
    const br = breaks.filter((b) => b[1] === id).map((b) => [idx(b[3]), b[4] instanceof Date ? idx(b[4]) : Infinity]);
    const skip = (i) => br.some((b) => i >= b[0] && i <= b[1]);
    const stopped = br.some((b) => b[1] === Infinity && b[0] <= nowI);
    const mine = pays.filter((p) => p[2] === name);
    const paidAll = mine.reduce((t, p) => t + Number(p[4]), 0);
    const paidYear = mine.filter((p) => p[1] instanceof Date && p[1].getFullYear() === year).reduce((t, p) => t + Number(p[4]), 0);
    const dueList = [];
    for (let i = s; i <= Math.max(nowI, year * 12 + 11) + 120; i++) if (!skip(i)) dueList.push(i);
    const cover = alloc_(dueList, mine.map((p) => ({ amt: Number(p[4]), date: p[1], forI: idx(p[13]) })), fee);
    const row = [name], bg = [null];
    for (let k = 0; k < 12; k++) {
      const i = year * 12 + k;
      if (s === null || i < s || skip(i)) { row.push('—'); bg.push(NONE_BG); continue; }
      const c = cover[i] || 0;
      if (c >= fee - 0.001) { row.push('✓'); bg.push(PAID_BG); }
      else if (c > 0.001) { row.push('½'); bg.push(DUE_BG); }
      else if (i <= nowI) { row.push('!'); bg.push(DUE_BG); }
      else { row.push(''); bg.push(null); }
    }
    const owedNow = dueList.filter((i) => i <= nowI).length * fee;
    const owe = Math.max(0, owedNow - paidAll);
    oweTotal += owe;
    if (owe > 0) owing.push([name, owe]);
    row.push(paidYear, owe, stopped ? 'Berhenti' : 'Aktif');
    bg.push(null, null, null);
    grid.push(row); colours.push(bg);
  });
  if (grid.length) {
    const r = sh.getRange(START + 2, 1, grid.length, head.length);
    r.setValues(grid).setBackgrounds(colours).setHorizontalAlignment('center');
    sh.getRange(START + 2, 1, grid.length, 1).setHorizontalAlignment('left').setFontWeight('bold');
    sh.getRange(START + 2, 14, grid.length, 2).setNumberFormat(RM).setHorizontalAlignment('right');
    const fonts = colours.map((row) => row.map((c) => (c === PAID_BG ? '#FFFFFF' : c === DUE_BG ? DUE_FG : NAVY)));
    r.setFontColors(fonts);
  }
  sh.getRange('F6').setValue(oweTotal);

  let at = START + grid.length + 4;
  sh.getRange(at, 1).setValue('Senarai tertunggak').setFontWeight('bold').setFontSize(12);
  sh.getRange(at + 1, 1, 1, 2).setValues([['Ahli', 'Tunggakan']]).setFontWeight('bold').setBackground(BLUSH);
  owing.sort((a, b) => b[1] - a[1]);
  if (owing.length) sh.getRange(at + 2, 1, owing.length, 2).setValues(owing).setFontColor(DUE_FG);
  else sh.getRange(at + 2, 1).setValue('Semua lunas 🎉').setFontColor(OK_FG);
  sh.getRange(at + 2, 2, Math.max(1, owing.length), 1).setNumberFormat(RM);

  sh.getRange(at, 5).setValue('Duit keluar ikut kategori (tahun)').setFontWeight('bold').setFontSize(12);
  sh.getRange(at + 1, 5).setFormula('=IFERROR(QUERY(duit_keluar!B:G,"select G, sum(E) where B is not null and year(B) = "&$B$3&" group by G order by sum(E) desc label G \'Kategori\', sum(E) \'Jumlah\'",1),"Tiada")');
  sh.getRange(at + 2, 6, 30, 1).setNumberFormat(RM);
}

/**
 * How much of each owed month is covered. Payments tagged with untuk_bulan go to that month;
 * the rest (and anything above the fee) fills the oldest owed month first (FIFO). Same rule as the web app.
 */
function alloc_(dueList, pays, fee) {
  const cover = {};
  let pool = 0;
  pays.forEach((p) => {
    if (p.forI !== null && p.forI !== undefined && dueList.indexOf(p.forI) >= 0) {
      const room = Math.max(0, fee - (cover[p.forI] || 0)), put = Math.min(room, p.amt);
      cover[p.forI] = (cover[p.forI] || 0) + put;
      pool += p.amt - put;
    } else pool += p.amt;
  });
  for (let k = 0; k < dueList.length && pool > 0.001; k++) {
    const i = dueList[k], room = fee - (cover[i] || 0);
    if (room <= 0.001) continue;
    const put = Math.min(room, pool);
    cover[i] = (cover[i] || 0) + put;
    pool -= put;
  }
  return cover;
}

function rows_(ss, tab) {
  const sh = ss.getSheetByName(tab);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

/** Installed trigger: changing the year cell refreshes the member grid. */
function onSheetEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() === 'Dashboard' && e.range.getA1Notation() === 'B3') refreshDashboard_(sh.getParent());
  if (['ahli', 'rehat', 'duit_masuk', 'duit_keluar', 'tetapan'].indexOf(sh.getName()) >= 0) refreshDashboard_(sh.getParent());
}

// ------------------------------------------------------------------ one-time setup
function setup() {
  ['SECRET', 'SUPABASE_URL', 'SERVICE_KEY'].forEach((k) => {
    if (!prop(k)) throw new Error('Tambah Script property: ' + k);
  });
  const ss = ss_();
  buildTabs_(ss);
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('snapshot').timeBased().atHour(3).everyDays(1).inTimezone('Asia/Kuala_Lumpur').create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  const r = snapshot();
  Logger.log('Siap. Google Sheet: ' + r.url);
}
