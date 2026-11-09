/** @OnlyCurrentDoc */
/**
 * 宜蘭市開票統計：Google 試算表後端
 *
 * 部署方式見專案根目錄 README.md。重點：
 *  1. 在試算表裡 擴充功能 → Apps Script，貼上這份程式碼。
 *  2. 專案設定 → 指令碼屬性，新增 TOKEN = 你自訂的同步密碼（填表人要輸入）。
 *  3. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」，存取權「任何人」。
 *
 * 讀取（GET）不需要密碼；寫入（POST）一定要密碼。
 *
 * 試算表格式（「得票明細」分頁，長表）：
 *   一列 = 一個範圍 × 一種選舉 × 一位候選人（另有一列「無效票」），方便用樞紐分析表統計。
 *   「類型」欄：投開票所＝各所回報；合計＝直接填的全市／選舉區／里合計（和各所分開存，彙總時不重複加）。
 */

var DETAIL = '得票明細';
var SUMMARY = '彙總';
var HEADER = ['編號', '市民代表選舉區', '里', '投開票所', '選舉', '選區／範圍', '號次', '候選人', '得票數',
  '狀態', '選舉人數', '填表人', '更新時間', 'updatedAtMs', 'key', '類型'];
var COL = { id: 0, district: 1, village: 2, venue: 3, race: 4, group: 5, no: 6, name: 7, votes: 8,
  status: 9, electors: 10, by: 11, time: 12, ms: 13, key: 14, kind: 15 };
var STATUS_LABEL = { pending: '未開票', counting: '開票中', done: '已完成' };
var STATUS_CODE = { '未開票': 'pending', '開票中': 'counting', '已完成': 'done' };
var MAX_ROWS = 10000;

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'all';
    if (action !== 'all') return json_({ ok: false, error: 'unknown action' });
    return json_(readAll_());
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return json_({ ok: false, error: '尚未在「指令碼屬性」設定 TOKEN' });
    if (body.token !== token) return json_({ ok: false, error: '同步密碼不正確' });

    if (body.action === 'upsertMany') {
      return json_({ ok: true, count: write_(body.records || [], false) });
    }
    if (body.action === 'init') {
      write_(body.records || [], true);
      buildSummary_(body.summary || []);
      return json_({ ok: true, rows: getSheet_().getLastRow() - 1 });
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* ignore */ }
  }
}

