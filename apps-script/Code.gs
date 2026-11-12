/** @OnlyCurrentDoc */
/**
 * 宜蘭市開票統計：Google 試算表後端
 *
 * 部署方式見專案根目錄 README.md。重點：
 *  1. 在試算表裡 擴充功能 → Apps Script，貼上這份程式碼。
 *  2. 專案設定 → 指令碼屬性，新增 TOKEN = 你自訂的密碼（管理員密碼；沒有回報員名單時大家共用這一組）。
 *  3. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」，存取權「任何人」。
 *
 * 讀取（GET）不需要密碼；寫入（POST）一定要密碼。
 * 密碼有兩種：
 *   - 管理員密碼：指令碼屬性的 TOKEN。什麼都能做，只給負責人自己。
 *   - 回報員密碼：「回報員」分頁裡每人一組（選單「開票工具 → 回報員名單」會自動產生）。
 *     只能回報票數；在名單上打勾「停用」就立刻失效，不影響其他人。
 *   沒有「回報員」分頁時，就只有 TOKEN 一組密碼（和以前一樣）。
 * 蓋掉別人（或自己）填過的數字時，改之前的數字會記在「修改記錄」分頁，被亂改可以照著改回來。
 * 填表人的名字不公開：不帶密碼的讀取（GET）拿不到名字；帶密碼的讀取（POST action=read）才有。
 * 讀取結果會快取 15 秒（有人寫入或歸零時立刻清掉），很多人同時看統計頁也不會把後端擠爆。
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
var ROSTER = '回報員';
var ROSTER_HEADER = ['名字', '密碼', '停用（打勾＝不能再送）', '專屬連結（傳給本人，點一下就能回報）'];
var ROSTER_SEC = 30;     // 名單快取秒數（在名單分頁改東西會立刻清掉快取）
var PASS_MIN = 6;        // 回報員密碼至少幾個字（太短容易被猜到，不會生效）
var LOG = '修改記錄';
var LOG_HEADER = ['時間', '誰送的', '編號', '投開票所', '選舉', '改之前', '改之後', '原本是誰填的', '原本的時間'];
var SITE_URL = 'https://hanyingyilan.github.io/yilan-vote-tally/'; // 專屬連結用的網站網址
var CLOCK_SLACK = 30000; // 手機時鐘和這裡差不到 30 秒，當作是準的
var CACHE_SEC = 15;      // 讀取結果快取秒數
var CACHE_CHUNK = 30000; // 快取每段的字數（CacheService 單筆上限 100KB，中文一個字最多 3 bytes）

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'all';
    if (action !== 'all') return json_({ ok: false, error: 'unknown action' });
    return textOut_(withNow_(readCached_(false))); // 公開讀取：不含填表人名字
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 每次讀取都附上「這裡現在幾點」（now），手機用它校正自己不準的時鐘。加在快取之後，所以一定是當下的時間。
function withNow_(text) {
  return '{"now":' + Date.now() + ',' + text.slice(1);
}

// 「時間較新的蓋掉舊的」是照每一筆的 updatedAt，而那是手機自己的時鐘。
// 手機時鐘快了，它填的那一筆別人就一直改不掉；慢了，它自己改的又送不進來。所以收到時先校正：
// sentAt 是手機按下送出那一刻它自己的時間，和這裡收到的時間（arrived）一比，就知道這支手機差多少。
// 校正後仍然不准比現在晚。
function fixTimes_(records, sentAt, arrived) {
  var skew = Number(sentAt) ? arrived - Number(sentAt) : 0;
  if (Math.abs(skew) <= CLOCK_SLACK) skew = 0;
  records.forEach(function (r) {
    var t = Number(r.updatedAt) || 0;
    if (!t) return;
    t += skew;
    if (t > arrived) t = arrived;
    r.updatedAt = t < 1 ? 1 : t;
  });
}

function textOut_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

// withNames=true：含填表人名字（只給有密碼的人）；false：名字一律清空（公開）
function readCached_(withNames) {
  var kind = withNames ? 'full' : 'pub';
  var text = cacheGet_(kind);
  if (text) return text;
  var data = readAll_();
  if (!withNames) data.records.forEach(function (r) { r.by = ''; });
  text = JSON.stringify(data);
  cachePut_(kind, text);
  return text;
}

function doPost(e) {
  var lock = null;
  var arrived = Date.now(); // 收到的時間（排隊等鎖之前就先記下來）
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return json_({ ok: false, error: '尚未在「指令碼屬性」設定 TOKEN' });
    var who = auth_(body.token, token);
    if (!who) return json_({ ok: false, error: '同步密碼不正確' });
    if (who.off) return json_({ ok: false, error: '這組密碼已停用，請聯絡負責人' });

    // 帶密碼的讀取：含填表人名字。只讀不寫，所以不用排隊
    if (body.action === 'read') {
      var text = withNow_(readCached_(true));
      // 用回報員密碼登入的，順便告訴手機「你是誰」，手機就不用再問名字
      return textOut_(who.name ? '{"who":' + JSON.stringify(who.name) + ',' + text.slice(1) : text);
    }

    lock = LockService.getScriptLock();
    lock.waitLock(20000);

    if (body.action === 'upsertMany') {
      var records = body.records || [];
      // 回報員密碼：填表人一律記名單上的名字，不管手機上打什麼
      if (who.name) records.forEach(function (r) { r.by = who.name; });
      fixTimes_(records, body.sentAt, arrived);
      var count = write_(records, false, who.name || '');
      cacheClear_();
      return json_({ ok: true, count: count });
    }
    if (body.action === 'init') {
      if (!who.admin) return json_({ ok: false, error: '初始化要用管理員密碼' });
      write_(body.records || [], true);
      buildSummary_(body.summary || []);
      cacheClear_();
      return json_({ ok: true, rows: getSheet_().getLastRow() - 1 });
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { if (lock) lock.releaseLock(); } catch (x) { /* ignore */ }
  }
}

