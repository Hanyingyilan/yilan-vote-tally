"""做出「只有某幾個鄉鎮市」的預覽版資料夾（預設只有礁溪鄉），給負責人在正式上線前先試。

    python3 tools/make_preview.py <輸出資料夾> [鄉鎮市代碼 ...]
    例：python3 tools/make_preview.py /tmp/preview 050

輸出的內容就是這個分支的網站，只差三件事：
  1. index.html 只載入指定鄉鎮市的資料檔（所以畫面上不會出現其他鄉鎮市）；
  2. 最上面多一條「預覽版」提示；只有一個鄉鎮市時，連結預覽（LINE 等）的標題也換成那個鄉鎮市；
  3. config.js 的 syncUrl 清空（不會連到正式的試算表），只留 syncUrls 裡這些鄉鎮市自己的網址。
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])
codes = sys.argv[2:] or ["050"]

out.mkdir(parents=True, exist_ok=True)
for name in ("app.js", "style.css"):
    shutil.copy(ROOT / name, out / name)
(out / "data" / "towns").mkdir(parents=True, exist_ok=True)
for old in (out / "data" / "towns").glob("*.js"):
    old.unlink()
names = []
for c in codes:
    src = ROOT / "data" / "towns" / f"{c}.js"
    shutil.copy(src, out / "data" / "towns" / src.name)
    names.append(re.search(r'"name":\s*"([^"]+)"', src.read_text(encoding="utf8")).group(1))

html = (ROOT / "index.html").read_text(encoding="utf8")
html, n = re.subn(r'[ \t]*<script src="data/towns/(\d+)\.js[^"]*"></script>\n',
                  lambda m: m.group(0) if m.group(1) in codes else "", html)
assert n >= len(codes), "index.html 裡找不到鄉鎮市資料檔"
assert html.count("<body>\n") == 1
html = html.replace("<body>\n", "<body>\n  <!-- 只有預覽版才有這一條（正式網站沒有） -->\n"
                    '  <div style="background:#15171c;color:#fff;text-align:center;font-size:15px;line-height:1.4;padding:4px 8px">預覽版（測試用，不是正式網站）</div>\n')
# 只有一個鄉鎮市時，把寫死在網頁裡的標題換成那個鄉鎮市。
# LINE、Facebook 顯示連結預覽時不會執行程式，只看這裡寫的字，不換的話會顯示「宜蘭市開票統計」。
if len(names) == 1:
    title = f"{names[0]}開票統計"
    desc = f"{names[0]}各投開票所開票回報與即時統計。"
    html, n1 = re.subn(r"<title>[^<]*</title>", f"<title>{title}</title>", html, count=1)
    html, n2 = re.subn(r'<meta name="description" content="[^"]*">',
                       f'<meta name="description" content="{desc}">\n'
                       f'  <meta property="og:title" content="{title}">\n'
                       f'  <meta property="og:description" content="{desc}">\n'
                       f'  <meta property="og:site_name" content="{title}">\n'
                       '  <meta property="og:type" content="website">', html, count=1)
    assert n1 == 1 and n2 == 1, "index.html 裡找不到標題或說明"
html = html.replace("</title>", '</title>\n  <meta name="robots" content="noindex">', 1)
(out / "index.html").write_text(html, encoding="utf8")

cfg = (ROOT / "config.js").read_text(encoding="utf8")
cfg, n = re.subn(r'(\n\s*syncUrl:\s*)"[^"]*"', r'\1""', cfg)
assert n == 1, "config.js 裡找不到 syncUrl"
(out / "config.js").write_text(cfg, encoding="utf8")
print(f"預覽版已產生在 {out}：{'、'.join(names)}")
