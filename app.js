/* 宜蘭市開票統計：純前端。資料先存在瀏覽器 localStorage，有設定 Apps Script 網址就同步到 Google 試算表。
 * 一筆紀錄 = 一個投開票所 × 一種選舉（key = "0001|mayor"），同步時各自以最後更新時間為準。 */
(() => {
  "use strict";

  const DATA = window.YILAN_DATA;
  const C = window.YILAN_CANDIDATES;
  const CFG = window.TALLY_CONFIG;
  const stations = DATA.stations;
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
  const districtIds = Object.keys(DATA.districts).map(Number).sort((a, b) => a - b);
  const villagesOf = (d) => DATA.districts[d].villages;
  const stationsOf = (d) => stations.filter((s) => s.district === d);
  const STATUS = { pending: "未開票", counting: "開票中", done: "已完成" };
  const LS_KEY = "yilan-vote-tally:v2";
  const SYNC_INTERVAL = 20000;

  /* ---------- 選舉項目 ---------- */
  // scope: all＝全市一份名單；district＝依市民代表選舉區；village＝依里
  const single = (label, seats, cands) => ({ all: { label, seats, cands } });
  const RACES = [
    { key: "mayor", label: "市長", full: "宜蘭市長", scope: "all", applies: () => true, groupOf: () => "all", groups: single("宜蘭市長", 1, C.mayor) },
    { key: "county", label: "縣長", full: "宜蘭縣長", scope: "all", applies: () => true, groupOf: () => "all", groups: single("宜蘭縣長", 1, C.county) },
    { key: "council", label: "縣議員", full: `宜蘭縣議員（${C.council.area}）`, scope: "all", applies: () => true, groupOf: () => "all", groups: single(C.council.area, C.council.seats, C.council.cands) },
    { key: "rep", label: "市民代表", full: "宜蘭市民代表", scope: "district", applies: () => true, groupOf: (s) => String(s.district),
      groups: Object.fromEntries(districtIds.map((d) => [String(d), { label: `第${d}選舉區`, seats: DATA.districts[d].seats, cands: C.rep[d] || [] }])) },
    { key: "chief", label: "里長", full: "宜蘭市里長", scope: "village", applies: () => true, groupOf: (s) => s.village,
      groups: Object.fromEntries(Object.entries(C.chief).map(([v, cs]) => [v, { label: v, seats: 1, cands: cs }])) },
    { key: "plains", label: "平地原住民議員", full: `縣議員（${C.councilPlains.area}・平地原住民）`, scope: "all", applies: (s) => s.note.includes("平地原住民"), groupOf: () => "all",
      groups: single(C.councilPlains.area + "（平地原住民）", C.councilPlains.seats, C.councilPlains.cands) },
    { key: "mountain", label: "山地原住民議員", full: `縣議員（${C.councilMountain.area}・山地原住民）`, scope: "all", applies: (s) => s.note.includes("山地原住民"), groupOf: () => "all",
      groups: single(C.councilMountain.area + "（山地原住民）", C.councilMountain.seats, C.councilMountain.cands) },
  ];
  const raceByKey = Object.fromEntries(RACES.map((r) => [r.key, r]));
  const groupOf = (race, s) => race.groups[race.groupOf(s)];
  const racesOf = (s) => RACES.filter((r) => r.applies(s) && groupOf(r, s));

  /* ---------- 小工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("zh-TW"));
  const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "–");
  const hhmm = (ms) => new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  const toInt = (v) => {
    const t = String(v ?? "").replace(/[^\d]/g, "");
    return t === "" ? null : Math.min(parseInt(t, 10), 9999999);
  };
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }
  const partyTag = (c) => (c.party ? `<small>${esc(c.party)}</small>` : "");

  /* ---------- 狀態（localStorage） ---------- */
  let state = { records: {}, dirty: {}, settings: { url: "", token: "", by: "", race: "mayor" }, lastSync: 0 };
  const rk = (id, race) => `${id}|${race}`;
  const getRec = (id, race) => state.records[rk(id, race)];
  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (raw && raw.records) state = { ...state, ...raw, settings: { ...state.settings, ...(raw.settings || {}) } };
    } catch (_) { /* 無痕模式或被封鎖時，只在記憶體內運作 */ }
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  /* ---------- 計算 ---------- */
  function calc(rec) {
    const valid = Object.values(rec?.votes || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const invalid = rec?.invalid || 0;
    return { valid, invalid, total: valid + invalid, electors: rec?.electors ?? null };
  }
  // 彙總某一種選舉在 list 這批投開票所的結果；votes 以候選人號次為 key（呼叫端要確保 list 屬於同一份候選人名單）
  function agg(race, list) {
    const a = { n: 0, done: 0, counting: 0, votes: {}, invalid: 0, valid: 0, total: 0, eSum: 0, tSum: 0 };
    for (const s of list) {
      if (!race.applies(s)) continue;
      a.n++;
      const r = getRec(s.id, race.key);
      if (!r || r.status === "pending") continue;
      r.status === "done" ? a.done++ : a.counting++;
      const k = calc(r);
      for (const [no, v] of Object.entries(r.votes || {})) a.votes[no] = (a.votes[no] || 0) + (Number(v) || 0);
      a.invalid += k.invalid; a.valid += k.valid; a.total += k.total;
      if (r.status === "done" && k.electors > 0) { a.eSum += k.electors; a.tSum += k.total; }
    }
    return a;
  }
  const raceStations = (race) => stations.filter((s) => race.applies(s));

  /* ---------- 介面狀態 ---------- */
  const ui = { tab: "entry", race: "mayor", district: 0, status: "all", q: "", visible: [], editId: null, syncing: false, error: "" };
  const curRace = () => raceByKey[ui.race];

  /* ---------- 頁首／分頁／選舉切換 ---------- */
  function initHeader() {
    $("#title").textContent = CFG.title || "宜蘭市開票統計";
    $("#subtitle").textContent = `${CFG.electionDate || ""} · ${stations.length} 個投開票所 · ${RACES.length} 種選舉`;
    $("#source").textContent = "資料來源：" + DATA.source + "；" + C.source;
    document.title = CFG.title || "宜蘭市開票統計";
    const setTop = () => document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
    setTop();
    addEventListener("resize", setTop);
    if (!raceByKey[state.settings.race]) state.settings.race = "mayor";
    ui.race = state.settings.race;
  }
  function renderRaceBar() {
    $("#raceBar").innerHTML = RACES.map((r) => {
      const a = agg(r, stations);
      return `<button type="button" data-race="${r.key}" aria-pressed="${r.key === ui.race}">${esc(r.label)}<small>${a.done}/${a.n}</small></button>`;
    }).join("");
  }
  function setTab(tab, push = true) {
    ui.tab = tab;
    for (const b of $$(".tabs [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    $("#tab-entry").hidden = tab !== "entry";
    $("#tab-overview").hidden = tab !== "overview";
    if (push) history.replaceState(null, "", "#" + tab);
    renderAll();
    scrollTo(0, 0);
  }
  function setRace(key) {
    ui.race = key;
    state.settings.race = key;
    saveState();
    renderAll();
  }

  /* ---------- 填寫頁：篩選與清單 ---------- */
  function renderSeg() {
    const race = curRace();
    const base = raceStations(race);
    const opts = [{ id: 0, label: "全部", n: base.length }, ...districtIds.map((d) => ({ id: d, label: `第${d}區`, n: base.filter((s) => s.district === d).length }))];
    $("#districtSeg").innerHTML = opts
      .map((o) => `<button type="button" data-d="${o.id}" aria-pressed="${ui.district === o.id}">${o.label}<small>${o.n} 所</small></button>`)
      .join("");
  }
  function matchStatus(s) {
    const st = getRec(s.id, ui.race)?.status || "pending";
    if (ui.status === "all") return true;
    if (ui.status === "todo") return st !== "done";
    return st === ui.status;
  }
  function matchQ(s) {
    const q = ui.q.trim();
    if (!q) return true;
    return [s.id, String(+s.id), s.name, s.village, s.address, `第${s.district}選舉區`].some((t) => t.includes(q));
  }
  function stationButton(s) {
    const r = getRec(s.id, ui.race);
    const st = r?.status || "pending";
    const k = calc(r);
    const nr = racesOf(s).filter((x) => getRec(s.id, x.key)?.status === "done").length;
    return `<li><button type="button" class="st" data-id="${s.id}">
      <span class="sid">${s.id}</span>
      <span><span class="name">${esc(s.name)}</span><br><span class="sub">鄰 ${esc(s.neighbors)} · 各項完成 ${nr}/${racesOf(s).length}</span></span>
      <span class="right"><span class="badge" data-s="${st}">${STATUS[st]}</span>${st !== "pending" ? `<span class="tot">投票 ${fmt(k.total)}</span>` : ""}</span>
    </button></li>`;
  }
  function renderList() {
    renderSeg();
    const race = curRace();
    const shown = raceStations(race).filter((s) => (ui.district === 0 || s.district === ui.district) && matchStatus(s) && matchQ(s));
    ui.visible = [];
    const html = [];
    for (const d of districtIds) {
      if (ui.district && ui.district !== d) continue;
      const all = stationsOf(d).filter((s) => race.applies(s));
      const ag = agg(race, all);
      const groups = [];
      for (const v of villagesOf(d)) {
        const rows = shown.filter((s) => s.district === d && s.village === v);
        if (!rows.length) continue;
        rows.forEach((s) => ui.visible.push(s.id));
        const g = race.scope === "village" ? race.groups[v] : null;
        groups.push(`<div class="village"><h3>${esc(v)} <small>${rows.length} 所${g ? ` · 候選人 ${g.cands.map((c) => esc(c.name)).join("、")}` : ""}</small></h3><ul class="stations">${rows.map(stationButton).join("")}</ul></div>`);
      }
      if (!groups.length) continue;
      html.push(`<section class="dist">
        <div class="dist-head">
          <h2>第${d}選舉區</h2>
          <span class="meta">應選 ${DATA.districts[d].seats} 席 · ${villagesOf(d).length} 里 · ${esc(race.label)}完成 ${ag.done}/${ag.n} 所${ag.counting ? `（開票中 ${ag.counting}）` : ""}</span>
          <div class="bar" aria-hidden="true"><i style="width:${ag.n ? (ag.done / ag.n) * 100 : 0}%"></i></div>
        </div>${groups.join("")}</section>`);
    }
    $("#list").innerHTML = html.join("") || `<p class="empty">沒有符合的投開票所</p>`;
  }

  /* ---------- 編輯視窗 ---------- */
  let edDirty = false;
  let edTouched = new Set();
  let edRace = "mayor";
  function candField(race, c, rec) {
    return `<label class="field"><span class="f-name"><span class="f-no">${esc(c.no)}</span><span class="f-who">${esc(c.name)}${partyTag(c)}</span></span>
      <input type="text" inputmode="numeric" pattern="[0-9]*" data-vote="${esc(c.no)}" value="${rec?.votes?.[c.no] ?? ""}" placeholder="0" aria-label="${esc(c.name)} 得票數"></label>`;
  }
  function racePanel(race, s) {
    const g = groupOf(race, s);
    const rec = getRec(s.id, race.key);
    const st = rec?.status || "pending";
    return `<div class="panel" data-race="${race.key}" ${race.key === edRace ? "" : "hidden"}>
      <p class="panel-title">${esc(race.full)}${race.scope !== "all" ? ` · ${esc(g.label)}` : ""} <small>應選 ${g.seats} 席 · ${g.cands.length} 人</small></p>
      <div class="status-seg" role="radiogroup" aria-label="${esc(race.label)}開票狀態">
        ${Object.entries(STATUS).map(([k, label]) => `<label><input type="radio" name="status-${race.key}" value="${k}" ${k === st ? "checked" : ""}><span>${label}</span></label>`).join("")}
      </div>
      <div class="fields">
        ${g.cands.map((c) => candField(race, c, rec)).join("") || `<p class="note">這個範圍沒有登記的候選人。</p>`}
        <label class="field sub"><span class="f-name"><span class="f-who">無效票</span></span>
          <input type="text" inputmode="numeric" pattern="[0-9]*" data-invalid value="${rec?.invalid ?? ""}" placeholder="0" aria-label="無效票"></label>
      </div>
      <dl class="calc"><div><dt>有效票</dt><dd data-c="valid">0</dd></div><div><dt>投票數</dt><dd data-c="total">0</dd></div><div><dt>投票率</dt><dd data-c="rate">–</dd></div></dl>
      <p class="warn" data-c="warn" role="alert" hidden></p>
      <label class="slim">選舉人數（選填，用來算投票率）<input type="text" inputmode="numeric" pattern="[0-9]*" data-electors value="${rec?.electors ?? ""}" placeholder="例如 1234"></label>
    </div>`;
  }
  function openEditor(id, raceKey) {
    const s = byId[id];
    if (!s) return;
    const rs = racesOf(s);
    ui.editId = id;
    edDirty = false;
    edTouched = new Set();
    edRace = rs.some((r) => r.key === raceKey) ? raceKey : rs[0].key;
    const idx = ui.visible.indexOf(id);
    const hasNext = idx >= 0 && idx < ui.visible.length - 1;
    const dlg = $("#editor");
    dlg.innerHTML = `<form class="ed" id="edForm" autocomplete="off" novalidate>
      <header>
        <div>
          <p class="eyebrow">第${s.district}選舉區 · ${esc(s.village)}</p>
          <h2 id="edTitle">${s.id} ${esc(s.name)}</h2>
          <p class="note">鄰 ${esc(s.neighbors)} · ${esc(s.address)}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="關閉">✕</button>
      </header>
      <div class="body">
        <div class="race-tabs" role="tablist" aria-label="選舉項目">
          ${rs.map((r) => { const st = getRec(id, r.key)?.status || "pending"; return `<button type="button" role="tab" data-ed-race="${r.key}" aria-selected="${r.key === edRace}"><span class="dot" data-s="${st}"></span>${esc(r.label)}</button>`; }).join("")}
        </div>
        ${rs.map((r) => racePanel(r, s)).join("")}
        <label class="slim">填表人<input type="text" data-by value="${esc(state.settings.by || "")}" placeholder="你的名字"></label>
        ${s.note ? `<p class="note">官方備註：${esc(s.note)}</p>` : ""}
      </div>
      <footer>
        <button type="button" class="btn" data-act="close">取消</button>
        <button type="button" class="btn primary" data-act="save">儲存</button>
        ${hasNext ? `<button type="button" class="btn primary" data-act="saveNext">儲存並下一所</button>` : ""}
      </footer>
    </form>`;
    if (!dlg.open) dlg.showModal();
    $$(".panel", dlg).forEach(updateCalc);
  }
  function switchEdRace(key) {
    edRace = key;
    for (const b of $$("[data-ed-race]")) b.setAttribute("aria-selected", String(b.dataset.edRace === key));
    for (const p of $$("#edForm .panel")) p.hidden = p.dataset.race !== key;
  }
  function readPanel(panel) {
    const votes = {};
    let blank = 0;
    for (const inp of $$("[data-vote]", panel)) {
      const v = toInt(inp.value);
      if (v == null) blank++;
      votes[inp.dataset.vote] = v ?? 0;
    }
    const inv = toInt($("[data-invalid]", panel).value);
    if (inv == null) blank++;
    return { votes, invalid: inv ?? 0, blank, electors: toInt($("[data-electors]", panel).value), status: $(`input[name=status-${panel.dataset.race}]:checked`, panel).value };
  }
  function updateCalc(panel) {
    if (!panel) return;
    const d = readPanel(panel);
    const valid = Object.values(d.votes).reduce((a, b) => a + b, 0);
    const total = valid + d.invalid;
    $('[data-c="valid"]', panel).textContent = fmt(valid);
    $('[data-c="total"]', panel).textContent = fmt(total);
    $('[data-c="rate"]', panel).textContent = d.electors > 0 ? pct(total, d.electors) : "–";
    const w = $('[data-c="warn"]', panel);
    if (d.electors > 0 && total > d.electors) { w.hidden = false; w.textContent = "投票數大於選舉人數，請再確認。"; } else w.hidden = true;
  }
  function saveEditor() {
    const id = ui.editId;
    const by = $("[data-by]").value.trim();
    const todo = [];
    for (const key of edTouched) {
      const panel = $(`#edForm .panel[data-race="${key}"]`);
      const d = readPanel(panel);
      if (d.status === "done" && d.blank > 0 && !confirm(`「${raceByKey[key].label}」還有 ${d.blank} 個欄位沒填（會當成 0），確定標示為「已完成」？`)) return false;
      todo.push([key, d]);
    }
    const now = Date.now();
    for (const [key, d] of todo) {
      let status = d.status;
      if (status === "pending" && (Object.values(d.votes).some((v) => v > 0) || d.invalid > 0)) status = "counting";
      state.records[rk(id, key)] = { id, race: key, votes: d.votes, invalid: d.invalid, electors: d.electors, status, by, updatedAt: now };
      state.dirty[rk(id, key)] = true;
    }
    if (by) state.settings.by = by;
    saveState();
    edDirty = false; edTouched = new Set();
    renderAll();
    toast(todo.length ? `已儲存 ${id} ${byId[id].name}（${todo.map(([k]) => raceByKey[k].label).join("、")}）` : "沒有需要儲存的變更");
    if (todo.length) syncSoon();
    return true;
  }
  function closeEditor(force = false) {
    if (!force && edDirty && !confirm("這一所有未儲存的修改，確定放棄？")) return;
    edDirty = false;
    $("#editor").close();
  }

  /* ---------- 總覽頁 ---------- */
  function sortedCands(g, votes) {
    return [...g.cands].sort((x, y) => (votes[y.no] || 0) - (votes[x.no] || 0) || x.no - y.no);
  }
  // 一份候選人得票長條圖。a = agg 的結果；title/sub 是卡片標題
  function candBlock(g, a, title, sub, compact = false) {
    const list = sortedCands(g, a.votes);
    const max = Math.max(1, ...list.map((c) => a.votes[c.no] || 0));
    const hasVotes = a.valid > 0;
    const topVal = (i) => a.votes[list[i]?.no] || 0;
    // 席次邊界同票時標「同票」，不亮領先色
    const boundaryTie = hasVotes && list.length > g.seats && topVal(g.seats - 1) === topVal(g.seats);
    const rows = list.map((c, i) => {
      const v = a.votes[c.no] || 0;
      const tied = boundaryTie && v === topVal(g.seats - 1);
      const inSeat = hasVotes && v > 0 && i < g.seats && !tied;
      return `<div class="cand-row ${inSeat ? "lead" : ""}"><span class="f-no">${esc(c.no)}</span>
        <span class="who">${esc(c.name)}${partyTag(c)}${inSeat && g.seats === 1 ? `<span class="lead-tag">領先</span>` : ""}${tied ? `<span class="tie-tag">同票</span>` : ""}</span>
        <span class="n">${fmt(v)}<small>${pct(v, a.valid)}</small></span>
        ${compact ? "" : `<span class="track" aria-hidden="true"><i style="width:${(v / max) * 100}%"></i></span>`}</div>`;
    }).join("");
    return `<section class="card ${compact ? "compact" : ""}"><h2>${title}<small>${sub}</small></h2>${rows || `<p class="note">沒有登記候選人</p>`}</section>`;
  }
  function voteCells(g, a) {
    return g.cands.map((c) => `<td>${fmt(a.votes[c.no] || 0)}</td>`).join("") + `<td>${fmt(a.invalid)}</td><td>${fmt(a.valid)}</td><td>${fmt(a.total)}</td>`;
  }
  function headCells(g) {
    return g.cands.map((c) => `<th>${esc(c.no)}號<br>${esc(c.name)}</th>`).join("") + `<th>無效票</th><th>有效票</th><th>投票數</th>`;
  }
  const progressSub = (a) => `完成 ${a.done}/${a.n} 所${a.counting ? ` · 開票中 ${a.counting}` : ""}`;

  function renderOverview() {
    const race = curRace();
    const list = raceStations(race);
    const all = agg(race, list);
    const kpis = `<div class="kpis">
      <div class="kpi"><div class="l">${esc(race.label)}・已完成開票</div><div class="v">${all.done}<span class="muted" style="font-size:18px"> / ${all.n}</span></div><div class="s">${all.counting ? `另有 ${all.counting} 所開票中 · ` : ""}${pct(all.done, all.n)}</div></div>
      <div class="kpi"><div class="l">有效票</div><div class="v">${fmt(all.valid)}</div><div class="s">含開票中的所</div></div>
      <div class="kpi"><div class="l">無效票</div><div class="v">${fmt(all.invalid)}</div><div class="s">${pct(all.invalid, all.total)} 佔投票數</div></div>
      <div class="kpi"><div class="l">投票率</div><div class="v">${all.eSum > 0 ? pct(all.tSum, all.eSum) : "–"}</div><div class="s">${all.eSum > 0 ? "依已填選舉人數的已完成所" : "尚未填選舉人數"}</div></div>
    </div>`;

    let main = "";
    if (race.scope === "all") {
      const g = race.groups.all;
      const distRows = districtIds.map((d) => {
        const l = stationsOf(d).filter((s) => race.applies(s));
        if (!l.length) return "";
        const a = agg(race, l);
        return `<tr><td>第${d}選舉區</td><td>${a.done}/${a.n}</td>${voteCells(g, a)}</tr>`;
      }).join("");
      const distTable = `<section class="card"><h2>各市民代表選舉區<small>各區內投開票所加總</small></h2><div class="tbl-wrap"><table>
        <thead><tr><th>選舉區</th><th>完成</th>${headCells(g)}</tr></thead><tbody>${distRows}
        <tr class="sum"><td>全市</td><td>${all.done}/${all.n}</td>${voteCells(g, all)}</tr></tbody></table></div></section>`;
      const villRows = districtIds.map((d) => {
        const rows = villagesOf(d).map((v) => {
          const l = stations.filter((s) => s.village === v && race.applies(s));
          if (!l.length) return "";
          const a = agg(race, l);
          return `<tr><td>${esc(v)}</td><td>${a.done}/${a.n}</td>${voteCells(g, a)}</tr>`;
        }).join("");
        return rows ? `<tr class="grp"><td colspan="${g.cands.length + 5}">第${d}選舉區</td></tr>${rows}` : "";
      }).join("");
      const villTable = `<section class="card"><h2>各里</h2><div class="tbl-wrap"><table>
        <thead><tr><th>里</th><th>完成</th>${headCells(g)}</tr></thead><tbody>${villRows}</tbody></table></div></section>`;
      main = `<div class="ov-grid"><div class="stack">${candBlock(g, all, `${esc(race.full)}・全市得票`, `${esc(progressSub(all))} · 應選 ${g.seats} 席`)}</div><div class="stack">${distTable}${villTable}</div></div>`;
    } else if (race.scope === "district") {
      main = `<div class="blocks">${districtIds.map((d) => {
        const g = race.groups[String(d)];
        const l = stationsOf(d);
        const a = agg(race, l);
        return candBlock(g, a, `第${d}選舉區`, `${esc(progressSub(a))} · 應選 ${g.seats} 席`);
      }).join("")}</div>`;
    } else {
      main = districtIds.map((d) => {
        const blocks = villagesOf(d).map((v) => {
          const g = race.groups[v];
          if (!g) return "";
          const a = agg(race, stations.filter((s) => s.village === v));
          return candBlock(g, a, esc(v), esc(progressSub(a)), true);
        }).join("");
        return `<h2 class="sec-title">第${d}選舉區 <small>${villagesOf(d).length} 里</small></h2><div class="blocks small">${blocks}</div>`;
      }).join("");
    }

    const stRows = districtIds.map((d) => {
      const rows = villagesOf(d).flatMap((v) => list.filter((s) => s.village === v)).map((s) => {
        const r = getRec(s.id, race.key);
        const g = groupOf(race, s);
        const st = r?.status || "pending";
        const k = calc(r);
        const detail = st === "pending" ? "" : sortedCands(g, r.votes || {}).map((c) => `${c.no}號${esc(c.name)} ${fmt(r.votes?.[c.no] || 0)}`).join("　");
        return `<tr><td>${s.id} ${esc(s.name)}<br><small class="muted">${esc(s.village)} 鄰${esc(s.neighbors)}</small></td><td><span class="badge" data-s="${st}">${STATUS[st]}</span></td>
          <td class="left wrap">${detail}</td><td>${st === "pending" ? "" : fmt(k.invalid)}</td><td>${st === "pending" ? "" : fmt(k.valid)}</td><td>${st === "pending" ? "" : fmt(k.total)}</td></tr>`;
      }).join("");
      return rows ? `<tr class="grp"><td colspan="6">第${d}選舉區</td></tr>${rows}` : "";
    }).join("");
    const stTable = `<details class="card"><summary>${esc(race.label)}・全部投開票所明細（${list.length} 所）</summary><div class="tbl-wrap"><table>
      <thead><tr><th>投開票所</th><th>狀態</th><th class="left">各候選人得票</th><th>無效票</th><th>有效票</th><th>投票數</th></tr></thead><tbody>${stRows}</tbody></table></div></details>`;

    const tools = `<section class="card"><h2>匯出與備份<small>含全部選舉</small></h2><div class="tools">
      <button type="button" class="btn" data-act="csv">下載明細 CSV</button>
      <button type="button" class="btn" data-act="json">下載備份 JSON</button>
      <button type="button" class="btn" data-act="import">匯入備份 JSON</button>
      <button type="button" class="btn" data-act="print">列印 / 存成 PDF</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div></section>`;
    $("#overviewRoot").innerHTML = `<div class="ov">${kpis}${main}${stTable}${tools}</div>`;
  }

  /* ---------- 匯出／匯入 ---------- */
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const csvCell = (v) => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  function exportCsv() {
    // 長表格式（一列＝一個投開票所×一種選舉×一位候選人），方便之後用樞紐分析做統計
    const head = ["編號", "市民代表選舉區", "里", "鄰別", "投開票所", "選舉", "選區／範圍", "號次", "候選人", "政黨", "得票數", "狀態", "選舉人數", "填表人", "更新時間"];
    const rows = [];
    for (const s of stations) for (const race of racesOf(s)) {
      const g = groupOf(race, s);
      const r = getRec(s.id, race.key);
      const st = r?.status || "pending";
      const common = [s.id, `第${s.district}選舉區`, s.village, s.neighbors, s.name, race.full, g.label];
      const tail = [STATUS[st]];
      const meta = [r?.electors ?? "", r?.by || "", r?.updatedAt ? new Date(r.updatedAt).toLocaleString("zh-TW", { hour12: false }) : ""];
      for (const c of g.cands) rows.push([...common, c.no, c.name, c.party, st === "pending" ? "" : r.votes?.[c.no] || 0, ...tail, ...meta]);
      rows.push([...common, "無效", "無效票", "", st === "pending" ? "" : r.invalid || 0, ...tail, ...meta]);
    }
    download(`宜蘭市開票明細_${stamp()}.csv`, "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }
  function exportJson() {
    download(`宜蘭市開票備份_${stamp()}.json`, JSON.stringify({ version: 2, exportedAt: Date.now(), records: Object.values(state.records) }, null, 1), "application/json");
  }
  function importJson(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        const n = mergeRemote(obj.records || [], true);
        saveState(); renderAll(); syncSoon();
        toast(`已匯入 ${n} 筆較新的資料`);
      } catch (_) { toast("匯入失敗：檔案格式不對"); }
    };
    rd.readAsText(file);
  }

  /* ---------- 同步（Google Apps Script） ---------- */
  const syncUrl = () => (state.settings.url || CFG.syncUrl || "").trim();
  function normalize(raw) {
    const id = String(raw.id).padStart(4, "0");
    const s = byId[id], race = raceByKey[raw.race];
    if (!s || !race || !race.applies(s)) return null;
    const g = groupOf(race, s);
    if (!g) return null;
    const votes = {};
    for (const c of g.cands) votes[c.no] = Number(raw.votes?.[c.no]) || 0;
    return { id, race: race.key, votes, invalid: Number(raw.invalid) || 0, electors: raw.electors == null || raw.electors === "" ? null : Number(raw.electors),
      status: STATUS[raw.status] ? raw.status : "pending", by: raw.by || "", updatedAt: Number(raw.updatedAt) || 0 };
  }
  function mergeRemote(list, markDirty = false) {
    let n = 0;
    for (const raw of list) {
      const r = normalize(raw);
      if (!r || !r.updatedAt) continue; // 雲端空白列
      const key = rk(r.id, r.race);
      const l = state.records[key];
      if (!l || r.updatedAt > (l.updatedAt || 0)) {
        state.records[key] = r;
        if (markDirty) state.dirty[key] = true; else delete state.dirty[key];
        n++;
      }
    }
    return n;
  }
  function wire(rec) {
    const s = byId[rec.id], race = raceByKey[rec.race], g = groupOf(race, s);
    return { ...rec, raceLabel: race.full, group: g.label, district: s.district, village: s.village, venue: `${s.id} ${s.name}`, neighbors: s.neighbors,
      cands: g.cands.map((c) => ({ no: c.no, name: c.name })) };
  }
  async function post(payload) {
    const res = await fetch(syncUrl(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), redirect: "follow" });
    return res.json();
  }
  async function getAll() {
    const res = await fetch(syncUrl() + (syncUrl().includes("?") ? "&" : "?") + "action=all&t=" + Date.now(), { redirect: "follow" });
    return res.json();
  }
  async function syncNow() {
    if (!syncUrl() || ui.syncing) return;
    ui.syncing = true; ui.error = ""; renderChip();
    try {
      const keys = Object.keys(state.dirty).filter((k) => state.records[k]);
      if (keys.length) {
        if (!state.settings.token) throw new Error("NO_TOKEN");
        const sent = keys.map((k) => [k, state.records[k].updatedAt]);
        const res = await post({ action: "upsertMany", token: state.settings.token, records: keys.map((k) => wire(state.records[k])) });
        if (!res.ok) throw new Error(res.error || "上傳失敗");
        for (const [k, at] of sent) if (state.records[k].updatedAt === at) delete state.dirty[k];
      }
      const res = await getAll();
      if (!res.ok) throw new Error(res.error || "讀取失敗");
      const n = mergeRemote(res.records || []);
      state.lastSync = Date.now();
      if (n) renderAll();
    } catch (e) {
      ui.error = e.message === "NO_TOKEN" ? "NO_TOKEN" : e.message || "同步失敗";
    } finally {
      ui.syncing = false; saveState(); renderChip();
    }
  }
  let syncTimer;
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 600); }
  function renderChip() {
    const chip = $("#syncChip");
    const pending = Object.keys(state.dirty).length;
    let text, st = "";
    if (!syncUrl()) { text = pending ? `僅存本機（${pending} 筆）` : "僅存本機"; }
    else if (ui.syncing) { text = "同步中…"; st = "busy"; }
    else if (ui.error === "NO_TOKEN") { text = `待輸入同步密碼（${pending} 筆未上傳）`; st = "warn"; }
    else if (ui.error) { text = `同步失敗${pending ? `，${pending} 筆待傳` : ""}`; st = "warn"; }
    else if (pending) { text = `${pending} 筆待上傳`; st = "warn"; }
    else { text = state.lastSync ? `已同步 ${hhmm(state.lastSync)}` : "已連線"; st = "ok"; }
    chip.textContent = text;
    chip.dataset.state = st;
    chip.title = ui.error && ui.error !== "NO_TOKEN" ? ui.error : "";
  }

  /* ---------- 設定視窗 ---------- */
  function openSettings() {
    const s = state.settings;
    const dlg = $("#settings");
    dlg.innerHTML = `<form class="ed" id="stForm" autocomplete="off" novalidate>
      <header><div><p class="eyebrow">設定</p><h2 id="stTitle">雲端同步與個人設定</h2></div>
        <button type="button" class="icon-btn" data-act="stClose" aria-label="關閉">✕</button></header>
      <div class="body settings-form">
        <label class="slim">你的名字（會記在每筆資料的填表人）<input type="text" id="stBy" value="${esc(s.by)}" placeholder="例如 小明"></label>
        <h3>Google 試算表同步</h3>
        <p class="note">沒填網址就只存在這支手機／這台電腦的瀏覽器裡。設定步驟見 README。</p>
        <label class="slim">Apps Script 網址（結尾是 /exec）<input type="url" id="stUrl" value="${esc(s.url || CFG.syncUrl || "")}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="slim">同步密碼（填表人才需要；只想看總覽可留空）<input type="password" id="stToken" value="${esc(s.token)}" autocomplete="off"></label>
        <p class="msg" id="stMsg" role="status"></p>
        <div class="row"><button type="button" class="btn" data-act="stTest">測試連線</button><button type="button" class="btn" data-act="stInit">初始化雲端表格</button></div>
        <h3>資料</h3>
        <button type="button" class="btn danger wide" data-act="stWipe">清除這台裝置上的所有資料</button>
        <p class="note">清除只影響這個瀏覽器；已同步到 Google 試算表的資料不會被刪除。</p>
      </div>
      <footer><button type="button" class="btn" data-act="stClose">取消</button><button type="button" class="btn primary" data-act="stSave">儲存設定</button></footer>
    </form>`;
    dlg.showModal();
  }
  const readSettings = () => ({ url: $("#stUrl").value.trim(), token: $("#stToken").value, by: $("#stBy").value.trim() });
  function stMsg(text, kind = "") { const m = $("#stMsg"); m.textContent = text; m.className = "msg " + kind; }
  async function settingsAction(act) {
    if (act === "stClose") return $("#settings").close();
    if (act === "stSave") {
      state.settings = { ...state.settings, ...readSettings() };
      saveState(); $("#settings").close(); renderChip(); toast("設定已儲存");
      if (syncUrl()) syncNow();
      return;
    }
    if (act === "stWipe") {
      if (!confirm("確定清除這台裝置上的所有開票資料？此動作無法復原（若有同步，雲端資料仍在）。")) return;
      state.records = {}; state.dirty = {}; saveState(); renderAll(); $("#settings").close(); toast("已清除本機資料");
      return;
    }
    const cur = readSettings();
    state.settings = { ...state.settings, ...cur };
    saveState();
    if (!syncUrl()) return stMsg("請先填 Apps Script 網址", "err");
    try {
      stMsg("連線中…");
      if (act === "stTest") {
        const res = await getAll();
        stMsg(res.ok ? `連線成功，雲端目前有 ${(res.records || []).filter((r) => r.updatedAt).length} 筆已填資料。` : res.error || "連線失敗", res.ok ? "ok" : "err");
      } else if (act === "stInit") {
        if (!cur.token) return stMsg("初始化需要同步密碼", "err");
        const records = [];
        for (const s of stations) for (const race of racesOf(s)) {
          records.push(wire({ id: s.id, race: race.key, votes: {}, invalid: 0, electors: null, status: "pending", by: "", updatedAt: 0 }));
        }
        const res = await post({ action: "init", token: cur.token, records, summary: RACES.flatMap((r) => Object.values(r.groups).map((g) => ({ race: r.full, group: g.label, seats: g.seats, cands: g.cands.map((c) => ({ no: c.no, name: c.name, party: c.party })) }))) });
        stMsg(res.ok ? `已建立 ${res.rows} 列明細與「彙總」分頁。` : res.error || "初始化失敗", res.ok ? "ok" : "err");
      }
    } catch (e) {
      stMsg("連線失敗：" + (e.message || e) + "（網址是否正確、部署時是否選「任何人」可存取？）", "err");
    }
  }

  /* ---------- 事件 ---------- */
  function renderAll() {
    renderRaceBar();
    if (ui.tab === "overview") renderOverview(); else renderList();
    renderChip();
  }
  function bind() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.closest(".tabs") && t.dataset.tab) return setTab(t.dataset.tab);
      if (t.closest("#raceBar")) return setRace(t.dataset.race);
      if (t.dataset.edRace) return switchEdRace(t.dataset.edRace);
      if (t.closest("#districtSeg")) { ui.district = Number(t.dataset.d); return renderList(); }
      if (t.classList.contains("st")) return openEditor(t.dataset.id, ui.race);
      if (t.id === "btnSettings" || t.id === "syncChip") return openSettings();
      const act = t.dataset.act;
      if (!act) return;
      if (act === "close") return closeEditor();
      if (act === "save") return void (saveEditor() && closeEditor(true));
      if (act === "saveNext") {
        const next = ui.visible[ui.visible.indexOf(ui.editId) + 1];
        if (saveEditor() && next) openEditor(next, ui.race);
        return;
      }
      if (act === "csv") return exportCsv();
      if (act === "json") return exportJson();
      if (act === "import") return $("#importFile").click();
      if (act === "print") return print();
      if (act.startsWith("st")) return settingsAction(act);
    });
    document.addEventListener("input", (e) => {
      const t = e.target;
      if (t.id === "q") { ui.q = t.value; return renderList(); }
      if (t.matches("[data-vote],[data-invalid],[data-electors]")) {
        const clean = t.value.replace(/[^\d０-９]/g, "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        if (clean !== t.value) t.value = clean;
      }
      const panel = t.closest("#edForm .panel");
      if (panel) { edDirty = true; edTouched.add(panel.dataset.race); updateCalc(panel); }
      else if (t.closest("#edForm") && !t.matches("[data-by]")) edDirty = true;
    });
    document.addEventListener("change", (e) => {
      if (e.target.id === "statusFilter") { ui.status = e.target.value; renderList(); }
      if (e.target.id === "importFile" && e.target.files[0]) { importJson(e.target.files[0]); e.target.value = ""; }
      const panel = e.target.closest("#edForm .panel");
      if (panel && e.target.type === "radio") { edDirty = true; edTouched.add(panel.dataset.race); }
    });
    $("#editor").addEventListener("cancel", (e) => { if (edDirty) { e.preventDefault(); closeEditor(); } });
    $("#editor").addEventListener("focusin", (e) => { if (e.target.matches("[data-vote],[data-invalid],[data-electors]")) setTimeout(() => e.target.select?.(), 0); });
    addEventListener("hashchange", () => { const h = location.hash.slice(1); if ((h === "entry" || h === "overview") && h !== ui.tab) setTab(h, false); });
    addEventListener("online", syncSoon);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
    setInterval(() => { if (!document.hidden) syncNow(); }, SYNC_INTERVAL);
  }

  /* ---------- 啟動 ---------- */
  loadState();
  initHeader();
  bind();
  const h = location.hash.slice(1);
  setTab(h === "entry" || h === "overview" ? h : matchMedia("(min-width: 900px)").matches ? "overview" : "entry", false);
  if (syncUrl()) syncNow();
})();