/* ---------- 密碼 ---------- */

// 回傳 { admin:true }（管理員密碼）、{ name:'王小明' }（回報員密碼）、{ off:true }（已停用）或 null（不對）
function auth_(given, adminToken) {
  if (given === adminToken) return { admin: true };
  given = String(given == null ? '' : given).trim();
  if (!given) return null;
  if (given === String(adminToken).trim()) return { admin: true };
  var list = roster_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].pass === given) return list[i].off ? { off: true } : { name: list[i].name };
  }
  return null;
}

// 「回報員」分頁的名單：[{ name, pass, off }]。密碼太短或沒填名字的列不算。
function roster_() {
  var c = null;
  try {
    c = CacheService.getScriptCache();
    var hit = c.get('roster');
    if (hit) return JSON.parse(hit);
  } catch (err) { /* 沒快取就直接讀 */ }
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER);
  var list = [];
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (row) {
      var name = String(row[0]).trim(), pass = String(row[1]).trim();
      if (!name || pass.length < PASS_MIN) return;
      list.push({ name: name, pass: pass, off: isOff_(row[2]) });
    });
  }
  try { if (c) c.put('roster', JSON.stringify(list), ROSTER_SEC); } catch (err) { /* ignore */ }
  return list;
}

function isOff_(v) {
  if (v === true) return true;
  var t = String(v == null ? '' : v).trim().toLowerCase();
  return !!t && t !== 'false' && t !== '0' && t !== '否';
}

// 在「回報員」分頁改任何東西（例如打勾停用），立刻清掉名單快取，不用等 30 秒
function onEdit(e) {
  try {
    if (e && e.range && e.range.getSheet().getName() === ROSTER) CacheService.getScriptCache().remove('roster');
  } catch (err) { /* ignore */ }
}

/* ---------- 讀取快取 ---------- */
// 整份資料可能超過單筆快取上限，所以切成幾段存；每次存都換一個新的批號，避免讀到新舊混在一起的段落。

// kind：'pub'＝公開版（沒有名字）、'full'＝完整版（有名字），兩份分開存
function cacheGet_(kind) {
  try {
    var c = CacheService.getScriptCache();
    var head = c.get(kind + ':head'); // 「批號|段數」
    if (!head) return null;
    var p = head.split('|'), stamp = p[0], n = Number(p[1]);
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(kind + ':' + stamp + ':' + i);
    var parts = c.getAll(keys), out = '';
    for (var j = 0; j < n; j++) {
      var s = parts[keys[j]];
      if (s == null) return null;
      out += s;
    }
    return out;
  } catch (err) {
    return null;
  }
}

