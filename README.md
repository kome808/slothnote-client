# 懶人筆記 SlothNote

傳連結到 LINE，自動整理到 Notion。

產品介紹與完整教學：<https://slothnote-docs.pages.dev/>

## 這是什麼

懶人筆記是給一般使用者的知識整理流程：

1. 在網路或社群看到好文章，先把連結傳到懶人筆記 LINE 官方帳號。
2. 回到自己的 AI Coding 工具輸入「整理筆記」。
3. 系統會在你的本機整理內容，最後同步到你自己的 Notion。

重點：
- 整理流程在你自己的電腦執行。
- 每位使用者綁自己的 Notion，不會寫進他人的筆記庫。

## 新手教學

### Step 1. 安裝 AI 工具

先準備一個 AI Coding 工具：Antigravity、Codex 或 Cursor。

### Step 2. 下載專案

```bash
git clone https://github.com/kome808/slothnote-client.git
cd slothnote-client
npm install
```

### Step 3. 在 LINE 取得配對碼

到懶人筆記 LINE 官方帳號輸入：`開始設定`。

### Step 4. 在本機完成設定

```bash
npm run setup:start
```

依指示貼上 8 碼配對碼。

### Step 5. 綁定 Notion

在懶人筆記 LINE 官方帳號依序輸入：

1. `綁定 Notion`
2. 完成授權
3. `設定 Notion 頁面 你的 Notion 頁面網址`
4. `綁定狀態`（確認已綁定）

## 日常使用

1. 傳文章連結到 LINE。
2. 在 AI 工具輸入：`整理筆記`。
3. 到 Notion 查看已整理的筆記。

## 指令（需要時）

- `npm run setup:start`：重新配對與本機設定
- `node scripts/pull-pending.js`：手動抓待處理連結
- `npm run fetch:fulltext -- <url>`：先抓取整頁全文素材（給 LLM 判斷主文）
- `npm run notion:sync`：手動觸發 Notion 同步

## 注意事項

- `.env.local` 不可上傳到 GitHub。
- 若 Notion 沒同步，先在 LINE 再輸入一次：`設定 Notion 頁面 你的 Notion 頁面網址`。
- 若本機設定異常，重跑 `npm run setup:start`。
