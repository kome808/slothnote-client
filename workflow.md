# SlothNote 工作流程（給 AI 助理）

## 觸發語句

當使用者輸入「整理筆記」時，請執行完整流程：

1. `node scripts/pull-pending.js`
2. 讀取 `notes/_pending.json`
3. 若有新連結：先 `npm run fetch:fulltext -- <url>` 抓整頁內容，再逐篇整理並寫入 `notes/`
4. 若有處理新連結且已寫入 `notes/*.md`，執行：`node scripts/clear-raw.js`（清除 `_raw` 暫存）
5. 不論是否有新連結，皆必須執行：`npm run reconcile:notion`
6. 若有處理新連結，且確認檔案已寫入 `notes/`，再執行：`node scripts/mark-done.js`

當使用者輸入「同步筆記」或「再次同步」時，請執行同步補齊模式：

1. `npm run reconcile:notion`
2. 回報補齊結果
3. 不可執行 `node scripts/mark-done.js`

禁止行為：
- 不可只回覆「沒有待整理連結」就結束。

目的：
- 同步本機新筆記到 Notion
- 回填既有 Notion 頁面欄位（僅完整同步模式）
- 更新分類頁（預設表格）
- 保留使用者在 Notion 手動刪除的決定（預設不自動重建）