/* ---------- 工作表 ---------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(DETAIL);
  if (!sh) sh = ss.insertSheet(DETAIL, 0);
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, HEADER.length).getValues()[0] : [];
  var same = HEADER.every(function (h, i) { return cur[i] === h; });
  if (!same) {
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADER.length).setFontWeight('bold').setBackground('#dcefe8');
    sh.hideColumns(COL.ms + 1, 2); // updatedAtMs、key
    sh.getRange(2, 1, MAX_ROWS, 1).setNumberFormat('@'); // 編號欄存成文字，保留 0001 的前導零
  }
  return sh;
}

// 一筆紀錄（投開票所×選舉）展開成多列：每位候選人一列 + 無效票一列
function recordRows_(r) {
  var time = r.updatedAt
    ? Utilities.formatDate(new Date(r.updatedAt), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') : '';
  var filled = !!r.updatedAt;
  var status = STATUS_LABEL[r.status] || '未開票';
  function line(no, name, votes) {
    var row = new Array(HEADER.length);
    row[COL.id] = r.id;
    row[COL.district] = r.districtLabel || ('第' + r.district + '選舉區');
    row[COL.village] = r.village || '';
    row[COL.venue] = r.venue;
    row[COL.race] = r.raceLabel;
    row[COL.group] = r.group;
    row[COL.no] = no;
    row[COL.name] = name;
    row[COL.votes] = filled ? votes : '';
    row[COL.status] = status;
    row[COL.electors] = r.electors == null ? '' : r.electors;
    row[COL.by] = r.by || '';
    row[COL.time] = time;
    row[COL.ms] = r.updatedAt || 0;
    row[COL.key] = r.id + '|' + r.race + '|' + no;
    row[COL.kind] = r.kind || '投開票所';
    return row;
  }
  var rows = (r.cands || []).map(function (c) {
    return line(c.no, c.name, Number(r.votes && r.votes[c.no]) || 0);
  });
  rows.push(line('無效', '無效票', Number(r.invalid) || 0));
  return rows;
}

function keyIndex_(sh) {
  var last = sh.getLastRow();
  var map = {}, ms = {};
  if (last < 2) return { map: map, ms: ms };
  var vals = sh.getRange(2, COL.ms + 1, last - 1, 2).getValues(); // ms, key
  for (var i = 0; i < vals.length; i++) {
    map[String(vals[i][1])] = i + 2;
    ms[i + 2] = Number(vals[i][0]) || 0;
  }
  return { map: map, ms: ms };
}

// createOnly=true：只補上不存在的列（初始化用）。回傳實際寫入的紀錄數
function write_(records, createOnly) {
  var sh = getSheet_();
  var idx = keyIndex_(sh);
  var updates = [], appends = [], n = 0;
  records.forEach(function (r) {
    var rows = recordRows_(r);
    var firstRow = idx.map[rows[0][COL.key]];
    if (firstRow && (createOnly || idx.ms[firstRow] >= (r.updatedAt || 0))) return; // 已存在，或雲端比較新
    rows.forEach(function (row) {
      var at = idx.map[row[COL.key]];
      if (at) updates.push({ row: at, values: row }); else appends.push(row);
    });
    n++;
  });
  // 連續的列合併成一次寫入
  updates.sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < updates.length) {
    var j = i;
    while (j + 1 < updates.length && updates[j + 1].row === updates[j].row + 1) j++;
    var block = updates.slice(i, j + 1).map(function (u) { return u.values; });
    sh.getRange(updates[i].row, 1, block.length, HEADER.length).setValues(block);
    i = j + 1;
  }
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADER.length).setValues(appends);
  return n;
}

function readAll_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DETAIL);
  if (!sh || sh.getLastRow() < 2) return { ok: true, records: [], serverTime: Date.now() };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, HEADER.length).getValues();
  var recs = {};
  vals.forEach(function (row) {
    var parts = String(row[COL.key]).split('|'); // id|race|no
    if (parts.length !== 3) return;
    var k = parts[0] + '|' + parts[1];
    var r = recs[k];
    if (!r) {
      r = recs[k] = {
        id: parts[0], race: parts[1], votes: {}, invalid: 0,
        electors: row[COL.electors] === '' ? null : Number(row[COL.electors]),
        status: STATUS_CODE[row[COL.status]] || 'pending',
        by: String(row[COL.by] || ''), updatedAt: Number(row[COL.ms]) || 0
      };
    }
    var v = Number(row[COL.votes]) || 0;
    if (parts[2] === '無效') r.invalid = v; else r.votes[parts[2]] = v;
  });
  return { ok: true, records: Object.keys(recs).map(function (k) { return recs[k]; }), serverTime: Date.now() };
}

/* ---------- 後台歸零（試算表上方選單「開票工具」） ---------- */
// 歸零 = 把票數清掉、狀態改回「未開票」，並蓋上現在的時間，
// 所以所有人的手機下次同步（約 20 秒內）也會跟著變成「未開票」，不會把舊資料又傳回來。

function onOpen() {
  SpreadsheetApp.getUi().createMenu('開票工具')
    .addItem('全部歸零（清空所有票數）', 'resetAll')
    .addItem('歸零某一個投開票所', 'resetOne')
    .addToUi();
}

// match(row)：這一列要不要歸零。dryRun=true 只計算有幾筆（投開票所×選舉），不改任何資料。
function resetRows_(match, dryRun) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DETAIL);
    if (!sh || sh.getLastRow() < 2) return 0;
    var rng = sh.getRange(2, 1, sh.getLastRow() - 1, HEADER.length);
    var vals = rng.getValues();
    var now = Date.now();
    var time = Utilities.formatDate(new Date(now), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    var hit = {};
    vals.forEach(function (row) {
      var untouched = !(Number(row[COL.ms]) > 0) || (row[COL.status] === STATUS_LABEL.pending && row[COL.votes] === '');
      if (untouched || !match(row)) return;
      hit[row[COL.id] + '|' + row[COL.race]] = true;
      if (dryRun) return;
      row[COL.votes] = '';
      row[COL.status] = STATUS_LABEL.pending;
      row[COL.by] = '';
      row[COL.time] = time;
      row[COL.ms] = now;
    });
    var n = Object.keys(hit).length;
    if (n && !dryRun) rng.setValues(vals);
    return n;
  } finally {
    lock.releaseLock();
  }
}

