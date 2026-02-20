/**
 * auto-categorize.js
 * 依筆記內容動態調整分類（不依賴預設分類清單），必要時移動檔案路徑。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NOTES_DIR = path.join(ROOT, "notes");

function walkMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
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
  const orderedKeys = [
    "title",
    "url",
    "source",
    "date",
    "category",
    "category_zh",
    "tags",
    "importance",
    "status",
    "cover_image",
    "notion_synced",
  ];
  const normalized = {
    ...frontmatter,
    title: frontmatter.title || "",
    url: frontmatter.url || "",
    source: frontmatter.source || "web",
    date: frontmatter.date || new Date().toISOString().slice(0, 10),
    category: frontmatter.category || "uncategorized",
    category_zh: frontmatter.category_zh || "未分類",
    tags: frontmatter.tags || [],
    importance: Number(frontmatter.importance || 1),
    status: frontmatter.status || "unread",
    notion_synced: Boolean(frontmatter.notion_synced),
  };

  const lines = ["---"];
  const included = new Set();
  for (const key of orderedKeys) {
    if (!(key in normalized)) continue;
    lines.push(`${key}: ${stringifyValue(normalized[key])}`);
    included.add(key);
  }
  for (const key of Object.keys(normalized)) {
    if (included.has(key)) continue;
    lines.push(`${key}: ${stringifyValue(normalized[key])}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${body.startsWith("\n") ? body : `\n${body}`}`;
}


function slugifyId(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashText(input) {
  const text = String(input || "");
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

function normalizeCategoryName(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

const KEYWORD_CATEGORY_MAP = [
  { name: "AI 趨勢", terms: ["ai", "llm", "agent", "gpt", "anthropic", "openai", "模型", "人工智慧"] },
  { name: "開發實作", terms: ["程式", "開發", "工程", "api", "javascript", "typescript", "python", "cloudflare", "worker", "deploy"] },
  { name: "產品設計", terms: ["ux", "ui", "設計", "產品", "體驗", "流程", "介面"] },
  { name: "商業策略", terms: ["商業", "市場", "策略", "營運", "成長", "收入", "成本"] },
  { name: "職涯發展", terms: ["職涯", "求職", "面試", "履歷", "升遷", "管理", "招聘"] },
];

function isMachineCategoryId(value) {
  return /^cat-[a-f0-9]{6,}$/i.test(String(value || "").trim()) || /^[a-z0-9-]+$/.test(String(value || "").trim());
}

function inferCategoryFromKeywords(text) {
  const input = String(text || "").toLowerCase();
  for (const item of KEYWORD_CATEGORY_MAP) {
    if (item.terms.some((term) => input.includes(String(term).toLowerCase()))) {
      return item.name;
    }
  }
  return "";
}

function detectCategoryName(frontmatter, body) {
  const zh = normalizeCategoryName(frontmatter.category_zh);
  if (zh && zh !== "未分類") return zh;

  const rawCategory = normalizeCategoryName(frontmatter.category);
  if (rawCategory && rawCategory !== "uncategorized" && !isMachineCategoryId(rawCategory)) {
    return rawCategory.length <= 24 ? rawCategory : rawCategory.slice(0, 24);
  }

  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  const firstTag = normalizeCategoryName(tags.find((t) => normalizeCategoryName(t)));
  if (firstTag) {
    return firstTag.length <= 24 ? firstTag : firstTag.slice(0, 24);
  }

  const title = normalizeCategoryName(frontmatter.title);
  if (title) {
    const split = title.split(/[｜|:：\-—]/)[0].trim();
    if (split) return split.length <= 24 ? split : split.slice(0, 24);
  }

  const firstHeading = String(body || "").match(/^##\s+(.+)$/m)?.[1];
  const heading = normalizeCategoryName(firstHeading);
  if (heading) return heading.length <= 24 ? heading : heading.slice(0, 24);

  const inferred = inferCategoryFromKeywords([
    frontmatter.title || "",
    Array.isArray(frontmatter.tags) ? frontmatter.tags.join(" ") : "",
    String(body || "").slice(0, 1200),
  ].join(" "));
  if (inferred) return inferred;

  return "未分類";
}

function buildCategoryIdFromName(name) {
  const slug = slugifyId(name);
  if (slug) return slug;
  return `cat-${hashText(name).slice(0, 8)}`;
}

function dedupePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let i = 1;
  while (true) {
    const p = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(p)) return p;
    i += 1;
  }
}

function main() {
  const files = walkMarkdownFiles(NOTES_DIR);
  let moved = 0;
  let updated = 0;

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const nextZh = detectCategoryName(frontmatter, body);
    const nextId = buildCategoryIdFromName(nextZh);
    const currentId = slugifyId(frontmatter.category) || String(frontmatter.category || "");

    frontmatter.category = nextId;
    frontmatter.category_zh = nextZh;

    if (currentId !== nextId) {
      frontmatter.notion_synced = false;
    }

    const nextDir = path.join(NOTES_DIR, nextId);
    if (!fs.existsSync(nextDir)) fs.mkdirSync(nextDir, { recursive: true });
    let nextPath = path.join(nextDir, path.basename(filePath));
    if (path.resolve(nextPath) !== path.resolve(filePath)) {
      nextPath = dedupePath(nextPath);
      fs.writeFileSync(filePath, buildMarkdown(frontmatter, body), "utf8");
      fs.renameSync(filePath, nextPath);
      moved += 1;
      continue;
    }

    fs.writeFileSync(filePath, buildMarkdown(frontmatter, body), "utf8");
    updated += 1;
  }

  console.log("✅ 動態重分類完成");
  console.log(`- 檔案移動：${moved}`);
  console.log(`- 內容更新：${updated}`);
}

main();
