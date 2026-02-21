---
description: 批次處理待處理項目（連結 + 檔案），抓取內容、產出摘要與分類、補上全文與翻譯、同步到 Notion
---

# 整理筆記 — 自然語言批次流程

你是一個知識管理 AI 助理，任務是處理使用者透過 LINE 收集的待處理項目（連結與檔案）。
請用繁體中文輸出。

## 觸發語句

當使用者輸入任一句，直接啟動完整整理流程：

- 整理筆記
- 幫我整理今天的連結
- 開始整理待處理連結

當使用者輸入任一句，啟動同步補齊流程（只做本機↔Notion 對齊）：

- 同步筆記
- 再次同步

## A. 完整整理流程（整理筆記）

### 1. 拉取待處理項目

```bash
node scripts/pull-pending.js
```

### 2. 讀取待處理清單

讀取 `notes/_pending.json`。

- 若有待處理項目：進入第 3 步逐一整理。
- 若沒有待處理項目：跳過第 3 步，但**仍必須執行第 4～7 步**，確保本機 `notes/` 與 Notion 完整一致（補上缺漏頁面、回填欄位）。

### 3. 逐一處理每個項目（連結 / 檔案）

先判斷每筆的 `itemType` / `item_type`：

- `url`：依連結流程處理
- `file`：依檔案流程處理

#### 3a. 連結流程（url）

針對每個連結先執行：

```bash
npm run fetch:fulltext -- "<url>"
```

此步驟會產生 `notes/_raw/YYYY-MM-DD/*.json`，包含：

- `text.main`：主文候選
- `text.fullPage`：整頁可見文字

再由 LLM 依據這兩份內容判斷真正主文，避免只抓到摘要或導覽雜訊。

若抓取失敗，仍建立筆記，並標註「⚠️ 無法自動擷取全文」。

#### 3b. 檔案流程（file）

每筆 `file` 項目先檢查：

- `downloaded === true`
- `local_file_path` 存在且可讀

若任一不成立：

- 標註該項目為本次失敗（下載或路徑問題）
- **不可**建立空白筆記
- 繼續處理下一筆

若成立：

- 讀取 `local_file_path` 的內容（PDF/圖片/文件）
- 由 LLM 萃取可讀全文（可含 OCR）
- 產出與連結流程一致的摘要、重點、洞察
- 在 frontmatter 補上檔案資訊：

```yaml
source: "line-file"
original_file_path: "<local_file_path>"
file_name: "<file_name>"
mime_type: "<mime_type>"
```

#### 3c. 產生內容分析（LLM）

每篇至少產出：

- 標題
- 摘要（300 字內）
- 3 個關鍵重點
- 原文核心觀點（2-3 句）
- 中文主題分類（動態）
- 英文分類代碼（slug，例：`ai-trends`）
- 標籤（3-5 個，中文優先；專有名詞可保留原文）
- 封面圖片網址（若可取得）

#### 3d. 關聯筆記分析（摘要優先）

1. 先搜尋 `notes/` 中的 frontmatter 與 `## 摘要`。
2. 只讀候選前半段做初判。
3. 對高相關再讀全文補強洞察。

#### 3e. 寫入筆記檔案

路徑：`notes/{category_slug}/YYYY-MM-DD-{slug}.md`

```markdown
---
title: "文章標題"
url: "原始連結（若為檔案可留空）"
source: "來源平台或 line-file"
date: YYYY-MM-DD
category: "ai-trends"
category_zh: "AI 趨勢"
tags: ["標籤1", "標籤2", "標籤3"]
cover_image: "https://..."
notion_synced: false
---

## 摘要
...

## 關鍵重點
1. ...
2. ...
3. ...

## 原文核心觀點
...

## 原文全文
（由 LLM 依據抓取素材或檔案內容判斷主文後輸出）

## 中文對照翻譯
（原文非中文時，請提供段落對照翻譯；中文原文可改為重點整理）

## AI 洞察
> AI對於本篇文章的洞察分析...

## 延伸討論
（自動產生）
```

#### 3f. 延伸討論（每篇都做）

至少包含：

- 與既有筆記的呼應/矛盾
- 知識缺口
- 下一步建議

### 3g. 清理暫存全文素材（成功寫入 md 後）

每篇筆記完成並寫入 `*.md` 後，刪除 `_raw` 暫存：

```bash
node scripts/clear-raw.js
```

### 4. 更新分類索引

更新 `notes/_index.md`。

### 5. 自動重分類

```bash
node scripts/auto-categorize.js
```

### 6. 同步 Notion（含分類頁）

```bash
npm run reconcile:notion
```

這一步一定要執行（即使沒有新連結），用途：

- 同步本機新筆記（`notion_synced=false`）
- 更新分類頁表格
- 在完整同步模式下回填既有頁面的屬性欄位
- 預設不重建你在 Notion 手動刪除的頁面

### 7. 標記已完成（有處理新項目且檔案確認落地才做）

若第 3 步有實際處理項目，且筆記檔案已確認成功寫入 `notes/`，執行：

```bash
node scripts/mark-done.js
```

若沒有新項目，略過這步。

## B. 同步補齊流程（同步筆記 / 再次同步）

只執行：

```bash
npm run reconcile:notion
```

並回報補齊結果。

禁止：

- 不可執行 `node scripts/mark-done.js`
- 不可修改雲端待處理狀態

## 回報結果

列出本次處理數量、成功/失敗、主要分類與同步結果。
若本次無新項目，也要明確回報已完成「本機與 Notion 一致性補齊」。
