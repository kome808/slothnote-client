---
description: 初次使用者設定導引，建立本機環境檔並引導完成 LINE + Notion 綁定
---

# 開始設定（詳細版）

當使用者輸入「開始設定」，請依序執行下面流程。

## 回覆格式約束（必須遵守）

1. 不得顯示任何本機絕對路徑（例如使用者姓名、雲端硬碟路徑）。
2. 不得宣稱「已從舊專案自動遷移」除非本回合真的執行了可驗證的遷移步驟並回報依據。
3. 完成訊息只能使用通用描述，例如：
   - 「已完成基本設定」
   - 「已寫入 `.env.local`」
   - 「下一步請在 LINE 輸入：綁定 Notion」

## A. 先確認角色

1. 管理者（系統擁有者、第一次部署）
2. 一般使用者（只想開始用）

> 一般使用者不需要進 Notion 開發者後台。只有管理者需要做 OAuth 一次性設定。

## B. 管理者一次性設定（只做一次）

### B-1. Notion Public Integration

1. 建立 Public Integration
2. OAuth Redirect URI 設定為：
   `https://noteflow-worker.kome808.workers.dev/auth/notion/callback`
3. 取得 `client_id`、`client_secret`

### B-2. 寫入 Worker secrets

```bash
npx wrangler secret put NOTION_CLIENT_ID
npx wrangler secret put NOTION_CLIENT_SECRET
npx wrangler secret put NOTION_OAUTH_REDIRECT_URI
npx wrangler secret put APP_BASE_URL
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler deploy
```

### B-3. 完成條件

- LINE 輸入 `綁定 Notion` 可以收到授權連結
- 點開授權連結可成功回到 callback 頁

## C. 一般使用者設定（每位使用者各做一次）

### C-1. 本機初始化

先在 LINE 官方帳號輸入：`開始設定`，取得 8 碼配對碼（10 分鐘有效）。
一般使用者不需要安裝任何 auto-skill 或額外插件。

```bash
node scripts/start-setup.js
```

腳本只會要求你貼上配對碼，會自動寫入：
- WORKER_BASE_URL
- WORKER_CLIENT_API_KEY
- LINE_USER_ID

### C-2. LINE 綁定流程

依序輸入：

1. `綁定 Notion`
2. 完成授權
3. `設定 Notion 頁面 你的 Notion 頁面網址`
4. `綁定狀態`

### C-3. 開始使用

在 AI 對話輸入：

`整理筆記`

## D. 常見錯誤排查

1. LINE 顯示「系統尚未完成 Notion OAuth 設定」
- 代表管理者尚未完成 B 段設定。

2. Notion 授權後失敗
- 檢查 Redirect URI 是否完全一致（含 https、路徑、大小寫）。

3. 綁定成功但無法同步
- 重新輸入：`設定 Notion 頁面 頁面網址`
- 再輸入：`綁定狀態` 確認。

4. 使用者擔心資料外流
- 說明整理流程在使用者本機 AI Coding 工具執行，可自行檢視與調整 workflow。