function resetAll() {
  var ui = SpreadsheetApp.getUi();
  var n = resetRows_(function () { return true; }, true);
  if (!n) { ui.alert('目前沒有任何票數，不用歸零。'); return; }
  var res = ui.prompt('全部歸零',
    '⚠ 目前有 ' + n + ' 筆票數（投開票所 × 選舉，含合計）。\n\n'
    + '歸零會全部清空，所有人的手機也會跟著變成「未開票」。\n'
    + '（萬一按錯，可用「檔案 → 版本記錄」找回。）\n\n'
    + '要繼續，請輸入：我要清空', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK || String(res.getResponseText()).trim() !== '我要清空') {
    ui.alert('已取消，沒有動到任何資料。');
    return;
  }
  var done = resetRows_(function () { return true; }, false);
  ui.alert('完成，已歸零 ' + done + ' 筆。\n大家的手機約 20 秒內會自動跟著變成「未開票」。');
}

function resetOne() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('歸零某一個投開票所',
    '請輸入投開票所編號，例如 0015。\n（合計請輸入：ALL＝全市，D1～D4＝選舉區，V:七結里＝里）', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var id = String(a.getResponseText()).trim();
  if (/^\d+$/.test(id)) id = ('0000' + id).slice(-4);
  if (!id) { ui.alert('沒有輸入編號。'); return; }
  var b = ui.prompt('要歸零哪一項？',
    '輸入：市長、市民代表、里長、縣長、縣議員 其中一個。\n留空 ＝ 這一所的所有項目。', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var raceText = String(b.getResponseText()).trim();
  var match = function (row) {
    return String(row[COL.id]) === id && (!raceText || String(row[COL.race]).indexOf(raceText) >= 0);
  };
  var n = resetRows_(match, true);
  if (!n) { ui.alert('找不到「' + id + (raceText ? ' ' + raceText : '') + '」有填過的票數。\n請確認編號、項目有沒有打對。'); return; }
  var ok = ui.alert('確定歸零？', id + (raceText ? '　' + raceText : '　全部項目') + '，共 ' + n + ' 筆。\n歸零後所有人的手機也會跟著變成「未開票」。', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) { ui.alert('已取消，沒有動到任何資料。'); return; }
  ui.alert('完成，已歸零 ' + resetRows_(match, false) + ' 筆。');
}

/* ---------- 彙總分頁（各候選人全市／各選區得票，用公式即時計算） ---------- */

function buildSummary_(groups) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY);
  sh.clear();
  var T = "'" + DETAIL + "'!";
  function rng(c) { var L = String.fromCharCode(65 + c); return T + '$' + L + '$2:$' + L + '$' + MAX_ROWS; }
  var out = [['選舉', '選區／範圍', '應選', '完成所數', '號次', '候選人', '政黨', '各所加總', '得票率', '手動合計']];
  var NOTSUM = rng(COL.kind) + ',"<>合計"'; // 各所加總不含手動合計列
  groups.forEach(function (g) {
    var scope = rng(COL.race) + ',"' + g.race + '",' + rng(COL.group) + ',"' + g.group + '",' + NOTSUM;
    var done = '=COUNTIFS(' + scope + ',' + rng(COL.no) + ',"無效",' + rng(COL.status) + ',"已完成")'
      + '&" / "&COUNTIFS(' + scope + ',' + rng(COL.no) + ',"無效")';
    var validAll = 'SUMIFS(' + rng(COL.votes) + ',' + scope + ',' + rng(COL.no) + ',">0")';
    var manual = rng(COL.race) + ',"' + g.race + '",' + rng(COL.group) + ',"' + g.group + '",'
      + rng(COL.kind) + ',"合計",' + rng(COL.id) + ',"' + (g.scopeId || '') + '"';
    (g.cands || []).forEach(function (c, i) {
      var row = out.length + 1;
      out.push([g.race, g.group, g.seats, i === 0 ? done : '', c.no, c.name, c.party || '',
        '=SUMIFS(' + rng(COL.votes) + ',' + scope + ',' + rng(COL.no) + ',' + c.no + ')',
        '=IFERROR(H' + row + '/' + validAll + ',0)',
        '=SUMIFS(' + rng(COL.votes) + ',' + manual + ',' + rng(COL.no) + ',' + c.no + ')']);
    });
  });
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold').setBackground('#dcefe8');
  sh.getRange(2, 9, Math.max(out.length - 1, 1), 1).setNumberFormat('0.0%');
  sh.setFrozenRows(1);
}
