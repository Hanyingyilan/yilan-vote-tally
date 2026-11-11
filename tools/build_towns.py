#!/usr/bin/env python3
"""把官方資料整理成網站用的各鄉鎮市資料檔 data/towns/<代碼>.js（一個鄉鎮市一個檔）。

要多開一個鄉鎮市：
  1. 在下面的 TOWNS 加一筆（代碼、各代表選舉區的應選名額）。
  2. 下載該鄉鎮市的村里長候選人檔到 tools/source/candidates/cand_V1_10002_10002<代碼>.json
     （網址：https://info.cec.gov.tw/vote2026/static/json/cand/V1/10002/10002<代碼>.json）
  3. 執行 python3 tools/build_towns.py
  4. 在 index.html 加一行 <script src="data/towns/<代碼>.js"></script>

資料來源：
  投開票所：宜蘭縣選舉委員會 115.08.31 公告 投開票所設置地點一覽表（全縣）
    https://web.cec.gov.tw/ilec/article/64288  → tools/source/stations_115.ods
  代表選舉區與應選名額：宜蘭縣選舉委員會 115.08.20 公告（宜選一字第 1153150107 號）附表
    https://web.cec.gov.tw/ilec/article/63595
  候選人：中央選舉委員會選舉專區 https://info.cec.gov.tw/vote2026/ 「找候選人」的公開資料
    /static/json/cand/C1/10002.json   縣長
    /static/json/cand/T/10002.json    縣議員
    /static/json/cand/D1/10002.json   鄉（鎮、市）長
    /static/json/cand/R/10002.json    鄉（鎮、市）民代表（含各選舉區包含哪些村里）
    /static/json/cand/V1/10002/10002<代碼>.json  村里長
    /static/json/dist/10002_deptLi.json          村里代碼 → 名稱

候選人名單會因資格審查、撤銷等異動；正式開票前請重新下載再執行一次。
只用標準函式庫，不需安裝任何套件。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "source"
CAND = SRC / "candidates"
OUT_DIR = ROOT / "data" / "towns"

# 代碼＝中選會的 deptCode；seats＝各代表選舉區應選名額，依第1、第2…選舉區的順序（取自 115.08.20 公告附表）
TOWNS = {
    "宜蘭市": {"code": "010", "seats": [4, 4, 5, 3]},
    "礁溪鄉": {"code": "050", "seats": [5, 1, 2, 3]},
}
# 還沒開的鄉鎮市（公告附表的應選名額先記在這裡，要開的時候搬到上面）：
#   羅東鎮 020 [2,2,4,5]　蘇澳鎮 030 [1,2,3,5]　頭城鎮 040 [3,4,2,2]　壯圍鄉 060 [4,2,2,3]
#   員山鄉 070 [4,3,3,1]　冬山鄉 080 [3,3,2,3]　五結鄉 090 [2,2,3,2,2]　三星鄉 100 [2,2,4,3]
#   大同鄉 110 [1,2,1,3]　南澳鄉 120 [3,2,1,1]

FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
NS_T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
NS_X = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"


def load(name):
    return json.loads((CAND / name).read_text(encoding="utf-8"))


def read_rows(path):
    root = ET.fromstring(zipfile.ZipFile(path).read("content.xml"))
    rows = []
    for tr in root.iter(NS_T + "table-row"):
        cells = []
        for c in tr:
            if c.tag not in (NS_T + "table-cell", NS_T + "covered-table-cell"):
                continue
            text = "".join("".join(p.itertext()) for p in c.iter(NS_X + "p"))
            repeat = min(int(c.get(NS_T + "number-columns-repeated", "1")), 20)
            cells += [text.strip()] * repeat
        while cells and not cells[-1]:
            cells.pop()
        if cells:
            rows.append(cells)
    return rows


def cand(c):
    party = (c.get("party") or "").strip()
    return {"no": c["candNo"], "name": c["name"].strip(), "party": "" if party in ("無", "") else party}


def ordered(cs):
    out = sorted((cand(c) for c in cs), key=lambda c: c["no"])
    nos = [c["no"] for c in out]
    assert len(nos) == len(set(nos)), f"號次重複：{nos}"
    return out


def labels_for(town, unit):
    level = town[-1]  # 市／鎮／鄉
    return {
        "head": f"{level}長",          # 市長／鎮長／鄉長
        "rep": f"{level}民代表",        # 市民代表／鎮民代表／鄉民代表
        "chief": f"{unit}長",          # 里長／村長
        "unit": unit,                  # 里／村
        "whole": f"全{level}",          # 全市／全鎮／全鄉
    }


def build(town, cfg, rows, shared):
    code = cfg["code"]
    li_names = {l["liCode"]: l["liName"] for d in shared["deptLi"] if d["deptCode"] == code for l in d["lis"]}
    assert li_names, f"{town}：找不到村里名單"

    # 代表選舉區：哪些村里、應選幾席
    rep_src = next(d for d in shared["R"] if d["deptCode"] == code)
    areas = sorted(rep_src["areas"], key=lambda a: int(a["areaCode"]))
    assert len(areas) == len(cfg["seats"]), f"{town}：代表選舉區數（{len(areas)}）和應選名額設定（{len(cfg['seats'])}）對不上"
    districts, rep, village_to_district = {}, {}, {}
    for a, seats in zip(areas, cfg["seats"]):
        n = int(a["areaCode"])
        villages = [li_names[c] for c in a["lis"]]
        districts[str(n)] = {"seats": seats, "villages": villages}
        rep[str(n)] = ordered(a["cands"])
        for v in villages:
            village_to_district[v] = n
    assert set(village_to_district) == set(li_names.values()), f"{town}：有村里沒被分到代表選舉區"

    # 投開票所
    stations = []
    for r in rows:
        m = re.fullmatch(rf"宜蘭縣{town}第(\d{{4}})投開票所", r[0])
        if not m:
            continue
        sid = m.group(1)
        name, address, village, neighbors = r[1], r[2], r[3], r[4]
        note = r[5] if len(r) > 5 else ""
        if village not in village_to_district:
            sys.exit(f"{town}：找不到 {village} 所屬的代表選舉區（第 {sid} 投開票所）")
        stations.append({
            "id": sid,
            "name": name,
            "address": address.replace(f"宜蘭縣{town}", "", 1).translate(FULLWIDTH_DIGITS),
            "village": village,
            "neighbors": neighbors,
            "district": village_to_district[village],
            "note": note,
        })
    stations.sort(key=lambda s: s["id"])
    ids = [int(s["id"]) for s in stations]
    assert ids and ids == list(range(ids[0], ids[0] + len(ids))), f"{town}：投開票所編號不連續"
    used = {s["village"] for s in stations}
    assert not set(village_to_district) - used, f"{town}：這些村里沒有任何投開票所：{set(village_to_district) - used}"

    # 候選人
    general = [a for a in shared["T"] if code in (a.get("depts") or []) and a["voterType"] == "01"]
    assert len(general) == 1, f"{town}：應該只屬於一個縣議員一般選舉區"
    mayor = ordered([c for c in shared["D1"] if c.get("deptCode") == code])
    chief = {}
    for c in load(f"cand_V1_10002_10002{code}.json")["V1"]:
        chief.setdefault(li_names[c["liCode"]], []).append(c)
    chief = {k: ordered(v) for k, v in sorted(chief.items())}
    missing, extra = used - set(chief), set(chief) - used
    if missing or extra:
        sys.exit(f"{town}：村里長候選人與投開票所的村里對不上：缺 {missing}；多 {extra}")

    units = {v[-1] for v in used}
    assert len(units) == 1, f"{town}：村里名稱結尾不一致 {units}"
    payload = {
        "name": town,
        "code": code,
        "labels": labels_for(town, units.pop()),
        "source": "宜蘭縣選舉委員會 115.08.31 公告 投開票所設置地點一覽表；115.08.20 公告 選舉區劃分",
        "districts": districts,
        "stations": stations,
        "candidates": {
            "source": "中央選舉委員會選舉專區 info.cec.gov.tw/vote2026 候選人資料（取自 tools/source/candidates/）",
            "county": shared["county"],
            "mayor": mayor,
            "council": {"area": general[0]["areaName"], "seats": general[0]["numberElected"], "cands": ordered(general[0]["cands"])},
            "rep": rep,
            "chief": chief,
        },
    }
    out = OUT_DIR / f"{code}.js"
    out.write_text(
        "// 由 tools/build_towns.py 自動產生，請勿手動編輯\n"
        f"(window.TALLY_TOWNS = window.TALLY_TOWNS || {{}})[{json.dumps(town, ensure_ascii=False)}] = "
        + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    per = {}
    for s in stations:
        per[s["district"]] = per.get(s["district"], 0) + 1
    c = payload["candidates"]
    print(f"{town}（{code}）→ {out.relative_to(ROOT)}")
    print(f"  投開票所 {len(stations)} 所（{stations[0]['id']}–{stations[-1]['id']}），{len(used)} 個{payload['labels']['unit']}，各選舉區所數 {per}")
    print(f"  {payload['labels']['head']} {len(mayor)} 人；{payload['labels']['rep']} "
          f"{ {k: str(len(v)) + '人選' + str(districts[k]['seats']) + '席' for k, v in rep.items()} }")
    print(f"  {payload['labels']['chief']} {sum(len(v) for v in chief.values())} 人，同額競選：{[k for k, v in chief.items() if len(v) == 1]}")
    print(f"  縣議員 {c['council']['area']}：{len(c['council']['cands'])} 人選 {c['council']['seats']} 席；縣長 {len(c['county'])} 人")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = read_rows(SRC / "stations_115.ods")
    shared = {
        "deptLi": load("dist_10002_deptLi.json")["depts"],
        "R": load("cand_R_10002.json")["R"],
        "T": load("cand_T_10002.json")["T"],
        "D1": load("cand_D1_10002.json")["D1"],
        "county": ordered(load("cand_C1_10002.json")["C1"]),
    }
    for town, cfg in TOWNS.items():
        build(town, cfg, rows, shared)


if __name__ == "__main__":
    main()
