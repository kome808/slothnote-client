# SlothNote 工作流程（給 AI 助理）

當使用者輸入「整理筆記」時，請執行：

1. `node scripts/pull-pending.js`
2. 讀取 `notes/_pending.json`
3. 若有新連結：逐篇整理並寫入 `notes/`
4. 若沒有新連結：仍要繼續（不可直接結束）
5. `node scripts/auto-categorize.js`
6. 若有處理新連結再執行：`node scripts/mark-done.js`
7. 一律執行：`npm run notion:sync`

目的：
- 確保本機 `notes/` 與 Notion 一致
- 補上 Notion 缺漏頁面
- 回填既有 Notion 頁面欄位
- 更新分類頁（預設表格）
