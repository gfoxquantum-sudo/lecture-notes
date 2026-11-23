// What changed in each version. Shown in the app (bell on the home screen) and on the introduction page (最新消息).
// Newest first. Add an entry here with every upload; `id` counts the updates announced here (1, 2, 3…), not the cache version in sw.js.
export const UPDATES = [
  {
    id: 1, date: '2026-11-23', title: '高準確字幕、上傳錄音檔',
    items: [
      '新增「高準確字幕」：免費、不用金鑰，在你的裝置上辨識，聲音不會傳出去。瀏覽器內建辨識隔著教室會漏掉大部分內容，這個模式是為了解決它。',
      '新增「上傳錄音檔」：已經用手機或錄音筆錄好的課，在課堂頁面按「上傳錄音檔」，就會自動變成逐字稿並整理筆記（需要先下載高準確字幕的辨識模型）。上課時不用開著 App，比較省電。',
      '怎麼開：到設定的「錄音與字幕」按下載（只要一次，約 410–565 MB，建議用 Wi-Fi），之後錄音會自動使用。需要新版 Chrome 或 Edge，iPhone 和 iPad 需要 iOS 26 以上的 Safari。',
      '字幕會比教授說的晚大約半分鐘出現。',
      '逐字稿上方新增「重新辨識錄音」：用保存的錄音把整份逐字稿重新聽寫一次，不滿意可以換回舊的。',
      '新增這個「更新通知」，之後每次更新了什麼都會寫在這裡。',
    ],
  },
];
export const latestUpdate = () => (UPDATES[0] ? UPDATES[0].id : 0);
