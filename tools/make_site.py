"""做出「單一鄉鎮市」的網站資料夾（例如礁溪鄉＝ jiaoxi/），放在正式網站底下，每個鄉鎮市一個自己的網址。

    python3 tools/make_site.py <輸出資料夾> <鄉鎮市代碼> [--preview]
    例：python3 tools/make_site.py /tmp/site/jiaoxi 050

輸出的內容就是這個分支的網站，只差這幾件事：
  1. index.html 只載入那一個鄉鎮市的資料檔（畫面上不會出現其他鄉鎮市，也沒有切換選單）；
  2. 寫死在網頁裡的標題換成那個鄉鎮市（LINE、Facebook 的連結預覽只看這個）；
  3. config.js 的 syncUrl 清空，只留 syncUrls 裡這個鄉鎮市自己的試算表網址（不會連到宜蘭市的試算表）；
  4. 加 --preview 時，最上面多一條「預覽版」提示。

網址：https://hanyingyilan.github.io/yilan-vote-tally/<下面的 SLUG>/ （和 apps-script/Code.gs 的 TOWN_PATH 要一致）
"""
import re
import shutil
import sys
from pathlib import Path

SLUG = {"020": "luodong", "030": "suao", "040": "toucheng", "050": "jiaoxi", "060": "zhuangwei", "070": "yuanshan",
        "080": "dongshan", "090": "wujie", "100": "sanxing", "110": "datong", "120": "nanao"}

ROOT = Path(__file__).resolve().parent.parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
preview = "--preview" in sys.argv
out, code = Path(args[0]), args[1]
src = ROOT / "data" / "towns" / f"{code}.js"
name = re.search(r'"name":\s*"([^"]+)"', src.read_text(encoding="utf8")).group(1)

if out.exists():
    shutil.rmtree(out)
(out / "data" / "towns").mkdir(parents=True)
for f in ("app.js", "style.css"):
    shutil.copy(ROOT / f, out / f)
shutil.copy(src, out / "data" / "towns" / src.name)

html = (ROOT / "index.html").read_text(encoding="utf8")
html, n = re.subn(r'[ \t]*<script src="data/towns/(\d+)\.js[^"]*"></script>\n',
                  lambda m: m.group(0) if m.group(1) == code else "", html)
assert f"data/towns/{code}.js" in html, "index.html 裡找不到這個鄉鎮市的資料檔"
title = f"{name}開票統計"
desc = f"{name}各投開票所開票回報與即時統計。"
html, n1 = re.subn(r"<title>[^<]*</title>", f"<title>{title}</title>", html, count=1)
html, n2 = re.subn(r'<meta name="description" content="[^"]*">',
                   f'<meta name="description" content="{desc}">\n'
                   f'  <meta property="og:title" content="{title}">\n'
                   f'  <meta property="og:description" content="{desc}">\n'
                   f'  <meta property="og:site_name" content="{title}">\n'
                   '  <meta property="og:type" content="website">', html, count=1)
assert n1 == 1 and n2 == 1, "index.html 裡找不到標題或說明"
if preview:
    assert html.count("<body>\n") == 1
    html = html.replace("<body>\n", "<body>\n  <!-- 只有預覽版才有這一條 -->\n"
                        '  <div style="background:#15171c;color:#fff;text-align:center;font-size:15px;line-height:1.4;padding:4px 8px">預覽版（測試用，不是正式網站）</div>\n')
    html = html.replace("</title>", '</title>\n  <meta name="robots" content="noindex">', 1)
(out / "index.html").write_text(html, encoding="utf8")

cfg = (ROOT / "config.js").read_text(encoding="utf8")
cfg, n = re.subn(r'(\n\s*syncUrl:\s*)"[^"]*"', r'\1""', cfg)
assert n == 1, "config.js 裡找不到 syncUrl"
if f'"{name}"' not in cfg.split("syncUrls", 1)[1]:
    print(f"⚠ config.js 的 syncUrls 還沒有「{name}」的試算表網址，這個網站會顯示「未連雲端」")
(out / "config.js").write_text(cfg, encoding="utf8")
print(f"{name}的網站已產生在 {out}" + (f"　網址：https://hanyingyilan.github.io/yilan-vote-tally/{SLUG[code]}/" if code in SLUG else ""))
