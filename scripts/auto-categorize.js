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
  const lines = [
    "---",
    `title: ${stringifyValue(frontmatter.title || "")}`,
    `url: ${stringifyValue(frontmatter.url || "")}`,
    `source: ${stringifyValue(frontmatter.source || "web")}`,
    `date: ${frontmatter.date || new Date().toISOString().slice(0, 10)}`,
    `category: ${stringifyValue(frontmatter.category || "uncategorized")}`,
    `category_zh: ${stringifyValue(frontmatter.category_zh || "未分類")}`,
    `tags: ${JSON.stringify(frontmatter.tags || [])}`,
    `importance: ${Number(frontmatter.importance || 1)}`,
    `status: ${stringifyValue(frontmatter.status || "unread")}`,
    `notion_synced: ${frontmatter.notion_synced ? "true" : "false"}`,
    "---",
  ];
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

function detectCategoryName(frontmatter, body) {
  const zh = normalizeCategoryName(frontmatter.category_zh);
  if (zh && zh !== "未分類") return zh;

  const rawCategory = normalizeCategoryName(frontmatter.category);
  if (rawCategory && rawCategory !== "uncategorized") {
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
