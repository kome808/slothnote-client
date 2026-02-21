/**
 * pull-pending.js
 * 從 Cloudflare Worker 拉取待處理項目（url + file），並寫入 notes/_pending.json
 * 檔案項目會先下載到 notes/_inbox/files/
 *
 * 支援：
 * - 一般使用者：WORKER_CLIENT_API_KEY（走 /client/*）
 * - 管理端測試：WORKER_INTERNAL_API_KEY（走 /internal/*）
 */

const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const envPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key]) continue;
    let val = m[2] || "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadEnvLocal();

const workerBaseUrl = process.env.WORKER_BASE_URL;
const workerClientApiKey = process.env.WORKER_CLIENT_API_KEY;
const workerInternalApiKey = process.env.WORKER_INTERNAL_API_KEY;
const authKey = workerClientApiKey || workerInternalApiKey;
const useClientApi = Boolean(workerClientApiKey);
const authHeaderName = useClientApi ? "x-client-key" : "x-api-key";
let lineUserId = process.env.LINE_USER_ID;

if (!workerBaseUrl) {
  console.error("❌ 缺少 WORKER_BASE_URL");
  process.exit(1);
}

if (!authKey) {
  console.error("❌ 缺少 WORKER_CLIENT_API_KEY 或 WORKER_INTERNAL_API_KEY");
  process.exit(1);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function upsertEnvLocalLineUserId(value) {
  if (!value) return;
  const envPath = path.join(__dirname, "..", ".env.local");
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (/^LINE_USER_ID=/m.test(content)) {
    content = content.replace(/^LINE_USER_ID=.*$/m, `LINE_USER_ID="${value}"`);
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `LINE_USER_ID="${value}"\n`;
  }
  fs.writeFileSync(envPath, content, "utf8");
}

function sanitizeFileName(input) {
  const base = String(input || "file.bin")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return base || "file.bin";
}

async function inferLineUserId() {
  const endpoint = useClientApi ? "/client/bootstrap-line-user" : "/internal/bootstrap-line-user";
  const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "GET",
    headers: {
      [authHeaderName]: authKey,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`推斷 LINE_USER_ID 失敗 (${response.status}): ${text}`);
  }
  const payload = await response.json();
  if (payload.lineUserId) {
    console.log(`ℹ️ 已自動推斷 LINE_USER_ID（來源：${payload.source}）`);
    lineUserId = payload.lineUserId;
    upsertEnvLocalLineUserId(lineUserId);
    return;
  }
  throw new Error("缺少 LINE_USER_ID，且無法自動推斷。請先在 LINE 輸入「我的ID」，再執行 npm run setup:start。");
}

