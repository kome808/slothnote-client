/**
 * notion-refresh-categories.js
 * 依 Notion 資料庫的實際內容，動態維護「文章分類」頁面。
 *
 * 需求：
 * 1) 分類不預建，完全依目前筆記內容產生
 * 2) 分類頁顯示：名稱、資料筆數、更新內容
 * 3) 點進分類後，使用表格方式顯示該分類文章列表
 * 4) 分類頁直接建立在指定 parent page 下（不再多一層「文章分類」）
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MAPPING_PATH = path.join(ROOT, "config", "notion-mapping.json");
const LEGACY_NOTION_VERSION = "2022-06-28";
const MODERN_NOTION_VERSION = "2025-09-03";
const MAX_PER_CATEGORY_ROWS = 200;
const CATEGORY_PAGE_SIZE = 20;

let notionToken = process.env.NOTION_TOKEN || "";

function loadMapping() {
  if (!fs.existsSync(MAPPING_PATH)) return {};
  return JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8"));
}

const mapping = loadMapping();
let databaseId = process.env.NOTION_DATABASE_ID || mapping.databaseId;
let dataSourceId = process.env.NOTION_DATA_SOURCE_ID || mapping.dataSourceId || "";
let parentPageId = process.env.NOTION_PARENT_PAGE_ID || mapping.parentPageId || "";
let useDataSource = Boolean(dataSourceId && !isPlaceholder(dataSourceId));

function isPlaceholder(value) {
  return !value || String(value).includes("replace-with-");
}

function shouldDisableDataSource(error) {
  const msg = String(error?.message || "");
  return msg.includes("Notion API 404") && (msg.includes("data source") || msg.includes("Could not find"));
}

async function loadRuntimeConfigFromWorker() {
  const workerBaseUrl = process.env.WORKER_BASE_URL || "";
  const workerApiKey = process.env.WORKER_CLIENT_API_KEY || process.env.WORKER_INTERNAL_API_KEY || "";
  const workerHeaderName = process.env.WORKER_CLIENT_API_KEY ? "x-client-key" : "x-api-key";
  const lineUserId = process.env.LINE_USER_ID || "";
  if (!workerBaseUrl || !workerApiKey) return;

  const url = new URL(`${workerBaseUrl.replace(/\/$/, "")}/client/notion-runtime`);
  if (lineUserId) url.searchParams.set("line_user_id", lineUserId);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { [workerHeaderName]: workerApiKey },
  });
  if (!response.ok) return;
  const payload = await response.json();
  if (payload.notionToken) notionToken = payload.notionToken;
  if (payload.databaseId) databaseId = payload.databaseId;
  if (payload.dataSourceId) {
    dataSourceId = payload.dataSourceId;
    useDataSource = true;
  }
  if (payload.parentPageId) parentPageId = payload.parentPageId;
}

function notionHeaders(version) {
  return {
    "Authorization": `Bearer ${notionToken}`,
    "Notion-Version": version,
    "Content-Type": "application/json",
  };
}

async function notionRequest(endpoint, method, body, options = {}) {
  const version = options.version || LEGACY_NOTION_VERSION;
  const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: notionHeaders(version),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Notion API ${response.status}: ${text}`);
  }
  return response.json();
}

async function listChildPageBlocks(pageId) {
  const result = await notionRequest(`blocks/${pageId}/children?page_size=100`, "GET");
  return (result.results || []).filter((b) => b.type === "child_page");
}

async function findOrCreateChildPage(parentId, title) {
  const children = await listChildPageBlocks(parentId);
  const exists = children.find((b) => b.child_page?.title === title);
  if (exists) return exists.id;

  const created = await notionRequest("pages", "POST", {
    parent: { page_id: parentId },
    properties: {
      title: {
        title: [{ type: "text", text: { content: title } }],
      },
    },
  });
  return created.id;
}

async function updatePageTitle(pageId, title) {
  await notionRequest(`pages/${pageId}`, "PATCH", {
    properties: {
      title: {
        title: [{ type: "text", text: { content: title } }],
      },
    },
  });
}

async function archiveAllChildren(pageId) {
  const children = await notionRequest(`blocks/${pageId}/children?page_size=100`, "GET");
  for (const block of children.results || []) {
    if (block.type === "child_page") {
      await notionRequest(`pages/${block.id}`, "PATCH", { archived: true });
      continue;
    }
    await notionRequest(`blocks/${block.id}`, "PATCH", { archived: true });
  }
}

async function archiveBlock(blockId) {
  try {
    await notionRequest(`pages/${blockId}`, "PATCH", { archived: true });
  } catch {
    await notionRequest(`blocks/${blockId}`, "PATCH", { archived: true });
  }
}

async function appendChildren(pageId, children) {
  if (!children.length) return;
  for (let i = 0; i < children.length; i += 50) {
    const chunk = children.slice(i, i + 50);
    await notionRequest(`blocks/${pageId}/children`, "PATCH", { children: chunk });
  }
}

function getTitleFromPage(page) {
  const title = page?.properties?.["標題"]?.title;
  if (!Array.isArray(title)) return "未命名文章";
  const out = title.map((t) => t.plain_text || "").join("").trim();
  return out || "未命名文章";
}

function getCategoryNames(page) {
  const values = page?.properties?.["分類"]?.multi_select;
  if (!Array.isArray(values) || values.length === 0) return ["未分類"];
  return values
    .map((v) => String(v.name || "").trim())
    .filter(Boolean);
}

function getCollectionDate(page) {
  const date = page?.properties?.["收集日期"]?.date?.start;
  if (date) return String(date).slice(0, 10);
  return String(page.last_edited_time || page.created_time || "").slice(0, 10);
}

function getSummary(page) {
  const richText = page?.properties?.["摘要"]?.rich_text;
  if (!Array.isArray(richText)) return "";
  const text = richText.map((t) => t.plain_text || "").join("").trim();
  return text;
}


function getAiInsight(page) {
  const richText = page?.properties?.["AI 洞察"]?.rich_text;
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text || "").join("").trim();
}

function getTags(page) {
  const tags = page?.properties?.["標籤"]?.multi_select;
  if (!Array.isArray(tags)) return "";
  return tags.map((t) => String(t.name || "").trim()).filter(Boolean).join("、");
}

function notionPageUrlFromId(id) {
  return `https://www.notion.so/${String(id || "").replace(/-/g, "")}`;
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

function normalizeCategoryName(name) {
  const out = String(name || "").replace(/\s+/g, " ").trim();
  if (!out) return "未分類";
  if (/[\u3400-\u9fff]/.test(out)) return out;
  const key = out.toLowerCase().replace(/\s+/g, "-");
  return CATEGORY_ZH_MAP[key] || "未分類";
}

function buildCategoryInsightBlocks(rows) {
  if (!rows.length) {
    return [makeParagraph("目前尚無內容，待新文章同步後再產生洞察。")];
  }

  const sourceCount = new Map();
  const titleTokens = new Map();
  const summaryTokens = new Map();
  const stopwords = new Set(["的", "與", "和", "在", "是", "了", "及", "並", "to", "for", "and", "the", "a", "an"]);

  const collectTokens = (input, targetMap) => {
    const tokens = String(input || "")
      .toLowerCase()
      .replace(/[^㐀-鿿a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && t.length >= 2 && !stopwords.has(t));
    for (const token of tokens) {
      targetMap.set(token, (targetMap.get(token) || 0) + 1);
    }
  };

  for (const row of rows) {
    const source = String(row.source || "web");
    sourceCount.set(source, (sourceCount.get(source) || 0) + 1);
    collectTokens(row.title, titleTokens);
    collectTokens(row.summary, summaryTokens);
  }

  const topSource = [...sourceCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const hotTitleTopics = [...titleTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  const hotSummaryTopics = [...summaryTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  const newest = rows.slice(0, 3).map((r) => `${r.collectionDate}：${truncateText(r.title, 34)}`);
  const oldest = rows.slice(-3).map((r) => `${r.collectionDate}：${truncateText(r.title, 34)}`);

  const compareCommon = hotSummaryTopics.length ? hotSummaryTopics.join("、") : (hotTitleTopics.length ? hotTitleTopics.join("、") : "目前資料不足");
  const compareDifferent = rows.length >= 4
    ? `近期文章較聚焦「${hotTitleTopics[0] || "主題A"}」，早期文章較偏向「${hotTitleTopics[1] || "主題B"}」。`
    : "目前篇數較少，先持續收集可提升比較精度。";

  const trendSummary = [
    `最近更新：${rows[0].collectionDate || "未知日期"}`,
    topSource ? `主要來源：${topSource[0]}（${topSource[1]} 篇）` : "主要來源：資料不足",
    `近期高頻：${hotTitleTopics.slice(0, 3).join("、") || "資料不足"}`,
  ];

  const extensionIdeas = [
    hotSummaryTopics[0]
      ? `追蹤「${hotSummaryTopics[0]}」在不同來源的實作案例，整理共通做法與失敗模式。`
      : "補充不同來源的實作案例，建立可比較的觀察維度。",
    hotSummaryTopics[1]
      ? `針對「${hotSummaryTopics[1]}」建立評估指標，將主觀判斷轉成可追蹤數據。`
      : "建立評估指標（成本/效益/風險）來比較不同做法。",
    `從近期文章延伸一個可驗證實驗：定義假設、執行步驟、觀察期限與成功條件。`,
  ];

  return [
    makeHeading("分類整合洞察"),
    makeParagraph(`近期待關注：本分類共 ${rows.length} 篇。`),
    makeParagraph(`近期文章：${newest.join("｜")}`),

    {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [textItem("觀點比較")] },
    },
    makeParagraph(`共同觀點：${compareCommon}`),
    makeParagraph(`差異觀點：${compareDifferent}`),

    {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [textItem("趨勢追蹤")] },
    },
    makeParagraph(trendSummary.join("；")),
    makeParagraph(`較早期文章：${oldest.join("｜") || "資料不足"}`),

    {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [textItem("延伸知識")] },
    },
    makeBulletedItem(extensionIdeas[0]),
    makeBulletedItem(extensionIdeas[1]),
    makeBulletedItem(extensionIdeas[2]),
  ];
}


function sortByDateDesc(a, b) {
  const da = Date.parse(a.collectionDate || "") || 0;
  const db = Date.parse(b.collectionDate || "") || 0;
  return db - da;
}

async function queryAllNotes() {
  const notes = [];
  let hasMore = true;
  let nextCursor = undefined;

  while (hasMore) {
    const body = {
      sorts: [{ property: "收集日期", direction: "descending" }],
      page_size: 100,
      ...(nextCursor ? { start_cursor: nextCursor } : {}),
    };

    let result;
    if (useDataSource && dataSourceId) {
      try {
        result = await notionRequest(`data_sources/${dataSourceId}/query`, "POST", body, {
          version: MODERN_NOTION_VERSION,
        });
      } catch (error) {
        if (shouldDisableDataSource(error)) {
          useDataSource = false;
          console.warn("⚠️ data_source_id 無效，分類頁刷新改用 database_id。");
          result = await notionRequest(`databases/${databaseId}/query`, "POST", body);
        } else {
          throw error;
        }
      }
    } else {
      result = await notionRequest(`databases/${databaseId}/query`, "POST", body);
    }

    notes.push(...(result.results || []));
    hasMore = Boolean(result.has_more);
    nextCursor = result.next_cursor;
  }

  return notes;
}

function buildCategoryMap(notes) {
  const categoryMap = new Map();

  for (const note of notes) {
    const row = {
      id: note.id,
      title: getTitleFromPage(note),
      url: note.url || notionPageUrlFromId(note.id),
      source: note?.properties?.["來源"]?.select?.name || "web",
      collectionDate: getCollectionDate(note),
      aiInsight: getAiInsight(note),
      summary: getSummary(note),
      tags: getTags(note),
    };

    const categoryNames = getCategoryNames(note);
    for (const rawName of categoryNames) {
      const name = normalizeCategoryName(rawName);
      if (!categoryMap.has(name)) categoryMap.set(name, []);
      categoryMap.get(name).push(row);
    }
  }

  for (const [name, rows] of categoryMap.entries()) {
    rows.sort(sortByDateDesc);
    categoryMap.set(name, rows);
  }

  return categoryMap;
}

function textItem(content, link = null) {
  return {
    type: "text",
    text: {
      content: String(content || ""),
      link: link ? { url: link } : null,
    },
  };
}

function makeParagraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [textItem(text)],
    },
  };
}

function makeHeading(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [textItem(text)],
    },
  };
}

function makeBulletedItem(text, link = null) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [textItem(text, link)],
    },
  };
}


function makeTableBlock(tableWidth, rows = []) {
  return {
    object: "block",
    type: "table",
    table: {
      table_width: tableWidth,
      has_column_header: true,
      has_row_header: false,
      children: rows,
    },
  };
}

function makeTableRow(cells) {
  return {
    object: "block",
    type: "table_row",
    table_row: {
      cells: cells.map((cell) => [textItem(cell)]),
    },
  };
}

function makeLinkedTableRow(cells) {
  return {
    object: "block",
    type: "table_row",
    table_row: {
      cells: cells.map((cell) => {
        if (typeof cell === "object" && cell !== null) {
          return [textItem(cell.text, cell.link || null)];
        }
        return [textItem(cell)];
      }),
    },
  };
}

function chunkRows(rows, size = CATEGORY_PAGE_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out.length ? out : [[]];
}

function buildPaginationLabel(pageNo, totalPages) {
  return `第 ${pageNo} / ${totalPages} 頁`;
}

function truncateText(text, max = 44) {
  const input = String(text || "").trim();
  if (!input) return "";
  return input.length > max ? `${input.slice(0, max)}…` : input;
}

async function appendTablePage(pageId, tableWidth, headerRow, dataRows, pageNo, totalPages) {
  const blocks = [
    {
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [textItem(buildPaginationLabel(pageNo, totalPages))] },
    },
  ];
  const tableBlock = makeTableBlock(tableWidth, [headerRow, ...dataRows]);
  blocks.push(tableBlock);
  await appendChildren(pageId, blocks);
}

async function updateCategoryPage(pageId, categoryName, rows) {
  await archiveAllChildren(pageId);

  const latest = rows[0] || null;
  const updateSummary = latest
    ? `${latest.collectionDate} 新增「${truncateText(latest.title, 28)}」`
    : "目前沒有文章";

  const header = [
    makeHeading(`分類：${categoryName}（${rows.length}）`),
    makeParagraph(`資料筆數：${rows.length}`),
    makeParagraph(`更新內容：${updateSummary}`),
    ...buildCategoryInsightBlocks(rows),
  ];

  await appendChildren(pageId, header);

  const limitedRows = rows.slice(0, MAX_PER_CATEGORY_ROWS);
  const pages = chunkRows(limitedRows, CATEGORY_PAGE_SIZE);

  const tableHeader = makeTableRow(["標題", "AI 洞察", "來源", "分類", "摘要", "收集日期", "標籤"]);
  await appendChildren(pageId, [makeParagraph("以下用表格分頁列出本分類文章（每頁 20 筆）")]);
  for (let i = 0; i < pages.length; i += 1) {
    const pageRows = pages[i];
    const tableRows = [];
    for (const row of pageRows) {
      tableRows.push(makeLinkedTableRow([
        { text: truncateText(row.title, 40), link: row.url },
        truncateText(row.aiInsight, 50),
        row.source || "web",
        categoryName,
        truncateText(row.summary, 46),
        row.collectionDate || "",
        truncateText(row.tags, 36),
      ]));
    }
    await appendTablePage(pageId, 7, tableHeader, tableRows, i + 1, pages.length);
  }
  return updateSummary;
}

async function findChildPageByTitle(parentId, title) {
  const children = await listChildPageBlocks(parentId);
  return children.find((b) => (b.child_page?.title || "").trim() === title) || null;
}

async function findCategoryPageByBaseName(parentId, categoryName) {
  const children = await listChildPageBlocks(parentId);
  return (
    children.find((b) => normalizeCategoryPageTitle(b.child_page?.title || "") === categoryName) ||
    null
  );
}

async function main() {
  await loadRuntimeConfigFromWorker();

  if (isPlaceholder(notionToken)) {
    console.error("❌ 缺少 NOTION_TOKEN");
    process.exit(1);
  }

  if (isPlaceholder(databaseId)) {
    console.error("❌ 缺少 NOTION_DATABASE_ID");
    process.exit(1);
  }
  if (isPlaceholder(parentPageId)) {
    console.log("ℹ️ 未設定 NOTION_PARENT_PAGE_ID，略過分類頁更新。");
    process.exit(0);
  }

  console.log(`INFO category refresh database_id: ${databaseId}`);
  const notes = await queryAllNotes();
  const categoryMap = buildCategoryMap(notes);
  const legacyRoot = await findChildPageByTitle(parentPageId, "文章分類");
  if (legacyRoot) {
    await archiveBlock(legacyRoot.id);
    console.log("ℹ️ 已移除舊版中介頁「文章分類」。");
  }

  const categoryNames = [...categoryMap.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));

  for (const categoryName of categoryNames) {
    const rows = categoryMap.get(categoryName) || [];
    const pageTitle = `${categoryName}（${rows.length}）`;
    const existingCategoryPage = await findCategoryPageByBaseName(parentPageId, categoryName);
    const pageId = existingCategoryPage
      ? existingCategoryPage.id
      : await findOrCreateChildPage(parentPageId, pageTitle);

    if (existingCategoryPage && (existingCategoryPage.child_page?.title || "") !== pageTitle) {
      await updatePageTitle(pageId, pageTitle);
    }

    const legacyTablePage = await findChildPageByTitle(parentPageId, `${categoryName}（表格）`);
    if (legacyTablePage) {
      await archiveBlock(legacyTablePage.id);
    }
    await updateCategoryPage(pageId, categoryName, rows);
  }

  console.log("✅ Notion 動態分類頁已更新");
  console.log(`- 分類頁父層：${parentPageId}`);
  console.log(`- 分類數：${categoryNames.length}`);
}

main().catch((error) => {
  const msg = String(error?.message || "");
  const isDb404 = msg.includes("Notion API 404") && msg.includes("Could not find database with ID");
  if (isDb404) {
    console.warn("⚠️ 分類頁更新略過：目前綁定的 database_id 無法存取。");
    console.warn("請在 LINE 重新執行：設定 Notion 頁面 你的 Notion 頁面網址，之後再同步一次。");
    process.exit(0);
  }
  console.error("❌ 更新 Notion 分類頁失敗:", msg);
  process.exit(1);
});
