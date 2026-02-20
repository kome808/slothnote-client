/**
 * notion-sync.js
 * 同步 notes/ 下 notion_synced: false 的筆記到 Notion Database
 *
 * 用法：
 * NOTION_TOKEN=... NOTION_DATABASE_ID=... node scripts/notion-sync.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const MAX_RICH_TEXT = 1800;
const MAX_BLOCKS = 500;
const LEGACY_NOTION_VERSION = "2022-06-28";
const MODERN_NOTION_VERSION = "2025-09-03";

const ROOT = path.join(__dirname, "..");
const NOTES_DIR = path.join(ROOT, "notes");
const MAPPING_PATH = path.join(ROOT, "config", "notion-mapping.json");

let notionToken = process.env.NOTION_TOKEN || "";

function loadMapping() {
  if (!fs.existsSync(MAPPING_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8"));
}

function loadDatabaseId() {
  if (process.env.NOTION_DATABASE_ID) {
    return process.env.NOTION_DATABASE_ID;
  }
  const mapping = loadMapping();
  return mapping.databaseId || "";
}

function loadDataSourceId() {
  if (process.env.NOTION_DATA_SOURCE_ID) {
    return process.env.NOTION_DATA_SOURCE_ID;
  }
  const mapping = loadMapping();
  return mapping.dataSourceId || "";
}

let notionDatabaseId = loadDatabaseId();
let notionDataSourceId = loadDataSourceId();
let runtimeParentPageId = "";
let useDataSource = Boolean(notionDataSourceId && !isPlaceholder(notionDataSourceId));

function isPlaceholder(value) {
  return !value || String(value).includes("replace-with-");
}

function shouldDisableDataSource(error) {
  const msg = String(error?.message || "");
  return msg.includes("Notion API 404") && (msg.includes("data source") || msg.includes("Could not find"));
}

async function loadRuntimeNotionConfigFromWorker() {
  const workerBaseUrl = process.env.WORKER_BASE_URL || "";
  const workerApiKey = process.env.WORKER_CLIENT_API_KEY || process.env.WORKER_INTERNAL_API_KEY || "";
  const workerHeaderName = process.env.WORKER_CLIENT_API_KEY ? "x-client-key" : "x-api-key";
  const lineUserId = process.env.LINE_USER_ID || "";
  if (!workerBaseUrl || !workerApiKey) return false;

  const url = new URL(`${workerBaseUrl.replace(/\/$/, "")}/client/notion-runtime`);
  if (lineUserId) url.searchParams.set("line_user_id", lineUserId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { [workerHeaderName]: workerApiKey },
  });
  if (!response.ok) {
    const text = await response.text();
    console.warn(`⚠️ 從 Worker 讀取 Notion 綁定設定失敗 (${response.status}): ${text}`);
    return false;
  }

  const payload = await response.json();
  if (payload.notionToken) {
    notionToken = payload.notionToken;
  }
  if (payload.databaseId) {
    notionDatabaseId = payload.databaseId;
  }
  if (payload.dataSourceId) {
    notionDataSourceId = payload.dataSourceId;
    useDataSource = true;
  }
  if (payload.parentPageId) {
    runtimeParentPageId = payload.parentPageId;
  }
  return true;
}

function walkMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith("_")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseScalar(value) {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 5);
  const frontmatter = {};

  for (const line of raw.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) continue;

    if (value.startsWith("[") && value.endsWith("]")) {
      try {
        frontmatter[key] = JSON.parse(value);
      } catch {
        frontmatter[key] = [];
      }
      continue;
    }

    frontmatter[key] = parseScalar(value);
  }

  return { frontmatter, body };
}

function stringifyValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "null";
  return `"${String(value).replace(/"/g, "\\\"")}"`;
}

function buildMarkdown(frontmatter, body) {
  const lines = [
    "---",
    `title: ${stringifyValue(frontmatter.title || "")}`,
    `url: ${stringifyValue(frontmatter.url || "")}`,
    `source: ${stringifyValue(frontmatter.source || "web")}`,
    `date: ${frontmatter.date || new Date().toISOString().slice(0, 10)}`,
    `category: ${stringifyValue(frontmatter.category || "uncategorized")}`,
    `tags: ${JSON.stringify(frontmatter.tags || [])}`,
    `importance: ${Number(frontmatter.importance || 1)}`,
    `status: ${stringifyValue(frontmatter.status || "unread")}`,
    `notion_synced: ${frontmatter.notion_synced ? "true" : "false"}`,
    "---",
  ];
  return `${lines.join("\n")}\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

function normalizeStatus(status) {
  const map = {
    unread: "未讀",
    read: "已讀",
    extended: "已延伸",
    "未讀": "未讀",
    "已讀": "已讀",
    "已延伸": "已延伸",
  };
  return map[status] || "未讀";
}

function normalizeImportance(importance) {
  const n = Math.max(1, Math.min(3, Number(importance || 1)));
  return "⭐".repeat(n);
}

const CATEGORY_ZH_MAP = {
  "ai-trends": "AI 趨勢",
  development: "開發實作",
  "product-design": "產品設計",
  "business-strategy": "商業策略",
  "career-growth": "職涯發展",
  web: "網頁與內容",
  uncategorized: "未分類",
};

function normalizeChineseCategoryName(input) {
  const raw = String(input || "").trim();
  if (!raw) return "未分類";
  if (/[㐀-鿿]/.test(raw)) return raw;
  const key = raw.toLowerCase().replace(/s+/g, "-");
  return CATEGORY_ZH_MAP[key] || "未分類";
}

function extractSection(body, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\n([\\s\\S]*?)(?=^##\\s+|$)`, "m");
  const match = body.match(pattern);
  return match ? match[1].trim() : "";
}

async function notionRequest(endpoint, method, body, options = {}) {
  const notionVersion = options.version || LEGACY_NOTION_VERSION;
  const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${notionToken}`,
      "Notion-Version": notionVersion,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Notion API ${response.status}: ${text}`);
  }

  return response.json();
}

async function findPageByUrl(url) {
  if (!url) return null;

  // 2025-09-03 升級路徑：優先支援 data_source 查詢
  if (useDataSource && notionDataSourceId) {
    try {
      const result = await notionRequest(`data_sources/${notionDataSourceId}/query`, "POST", {
        filter: {
          property: "原始連結",
          url: { equals: url },
        },
        page_size: 1,
      }, { version: MODERN_NOTION_VERSION });
      return result.results?.[0] || null;
    } catch (error) {
      if (shouldDisableDataSource(error)) {
        useDataSource = false;
        console.warn("⚠️ data_source_id 無效，已自動改用 database_id 同步。");
      } else {
        throw error;
      }
    }
  }

  const result = await notionRequest(`databases/${notionDatabaseId}/query`, "POST", {
    filter: {
      property: "原始連結",
      url: { equals: url },
    },
    page_size: 1,
  });
  return result.results?.[0] || null;
}

function textChunks(text, size = MAX_RICH_TEXT) {
  const out = [];
  const input = String(text || "");
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size));
  }
  return out.length ? out : [""];
}

function richText(content) {
  return textChunks(content).map((chunk) => ({ type: "text", text: { content: chunk } }));
}

function makeBlock(type, content) {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: richText(content),
    },
  };
}

function buildContentBlocks(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [makeBlock("heading_2", "全文內容")];

  for (const rawLine of lines) {
    if (blocks.length >= MAX_BLOCKS) break;
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("## ")) {
      blocks.push(makeBlock("heading_2", line.slice(3).trim() || " "));
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(makeBlock("heading_3", line.slice(4).trim() || " "));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      blocks.push(makeBlock("numbered_list_item", line.replace(/^\d+\.\s+/, "")));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push(makeBlock("bulleted_list_item", line.replace(/^[-*]\s+/, "")));
      continue;
    }
    if (line.startsWith(">")) {
      blocks.push(makeBlock("quote", line.replace(/^>\s?/, "")));
      continue;
    }

    blocks.push(makeBlock("paragraph", line));
  }

  if (blocks.length >= MAX_BLOCKS) {
    blocks.push(makeBlock("paragraph", "（內容較長，已於同步時截斷）"));
  }

  return blocks;
}

async function pageHasFullContentSection(pageId) {
  const result = await notionRequest(`blocks/${pageId}/children?page_size=20`, "GET");
  const children = result.results || [];
  return children.some((block) => {
    if (block.type !== "heading_2") return false;
    const text = block.heading_2?.rich_text?.map((t) => t.plain_text).join("") || "";
    return text.trim() === "全文內容";
  });
}

async function replaceFullContentSection(pageId, body) {
  const list = await notionRequest(`blocks/${pageId}/children?page_size=100`, "GET");
  const children = list.results || [];
  const startIndex = children.findIndex((block) => {
    if (block.type !== "heading_2") return false;
    const text = block.heading_2?.rich_text?.map((t) => t.plain_text).join("") || "";
    return text.trim() === "全文內容";
  });

  if (startIndex >= 0) {
    for (let i = startIndex; i < children.length; i += 1) {
      await notionRequest(`blocks/${children[i].id}`, "PATCH", { archived: true });
    }
  }

  const blocks = buildContentBlocks(body);
  for (let i = 0; i < blocks.length; i += 80) {
    await notionRequest(`blocks/${pageId}/children`, "PATCH", {
      children: blocks.slice(i, i + 80),
    });
  }
}

function buildPagePayload(frontmatter, body) {
  const summary = extractSection(body, "一句話摘要");
  const insight = extractSection(body, "AI 洞察");
  const title = frontmatter.title || "未命名筆記";
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const categoryName = normalizeChineseCategoryName(frontmatter.category_zh || frontmatter.category || "未分類");

  const parent = useDataSource && notionDataSourceId
    ? { data_source_id: notionDataSourceId }
    : { database_id: notionDatabaseId };

  return {
    parent,
    children: buildContentBlocks(body),
    properties: {
      "標題": {
        title: [{ text: { content: String(title).slice(0, 2000) } }],
      },
      "原始連結": { url: frontmatter.url || null },
      "來源": { select: { name: frontmatter.source || "web" } },
      "摘要": {
        rich_text: summary
          ? [{ text: { content: summary.slice(0, 2000) } }]
          : [],
      },
      "分類": { multi_select: [{ name: String(categoryName).slice(0, 100) }] },
      "標籤": {
        multi_select: tags.map((tag) => ({ name: String(tag).slice(0, 100) })),
      },
      "重要性": { select: { name: normalizeImportance(frontmatter.importance) } },
      "收集日期": { date: { start: String(frontmatter.date || "").slice(0, 10) || null } },
      "狀態": { select: { name: normalizeStatus(frontmatter.status) } },
      "AI 洞察": {
        rich_text: insight
          ? [{ text: { content: insight.slice(0, 2000) } }]
          : [],
      },
    },
  };
}

async function syncFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const existing = await findPageByUrl(frontmatter.url);

  if (frontmatter.notion_synced === true) {
    if (existing) {
      await replaceFullContentSection(existing.id, body);
    }
    return { skipped: true, filePath };
  }

  const payload = buildPagePayload(frontmatter, body);

  if (existing) {
    await notionRequest(`pages/${existing.id}`, "PATCH", { properties: payload.properties });
    await replaceFullContentSection(existing.id, body);
  } else {
    await notionRequest("pages", "POST", payload);
  }

  frontmatter.notion_synced = true;
  fs.writeFileSync(filePath, buildMarkdown(frontmatter, body), "utf8");

  return { skipped: false, filePath, updated: Boolean(existing) };
}

async function main() {
  await loadRuntimeNotionConfigFromWorker();

  if (isPlaceholder(notionToken)) {
    console.error("❌ 缺少 NOTION_TOKEN（可透過 LINE 綁定 Notion + WORKER_* + LINE_USER_ID 自動取得）");
    process.exit(1);
  }
  if (isPlaceholder(notionDatabaseId)) {
    console.error("❌ 缺少 NOTION_DATABASE_ID（請在 LINE 重新設定 Notion 頁面以建立資料庫）");
    process.exit(1);
  }

  // 先做本地重分類，確保既有資料會移動到較合適的分類
  const recategorize = spawnSync(process.execPath, [path.join(__dirname, "auto-categorize.js")], {
    stdio: "inherit",
  });
  if (recategorize.status !== 0) {
    console.warn("⚠️ 自動重分類未成功完成，仍繼續進行 Notion 同步。");
  }

  if (!fs.existsSync(NOTES_DIR)) {
    console.error("❌ 找不到 notes/ 目錄");
    process.exit(1);
  }

  const files = walkMarkdownFiles(NOTES_DIR);
  if (files.length === 0) {
    console.log("✅ 沒有可同步的筆記");
    return;
  }

  console.log(`🔄 準備檢查 ${files.length} 份筆記...`);

  let synced = 0;
  let skipped = 0;
  for (const file of files) {
    const result = await syncFile(file);
    if (result.skipped) {
      skipped += 1;
      continue;
    }
    synced += 1;
    const action = result.updated ? "更新" : "建立";
    console.log(`✅ ${action} Notion 頁面：${path.relative(ROOT, result.filePath)}`);
  }

  console.log("\n🎉 同步完成");
  console.log(`- 已同步：${synced}`);
  console.log(`- 已略過：${skipped}`);

  // 自動更新「文章分類」頁面架構
  const mapping = loadMapping();
  const parentPageId = process.env.NOTION_PARENT_PAGE_ID || runtimeParentPageId || mapping.parentPageId;
  if (parentPageId) {
    const categoryRefresh = spawnSync(
      process.execPath,
      [path.join(__dirname, "notion-refresh-categories.js")],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NOTION_TOKEN: notionToken,
          NOTION_DATABASE_ID: notionDatabaseId,
          NOTION_DATA_SOURCE_ID: notionDataSourceId || "",
          NOTION_PARENT_PAGE_ID: parentPageId,
        },
      }
    );
    if (categoryRefresh.status !== 0) {
      console.warn(`⚠️ Notion 分類頁更新失敗（exit=${categoryRefresh.status}），請查看上方錯誤訊息。`);
    }
  } else {
    console.log("ℹ️ 未設定 parentPageId，略過 Notion 分類頁更新。");
  }
}

main().catch((error) => {
  console.error("❌ 同步失敗:", error.message);
  process.exit(1);
});
