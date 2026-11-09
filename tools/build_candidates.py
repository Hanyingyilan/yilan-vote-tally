#!/usr/bin/env python3
"""把中選會「115 年地方公職人員選舉」候選人 JSON 整理成網站用的 data/candidates.js。

來源：中央選舉委員會選舉專區 https://info.cec.gov.tw/vote2026/ 「找候選人」所用的公開資料
  /static/json/cand/C1/10002.json              縣長
  /static/json/cand/T/10002.json               縣議員（含平地、山地原住民選舉區）
  /static/json/cand/D1/10002.json              鄉（鎮、市）長（取宜蘭市 deptCode=010）
  /static/json/cand/R/10002.json               鄉（鎮、市）民代表（取宜蘭市 deptCode=010）
  /static/json/cand/V1/10002/10002010.json     宜蘭市村里長
  /static/json/dist/10002_deptLi.json          里代碼 → 里名

候選人名單會因資格審查、補登記、撤銷等異動；正式開票前請重新下載這幾個檔到 tools/source/candidates/
再執行：python3 tools/build_candidates.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "source" / "candidates"
OUT = ROOT / "data" / "candidates.js"
CITY = "010"  # 宜蘭市 deptCode


def load(name):
    return json.loads((SRC / name).read_text(encoding="utf-8"))


def cand(c):
    party = (c.get("party") or "").strip()
    return {"no": c["candNo"], "name": c["name"].strip(), "party": "" if party in ("無", "") else party}


def ordered(cs):
    out = sorted((cand(c) for c in cs), key=lambda c: c["no"])
    nos = [c["no"] for c in out]
    assert len(nos) == len(set(nos)), f"號次重複：{nos}"
    return out


def main():
    county = ordered(load("cand_C1_10002.json")["C1"])

    council = {a["areaCode"]: a for a in load("cand_T_10002.json")["T"]}
    # 宜蘭市屬縣議員第 1 選舉區；第 11 區＝平地原住民、第 12 區＝山地原住民（voterType 03／02）
    general = [a for a in council.values() if CITY in (a.get("depts") or []) and a["voterType"] == "01"]
    assert len(general) == 1, "宜蘭市應該只屬於一個縣議員一般選舉區"
    plains = [a for a in council.values() if a["voterType"] == "03" and CITY in (a.get("depts") or [])]
    mountain = [a for a in council.values() if a["voterType"] == "02" and CITY in (a.get("depts") or [])]
    assert len(plains) == 1 and len(mountain) == 1

    mayor = ordered([c for c in load("cand_D1_10002.json")["D1"] if c.get("deptCode") == CITY])

    rep_city = next(d for d in load("cand_R_10002.json")["R"] if d["deptCode"] == CITY)
    rep = {}
    for a in rep_city["areas"]:
        n = str(int(a["areaCode"]))
        rep[n] = ordered(a["cands"])

    li_names = {
        l["liCode"]: l["liName"]
        for d in load("dist_10002_deptLi.json")["depts"]
        if d["deptName"] == "宜蘭市"
        for l in d["lis"]
    }
    chief = {}
    for c in load("cand_V1_10002_10002010.json")["V1"]:
        chief.setdefault(li_names[c["liCode"]], []).append(c)
    chief = {k: ordered(v) for k, v in sorted(chief.items())}

    # 和投開票所資料交叉檢查
    stations_js = (ROOT / "data" / "stations.js").read_text(encoding="utf-8")
    st = json.loads(stations_js[stations_js.index("{"): stations_js.rindex("}") + 1])
    villages = {s["village"] for s in st["stations"]}
    missing = villages - set(chief)
    extra = set(chief) - villages
    if missing or extra:
        sys.exit(f"里長候選人與投開票所的里對不上：缺 {missing}；多 {extra}")
    assert set(rep) == set(st["districts"]), "市民代表選舉區和投開票所資料對不上"

    payload = {
        "source": "中央選舉委員會選舉專區 info.cec.gov.tw/vote2026 候選人資料（取自 tools/source/candidates/）",
        "county": county,
        "mayor": mayor,
        "council": {"area": general[0]["areaName"], "seats": general[0]["numberElected"], "cands": ordered(general[0]["cands"])},
        "councilPlains": {"area": plains[0]["areaName"], "seats": plains[0]["numberElected"], "cands": ordered(plains[0]["cands"])},
        "councilMountain": {"area": mountain[0]["areaName"], "seats": mountain[0]["numberElected"], "cands": ordered(mountain[0]["cands"])},
        "rep": rep,
        "chief": chief,
    }
    OUT.write_text(
        "// 由 tools/build_candidates.py 自動產生，請勿手動編輯\n"
        "window.YILAN_CANDIDATES = " + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    n = lambda xs: len(xs)
    print(f"縣長 {n(county)} 人；市長 {n(mayor)} 人；縣議員（{general[0]['areaName']}）{n(payload['council']['cands'])} 人；"
          f"平地原住民 {n(payload['councilPlains']['cands'])} 人；山地原住民 {n(payload['councilMountain']['cands'])} 人")
    print("市民代表：", {k: n(v) for k, v in rep.items()}, "共", sum(n(v) for v in rep.values()), "人")
    print("里長：", sum(n(v) for v in chief.values()), "人，", len(chief), "個里；單一候選人的里：", [k for k, v in chief.items() if len(v) == 1])


if __name__ == "__main__":
    main()