function cachePut_(kind, text) {
  try {
    var c = CacheService.getScriptCache();
    var stamp = String(Date.now()) + Math.floor(Math.random() * 1000);
    var n = Math.ceil(text.length / CACHE_CHUNK), obj = {};
    for (var i = 0; i < n; i++) obj[kind + ':' + stamp + ':' + i] = text.substr(i * CACHE_CHUNK, CACHE_CHUNK);
    c.putAll(obj, CACHE_SEC + 5);
    c.put(kind + ':head', stamp + '|' + n, CACHE_SEC);
  } catch (err) { /* 快取失敗就算了，下次直接讀試算表 */ }
}

function cacheClear_() {
  try { CacheService.getScriptCache().removeAll(['pub:head', 'full:head']); } catch (err) { /* ignore */ }
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
// sender：用回報員密碼送的話是名單上的名字；管理員密碼是空字串
function write_(records, createOnly, sender) {
  var sh = getSheet_();
  var idx = keyIndex_(sh);
  var updates = [], appends = [], n = 0, changed = [];
  records.forEach(function (r) {
    var rows = recordRows_(r);
    var firstRow = idx.map[rows[0][COL.key]];
    if (firstRow && (createOnly || idx.ms[firstRow] >= (r.updatedAt || 0))) return; // 已存在，或雲端比較新
    if (firstRow && idx.ms[firstRow] > 0) changed.push({ r: r, rows: rows }); // 蓋掉填過的數字 → 記到「修改記錄」
    rows.forEach(function (row) {
      var at = idx.map[row[COL.key]];
      if (at) updates.push({ row: at, values: row }); else appends.push(row);
    });
    n++;
  });
  if (changed.length) { try { logChanges_(sh, idx, changed, sender); } catch (err) { /* 記錄失敗不擋票數寫入 */ } }
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

/* ---------- 修改記錄 ---------- */
// 一列 = 一次「蓋掉原本數字」的送出。被亂改時，照「改之前」那一欄重新填回去就好。

function describe_(status, pairs, invalid) {
  return status + '｜' + pairs.map(function (p) { return p[0] + '號' + p[1] + ' ' + p[2]; }).join('、') + '｜無效票 ' + invalid;
}

function logChanges_(sh, idx, changed, sender) {
  var all = sh.getRange(2, 1, sh.getLastRow() - 1, HEADER.length).getValues(); // 寫入前的樣子
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  var out = [];
  changed.forEach(function (c) {
    var oldPairs = [], oldInvalid = '', first = null, blank = true;
    c.rows.forEach(function (row) {
      var at = idx.map[row[COL.key]];
      if (!at) return;
      var old = all[at - 2];
      if (!first) first = old;
      if (old[COL.votes] !== '') blank = false;
      if (old[COL.no] === '無效') oldInvalid = old[COL.votes] === '' ? 0 : old[COL.votes];
      else oldPairs.push([old[COL.no], old[COL.name], old[COL.votes] === '' ? 0 : old[COL.votes]]);
    });
    if (!first) return;
    if (blank && first[COL.status] === STATUS_LABEL.pending) return; // 歸零後第一次填，沒有蓋掉任何數字
    var r = c.r;
    var newPairs = (r.cands || []).map(function (x) { return [x.no, x.name, Number(r.votes && r.votes[x.no]) || 0]; });
    var before = describe_(first[COL.status], oldPairs, oldInvalid);
    var after = describe_(STATUS_LABEL[r.status] || '未開票', newPairs, Number(r.invalid) || 0);
    if (before === after) return; // 數字和狀態都一樣（例如重送），不用記
    out.push([now, sender || ((r.by || '沒填名字') + '（共用密碼）'), r.id, r.venue, r.raceLabel, before, after,
      first[COL.by] || '', first[COL.time] || '']);
  });
  if (!out.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lg = ss.getSheetByName(LOG);
  if (!lg) {
    lg = ss.insertSheet(LOG);
    lg.getRange(1, 1, 1, LOG_HEADER.length).setValues([LOG_HEADER]);
    lg.getRange(1, 1, 1, LOG_HEADER.length).setFontWeight('bold').setBackground('#dcefe8');
    lg.setFrozenRows(1);
    lg.getRange(2, 3, MAX_ROWS, 1).setNumberFormat('@'); // 編號保留 0001 的前導零
  }
  lg.getRange(lg.getLastRow() + 1, 1, out.length, LOG_HEADER.length).setValues(out);
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
    .addSeparator()
    .addItem('回報員名單：產生每個人的密碼和連結', 'setupRoster')
    .addToUi();
}

/* ---------- 回報員名單（每人一組密碼） ---------- */

// 6 碼純數字。第一碼不是 0（免得試算表把開頭的 0 吃掉），也不出 111111、123456 這種一猜就中的。
function newPass_() {
  for (;;) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    var p = String(100000 + parseInt(hex.substr(0, 12), 16) % 900000);
    if (/^(\d)\1+$/.test(p) || '0123456789'.indexOf(p) >= 0 || '9876543210'.indexOf(p) >= 0) continue;
    return p;
  }
}

function setupRoster() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ROSTER);
  if (!sh) {
    sh = ss.insertSheet(ROSTER);
    sh.getRange(1, 1, 1, ROSTER_HEADER.length).setValues([ROSTER_HEADER]);
    sh.getRange(1, 1, 1, ROSTER_HEADER.length).setFontWeight('bold').setBackground('#dcefe8');
    sh.setFrozenRows(1);
    sh.getRange(2, 2, 500, 1).setNumberFormat('@'); // 密碼存成文字
    sh.getRange(2, 3, 200, 1).insertCheckboxes();
    sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 120); sh.setColumnWidth(3, 170); sh.setColumnWidth(4, 520);
    ss.setActiveSheet(sh);
    ui.alert('已建立「回報員」分頁',
      '1. 在「名字」欄，一列填一位回報員的名字。\n'
      + '2. 填完後，再按一次「開票工具 → 回報員名單：產生每個人的密碼和連結」。\n'
      + '3. 把每個人的「專屬連結」私訊給本人，他點一下就能回報，不用打密碼。\n\n'
      + '這個分頁只有能打開這份試算表的人看得到。', ui.ButtonSet.OK);
    return;
  }
  var last = sh.getLastRow();
  if (last < 2) { ui.alert('名單還是空的。\n請先在「名字」欄填上回報員的名字，再按一次。'); return; }
  var rng = sh.getRange(2, 1, last - 1, 4), vals = rng.getValues();
  var used = {}, made = 0, people = 0, dup = [], short = [];
  vals.forEach(function (row) { var p = String(row[1]).trim(); if (p) used[p] = (used[p] || 0) + 1; });
  vals.forEach(function (row, i) {
    var name = String(row[0]).trim(), pass = String(row[1]).trim();
    if (!name) { row[3] = ''; return; }
    people++;
    if (!pass) {
      do { pass = newPass_(); } while (used[pass]);
      used[pass] = 1; row[1] = pass; made++;
    } else if (pass.length < PASS_MIN) short.push(name);
    else if (used[pass] > 1) dup.push(name);
    row[3] = pass.length >= PASS_MIN ? SITE_URL + '#k=' + encodeURIComponent(pass) : '';
  });
  if (!people) { ui.alert('名單還是空的。\n請先在「名字」欄填上回報員的名字，再按一次。'); return; }
  rng.setValues(vals);
  try { CacheService.getScriptCache().remove('roster'); } catch (err) { /* ignore */ }
  var msg = '名單共 ' + people + ' 人，這次新產生 ' + made + ' 組密碼。\n\n'
    + '把每個人的「專屬連結」私訊給本人（不要貼在群組）。\n'
    + '要停掉某個人：在「停用」那一欄打勾，立刻生效。';
  if (short.length) msg += '\n\n⚠ 這些人的密碼少於 ' + PASS_MIN + ' 個字，不會生效（把密碼清空再按一次，會自動產生）：\n' + short.join('、');
  if (dup.length) msg += '\n\n⚠ 這些人的密碼和別人重複（把其中一個清空再按一次）：\n' + dup.join('、');
  ui.alert('完成', msg, ui.ButtonSet.OK);
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
    if (n && !dryRun) { rng.setValues(vals); cacheClear_(); }
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
