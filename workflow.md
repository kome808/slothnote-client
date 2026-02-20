# SlothNote 工作流程（給 AI 助理）

當使用者輸入「整理筆記」時，請執行：

1. `node scripts/pull-pending.js`
2. 讀取 `notes/_pending.json`
3. 若有新連結：逐篇整理並寫入 `notes/`
4. 不論是否有新連結，皆必須執行：`npm run reconcile:notion`
5. 若有處理新連結，再執行：`node scripts/mark-done.js`

禁止行為：
- 不可只回覆「沒有待整理連結」就結束。

目的：
- 確保本機 `notes/` 與 Notion 一致
- 補上 Notion 缺漏頁面
- 回填既有 Notion 頁面欄位
- 更新分類頁（預設表格）
