#!/usr/bin/env python3
"""把宜蘭縣選委會公告的「投開票所設置地點一覽表」(ODS) 轉成網站用的 data/stations.js。

來源：宜蘭縣選舉委員會 115.08.31 公告
  https://web.cec.gov.tw/ilec/article/64288
市民代表選舉區：宜蘭縣選舉委員會 115.08.20 公告（宜選一字第 1153150107 號）
  https://web.cec.gov.tw/ilec/article/63595

用法：python3 tools/build_stations.py
只用標準函式庫，不需安裝任何套件。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "source" / "stations_115.ods"
OUT = ROOT / "data" / "stations.js"

# 第 23 屆宜蘭市民代表選舉區（宜選一字第 1153150107 號公告附表）
DISTRICTS = {
    1: {"seats": 4, "villages": ["民族里", "文化里", "思源里", "七結里", "建軍里", "泰山里", "負郭里", "復興里"]},
    2: {"seats": 4, "villages": ["民權里", "神農里", "大新里", "新民里", "進士里", "擺厘里", "凱旋里", "南津里", "建業里", "南橋里"]},
    3: {"seats": 5, "villages": ["東門里", "東村里", "新東里", "孝廉里", "小東里", "菜園里", "慈安里", "中興里", "成功里", "延平里", "黎明里", "七張里"]},
    4: {"seats": 3, "villages": ["中山里", "北門里", "西門里", "北津里", "新生里", "梅洲里", "南門里", "茭白里"]},
}
VILLAGE_TO_DISTRICT = {v: d for d, info in DISTRICTS.items() for v in info["villages"]}

FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")

NS_T = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
NS_X = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"


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


def main():
    stations = []
    for r in read_rows(SRC):
        m = re.fullmatch(r"宜蘭縣宜蘭市第(\d{4})投開票所", r[0])
        if not m:
            continue
        sid = m.group(1)
        name, address, village, neighbors = r[1], r[2], r[3], r[4]
        note = r[5] if len(r) > 5 else ""
        if village not in VILLAGE_TO_DISTRICT:
            sys.exit(f"找不到 {village} 所屬的市民代表選舉區（第 {sid} 投開票所）")
        stations.append({
            "id": sid,
            "name": name,
            "address": address.replace("宜蘭縣宜蘭市", "", 1).translate(FULLWIDTH_DIGITS),
            "village": village,
            "neighbors": neighbors,
            "district": VILLAGE_TO_DISTRICT[village],
            "note": note,
        })

    stations.sort(key=lambda s: s["id"])
    ids = [int(s["id"]) for s in stations]
    assert ids == list(range(ids[0], ids[0] + len(ids))), "投開票所編號不連續"
    used = {s["village"] for s in stations}
    missing = set(VILLAGE_TO_DISTRICT) - used
    assert not missing, f"這些里沒有任何投開票所：{missing}"

    payload = {
        "source": "宜蘭縣選舉委員會 115.08.31 公告 投開票所設置地點一覽表；115.08.20 公告 選舉區劃分",
        "districts": {str(k): v for k, v in DISTRICTS.items()},
        "stations": stations,
    }
    OUT.write_text(
        "// 由 tools/build_stations.py 自動產生，請勿手動編輯\n"
        "window.YILAN_DATA = " + json.dumps(payload, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    per = {}
    for s in stations:
        per[s["district"]] = per.get(s["district"], 0) + 1
    print(f"寫入 {OUT.relative_to(ROOT)}：{len(stations)} 個投開票所，{len(used)} 個里，各選區所數 {per}")


if __name__ == "__main__":
    main()
