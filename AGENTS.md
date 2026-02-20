# SlothNote Agent Rules

## Natural Trigger

當使用者在對話輸入以下任一句時，視為啟動完整流程（等同舊的 `/process-links`）：

- `整理筆記`
- `幫我整理今天的連結`
- `開始整理待處理連結`

當使用者在對話輸入以下任一句時，視為啟動「同步補齊模式」：

- `同步筆記`
- `再次同步`

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
3. 若清單有連結：每篇先執行 `npm run fetch:fulltext -- <url>` 抓整頁素材，再整理（摘要、分類、關聯洞察）並寫入 `notes/{category}/YYYY-MM-DD-{slug}.md`。
4. 若清單為空：不要結束，必須繼續執行補齊流程。
5. 執行 `npm run reconcile:notion`（固定必跑，快速同步模式）。
6. 若第 3 步有新連結被處理，再執行 `node scripts/mark-done.js`；沒有新連結則略過。
7. 回覆本次整理結果（篇數、分類、失敗項目）。

### 同步補齊模式（`同步筆記` / `再次同步`）

1. 直接執行 `npm run reconcile:notion`（快速同步模式）。
2. 僅回報 Notion 補齊與修復結果。
3. 禁止執行 `node scripts/mark-done.js`。

## 強制規則

- 禁止只回覆「目前沒有待整理連結」就結束任務。
- 只要使用者輸入「整理筆記」，就必須完成本機已整理筆記的 Notion 同步。
- 只有在「已確認筆記檔案成功寫入 notes/」後，才能執行 `node scripts/mark-done.js`。
- 使用者輸入「同步筆記」或「再次同步」時，禁止拉取/標記雲端待處理狀態，只允許做 Notion 同步。

## Token 節省規則（摘要優先）

- 比對歷史筆記時，先讀 frontmatter + `## 摘要` + `## 關鍵重點`。
- 只有在高相關候選需要更深分析時，才讀取全文。
- 全文讀取數量依相關性動態調整，不設固定篇數上限。

## Required Environment

執行流程前需確保已載入：

- `WORKER_BASE_URL`
- `WORKER_CLIENT_API_KEY`
- `LINE_USER_ID`

> 若已完成 LINE 的 Notion 綁定，`notion:sync` 可自動取得 Notion 同步設定，不一定要本機 `NOTION_TOKEN`。
