# SlothNote Agent Rules

## Natural Trigger

當使用者在對話輸入以下任一句時，視為啟動完整流程（等同舊的 `/process-links`）：

- `整理筆記`
- `幫我整理今天的連結`
- `開始整理待處理連結`

當使用者輸入以下任一句時，啟動初始化教學：

- `開始設定`
- `開始安裝`
- `初始化`
- `setup`

初始化流程預設為：
1. 在 LINE 輸入 `開始設定` 取得配對碼
2. 在 AI 工具輸入 `開始安裝`
3. 由 `scripts/start-setup.js` 用配對碼自動寫入 `.env.local`

## Workflow (Natural Mode)

1. 執行 `node scripts/pull-pending.js` 拉取待處理連結。
2. 讀取 `notes/_pending.json`。
3. 若清單為空，回覆「目前沒有待整理連結」並結束。
4. 逐篇整理：擷取內容、摘要、分類、關聯洞察。
5. 寫入 `notes/{category}/YYYY-MM-DD-{slug}.md`。
6. 更新 `notes/_index.md`。
7. 執行 `node scripts/mark-done.js`。
8. 執行 `npm run notion:sync`。
9. `notion:sync` 內會自動：
   - 依內容動態重分類並移動舊筆記（`auto-categorize.js`）
   - 更新 Notion「文章分類」頁面（顯示分類名稱、資料筆數、更新內容，且可點入查看表格列表）
10. 回覆本次整理結果（篇數、分類、失敗項目）。

## Required Environment

執行流程前需確保已載入：

- `WORKER_BASE_URL`
- `WORKER_INTERNAL_API_KEY`
- `LINE_USER_ID`

> 若已完成 LINE 的 Notion 綁定，`notion:sync` 可自動取得 Notion 同步設定，不一定要本機 `NOTION_TOKEN`。