async function fetchPendingItems() {
  const endpoint = useClientApi ? "/client/pending" : "/internal/pending";
  const url = new URL(`${workerBaseUrl.replace(/\/$/, "")}${endpoint}`);
  if (lineUserId) url.searchParams.set("line_user_id", lineUserId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      [authHeaderName]: authKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`拉取失敗 (${response.status}): ${text}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.links)) {
    return payload.links.map((x) => ({ ...x, itemType: "url" }));
  }
  return [];
}

async function requestFileDownload(fileId) {
  const prefix = useClientApi ? "/client/file-download/" : "/internal/file-download/";
  const url = new URL(`${workerBaseUrl.replace(/\/$/, "")}${prefix}${encodeURIComponent(fileId)}`);
  if (lineUserId) url.searchParams.set("line_user_id", lineUserId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      [authHeaderName]: authKey,
      ...(lineUserId ? { "x-line-user-id": lineUserId } : {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`取得檔案下載連結失敗 (${response.status}): ${text}`);
  }
  return response.json();
}

async function downloadFileToInbox(item, filesDir) {
  const fileId = item.fileId || item.file_id || item?.file?.file_id;
  if (!fileId) {
    return { ok: false, reason: "missing_file_id" };
  }

  const meta = await requestFileDownload(fileId);
  const fileName = sanitizeFileName(meta.file_name || item.fileName || item.file_name || item?.file?.file_name || `${fileId}.bin`);
  const localPath = path.join(filesDir, `${fileId}-${fileName}`);

  const response = await fetch(meta.download_url, { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`下載檔案失敗 (${response.status}): ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(localPath, Buffer.from(arrayBuffer));

  return {
    ok: true,
    fileId,
    fileName,
    mimeType: meta.mime_type || item.mimeType || item.mime_type || item?.file?.mime_type || "application/octet-stream",
    sizeBytes: Number(meta.size_bytes || item.sizeBytes || item.size_bytes || item?.file?.size_bytes || arrayBuffer.byteLength),
    localPath,
  };
}

async function pullPending() {
  if (!lineUserId) {
    await inferLineUserId();
  }

  console.log("🔄 從 Cloudflare Worker 拉取待處理項目...\n");

  const notesDir = path.join(__dirname, "..", "notes");
  const inboxDir = path.join(notesDir, "_inbox");
  const filesDir = path.join(inboxDir, "files");
  ensureDir(notesDir);
  ensureDir(inboxDir);
  ensureDir(filesDir);

  const items = await fetchPendingItems();
  const normalized = [];
  let fileDownloadedCount = 0;

  for (const item of items) {
    const itemType = String(item.itemType || item.item_type || (item.url ? "url" : "file")).toLowerCase();

    if (itemType === "file") {
      try {
        const dl = await downloadFileToInbox(item, filesDir);
        normalized.push({
          ...item,
          itemType: "file",
          downloaded: dl.ok,
          local_file_path: dl.localPath || null,
          file_id: dl.fileId || item.fileId || item.file_id || item?.file?.file_id || null,
          file_name: dl.fileName || item.fileName || item.file_name || item?.file?.file_name || null,
          mime_type: dl.mimeType || item.mimeType || item.mime_type || item?.file?.mime_type || null,
          size_bytes: dl.sizeBytes || item.sizeBytes || item.size_bytes || item?.file?.size_bytes || null,
        });
        if (dl.ok) fileDownloadedCount += 1;
      } catch (error) {
        normalized.push({
          ...item,
          itemType: "file",
          downloaded: false,
          download_error: String(error?.message || error),
          local_file_path: null,
        });
      }
      continue;
    }

    normalized.push({
      ...item,
      itemType: "url",
    });
  }

  const pendingPath = path.join(notesDir, "_pending.json");
  fs.writeFileSync(pendingPath, JSON.stringify(normalized, null, 2), "utf8");

  if (normalized.length === 0) {
    console.log("✅ 沒有待處理項目！");
  } else {
    const urlCount = normalized.filter((x) => x.itemType === "url").length;
    const fileCount = normalized.filter((x) => x.itemType === "file").length;
    console.log(`📋 找到 ${normalized.length} 個待處理項目（連結 ${urlCount}、檔案 ${fileCount}）\n`);

    normalized.forEach((item, i) => {
      if (item.itemType === "file") {
        const status = item.downloaded ? "已下載" : "下載失敗";
        console.log(`   ${i + 1}. [file] ${item.file_name || item.fileName || item.file_id || item.id} (${status})`);
      } else {
        console.log(`   ${i + 1}. [${item.source || "web"}] ${item.url || ""}`);
      }
      if (item.memo) {
        console.log(`      📝 ${item.memo}`);
      }
    });

    if (fileCount > 0) {
      console.log(`\n📥 檔案下載完成：${fileDownloadedCount}/${fileCount}`);
      console.log(`📁 檔案存放：${filesDir}`);
    }
  }

  console.log(`\n✅ 已寫入 ${pendingPath}`);
  console.log("💡 提示：在 AI 對話輸入「整理筆記」即可啟動處理流程");
}

pullPending().catch((error) => {
  console.error(`❌ ${error?.message || error}`);
  process.exit(1);
});
