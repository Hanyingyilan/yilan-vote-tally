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
 *   一列 = 一個投開票所 × 一種選舉 × 一位候選人（另有一列「無效票」），方便用樞紐分析表統計。
 */

var DETAIL = '得票明細';
var SUMMARY = '彙總';
var HEADER = ['編號', '市民代表選舉區', '里', '投開票所', '選舉', '選區／範圍', '號次', '候選人', '得票數',
  '狀態', '選舉人數', '填表人', '更新時間', 'updatedAtMs', 'key'];
var COL = { id: 0, district: 1, village: 2, venue: 3, race: 4, group: 5, no: 6, name: 7, votes: 8,
  status: 9, electors: 10, by: 11, time: 12, ms: 13, key: 14 };
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
    row[COL.district] = '第' + r.district + '選舉區';
    row[COL.village] = r.village;
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

/* ---------- 彙總分頁（各候選人全市／各選區得票，用公式即時計算） ---------- */

function buildSummary_(groups) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY);
  sh.clear();
  var T = "'" + DETAIL + "'!";
  function rng(c) { var L = String.fromCharCode(65 + c); return T + '$' + L + '$2:$' + L + '$' + MAX_ROWS; }
  var out = [['選舉', '選區／範圍', '應選', '完成所數', '號次', '候選人', '政黨', '得票數', '得票率']];
  groups.forEach(function (g) {
    var scope = rng(COL.race) + ',"' + g.race + '",' + rng(COL.group) + ',"' + g.group + '"';
    var done = '=COUNTIFS(' + scope + ',' + rng(COL.no) + ',"無效",' + rng(COL.status) + ',"已完成")'
      + '&" / "&COUNTIFS(' + scope + ',' + rng(COL.no) + ',"無效")';
    var validAll = 'SUMIFS(' + rng(COL.votes) + ',' + scope + ',' + rng(COL.no) + ',">0")';
    (g.cands || []).forEach(function (c, i) {
      var row = out.length + 1;
      out.push([g.race, g.group, g.seats, i === 0 ? done : '', c.no, c.name, c.party || '',
        '=SUMIFS(' + rng(COL.votes) + ',' + scope + ',' + rng(COL.no) + ',' + c.no + ')',
        '=IFERROR(H' + row + '/' + validAll + ',0)']);
    });
  });
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold').setBackground('#dcefe8');
  sh.getRange(2, 9, Math.max(out.length - 1, 1), 1).setNumberFormat('0.0%');
  sh.setFrozenRows(1);
}
