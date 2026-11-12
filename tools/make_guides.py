"""把「教學-給各鄉鎮負責人.txt」換上各鄉鎮市的名稱和網址，產生可以直接貼出去的版本：教學/<鄉鎮市>.txt

    python3 tools/make_guides.py

改了教學範本之後再執行一次即可。網址的資料夾名稱和 tools/make_site.py、apps-script/Code.gs 一致。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://hanyingyilan.github.io/yilan-vote-tally/"
TOWNS = {"羅東鎮": "luodong", "蘇澳鎮": "suao", "頭城鎮": "toucheng", "礁溪鄉": "jiaoxi", "壯圍鄉": "zhuangwei", "員山鄉": "yuanshan",
         "冬山鄉": "dongshan", "五結鄉": "wujie", "三星鄉": "sanxing", "大同鄉": "datong", "南澳鄉": "nanao"}

tpl = (ROOT / "教學-給各鄉鎮負責人.txt").read_text(encoding="utf8")
assert "【網站網址】" in tpl and "○○鄉" in tpl
out = ROOT / "教學"
out.mkdir(exist_ok=True)
for town, slug in TOWNS.items():
    text = tpl.replace("【○○鄉】", town).replace("○○鄉", town).replace("【網站網址】", SITE + slug + "/")
    assert "○" not in text and "【" not in text
    (out / f"{town}.txt").write_text(text, encoding="utf8")
print(f"已產生 {len(TOWNS)} 份：{out}")
