// 開票統計網站設定。改完 commit 並 push 到 GitHub，Pages 就會更新。
// 候選人名單不在這裡設定：由 tools/build_candidates.py 從中選會公開資料產生 data/candidates.js。
window.TALLY_CONFIG = {
  // 顯示在頁首
  title: "宜蘭市開票統計",
  electionDate: "2026-11-28",

  // Google Apps Script 網頁應用程式網址（結尾是 /exec）。留空代表只存在各人的瀏覽器。
  // 設定方式見 README.md 的「串接 Google 試算表」。
  // 也可以不寫在這裡，讓每位填表人在網站右上角「設定」自己貼上。
  syncUrl: "https://script.google.com/macros/s/AKfycbzBgo2bnfROGKlWVyj_1GdBDVNykLfFr2GtVOBZZz76mkrawZSczGxO0JKyebpB4qQ7Rw/exec",
};
