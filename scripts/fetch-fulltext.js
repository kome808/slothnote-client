#!/usr/bin/env node

/**
 * fetch-fulltext.js
 * 抓取網頁全文素材（整頁與主文候選），供本機 LLM 後續判斷與整理。
 *
 * 用法：
 *   node scripts/fetch-fulltext.js "https://example.com/post"
 *   node scripts/fetch-fulltext.js "https://example.com/post" --out notes/_raw/custom.json
 */

const fs = require("fs");
const path = require("path");

function usage() {
  console.log("用法: node scripts/fetch-fulltext.js <url> [--out <file>]");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length) return null;

  let url = "";
  let out = "";

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--out") {
      out = args[i + 1] || "";
      i += 1;
      continue;
    }
    if (!url) url = a;
  }

  return { url, out };
}

function isHttpUrl(input) {
  return /^https?:\/\//i.test(String(input || "").trim());
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "note";
}

function htmlDecode(str) {
  const map = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  let out = String(str || "");
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(v);
  }
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return out;
}

function cleanHtmlToText(html) {
  let s = String(html || "");

  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  s = s.replace(/<(header|footer|nav|aside|form|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|main|h1|h2|h3|h4|h5|h6|li|ul|ol|blockquote|pre)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");

  s = htmlDecode(s);
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

function extractTagText(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i");
  const m = String(html || "").match(re);
  if (!m) return "";
  return cleanHtmlToText(m[1]);
}

function extractMeta(html, key, attr = "name") {
  const re = new RegExp(`<meta[^>]*${attr}=["']${key}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const m = String(html || "").match(re);
  if (!m) return "";
  return htmlDecode(m[1]).trim();
}

function extractCandidateBlocks(html) {
  const blocks = [];
  const patterns = [
    /<article[\s\S]*?<\/article>/gi,
    /<main[\s\S]*?<\/main>/gi,
    /<section[^>]*(content|article|post|entry|story|body)[^>]*>[\s\S]*?<\/section>/gi,
    /<div[^>]*(content|article|post|entry|story|body)[^>]*>[\s\S]*?<\/div>/gi,
  ];

  for (const pattern of patterns) {
    const matches = String(html || "").match(pattern) || [];
    for (const match of matches) {
      const text = cleanHtmlToText(match);
      if (text && text.length >= 200) {
        blocks.push(text);
      }
    }
  }

  return blocks;
}

function pickMainText(html) {
  const candidates = extractCandidateBlocks(html);
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
  }
  return cleanHtmlToText(html);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  return {
    finalUrl: response.url || url,
    status: response.status,
    html,
    source: "direct",
  };
}

async function fetchViaJina(url) {
  const readerUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
  const response = await fetch(readerUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Jina HTTP ${response.status}`);
  }

  const text = await response.text();
  const pseudoHtml = `<article>${text}</article>`;
  return {
    finalUrl: url,
    status: response.status,
    html: pseudoHtml,
    source: "jina-fallback",
  };
}

function buildOutputPath(url, explicitOut) {
  if (explicitOut) return explicitOut;
  const root = path.join(__dirname, "..", "notes", "_raw");
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, day);
  ensureDir(dir);
  return path.join(dir, `${slugify(url)}.json`);
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed || !parsed.url || !isHttpUrl(parsed.url)) {
    usage();
    process.exit(1);
  }

  const targetUrl = parsed.url.trim();
  const outPath = buildOutputPath(targetUrl, parsed.out);

  let fetched;
  let errors = [];

  try {
    fetched = await fetchHtml(targetUrl);
  } catch (err) {
    errors.push(`direct:${String(err.message || err)}`);
  }

  if (!fetched) {
    try {
      fetched = await fetchViaJina(targetUrl);
    } catch (err) {
      errors.push(`jina:${String(err.message || err)}`);
    }
  }

  if (!fetched) {
    console.error("❌ 全文抓取失敗");
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  const html = fetched.html;
  const title =
    extractMeta(html, "og:title", "property") ||
    extractMeta(html, "twitter:title", "name") ||
    extractTagText(html, "title") ||
    "未命名文章";

  const description =
    extractMeta(html, "description", "name") ||
    extractMeta(html, "og:description", "property") ||
    "";

  const byline = extractMeta(html, "author", "name") || "";
  const lang = (String(html).match(/<html[^>]*lang=["']([^"']+)["']/i) || [])[1] || "";

  const mainText = pickMainText(html);
  const fullPageText = cleanHtmlToText(html);

  const payload = {
    url: targetUrl,
    fetchedUrl: fetched.finalUrl,
    source: fetched.source,
    fetchedAt: new Date().toISOString(),
    status: fetched.status,
    title,
    description,
    byline,
    language: lang,
    text: {
      main: mainText,
      fullPage: fullPageText,
    },
    note: "請將 text.main 與 text.fullPage 交給 LLM 判斷主文，輸出摘要/全文/翻譯。",
  };

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  console.log("✅ 已抓取全文素材");
  console.log(`- title: ${title}`);
  console.log(`- source: ${fetched.source}`);
  console.log(`- out: ${outPath}`);
}

main().catch((error) => {
  console.error("❌ 抓取失敗:", String(error?.message || error));
  process.exit(1);
});
