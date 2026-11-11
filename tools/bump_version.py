"""把 index.html 裡 style.css / config.js / data/towns/*.js / app.js 的版本號換成現在時間。

每次要發布到 GitHub Pages 之前執行一次：
    python3 tools/bump_version.py
手機上已經打開的網站，會在沒有填寫、沒有未送出票數時自動重新整理成新版。
"""
import re
import time
from pathlib import Path

P = Path(__file__).resolve().parent.parent / "index.html"
html = P.read_text(encoding="utf8")
v = time.strftime("%Y%m%d%H%M%S")
html, n = re.subn(r'((?:style\.css|config\.js|data/towns/\d+\.js|app\.js))(?:\?v=[\w.-]+)?"', rf'\1?v={v}"', html)
P.write_text(html, encoding="utf8")
print(f"版本 {v}，更新 {n} 個檔案參照")
