/**
 * mark-done.js
 * 將 notes/_pending.json 中已處理項目標記為完成
 * - url 項目：可直接標記
 * - file 項目：需要 local_file_path 存在，且會帶 processed_file_ids
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

function fileProcessed(item) {
  if (String(item.itemType || item.item_type || "").toLowerCase() !== "file") return false;
  const p = item.local_file_path;
  return Boolean(p && fs.existsSync(p));
}

async function markDone() {
  if (!lineUserId) {
    await inferLineUserId();
  }

  const pendingPath = path.join(__dirname, "..", "notes", "_pending.json");

  if (!fs.existsSync(pendingPath)) {
    console.log("⚠️ 找不到 _pending.json，沒有需要標記的項目");
    return;
  }

  const items = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  if (!Array.isArray(items) || items.length === 0) {
    console.log("✅ 沒有需要標記的項目");
    return;
  }

  const ids = items.map((item) => item.id).filter((id) => typeof id === "string" && id);
  const processedFileIds = items
    .filter((item) => fileProcessed(item))
    .map((item) => item.id)
    .filter((id) => typeof id === "string" && id);

  if (ids.length === 0) {
    console.log("⚠️ _pending.json 沒有有效 id，略過標記");
    return;
  }

  console.log(`🔄 標記 ${ids.length} 個項目為已完成...\n`);

  const endpoint = useClientApi ? "/client/mark-done" : "/internal/mark-done";
  const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [authHeaderName]: authKey,
    },
    body: JSON.stringify({
      ids,
      line_user_id: lineUserId,
      processed_file_ids: processedFileIds,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`標記失敗 (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];

  if (rejected.length > 0) {
    const remain = items.filter((item) => rejected.includes(item.id));
    fs.writeFileSync(pendingPath, JSON.stringify(remain, null, 2), "utf8");
    console.log(`⚠️ 有 ${rejected.length} 個檔案項目未完成處理，已保留在 _pending.json`);
    console.log(`✅ 已標記完成：${payload.updated || 0}`);
    return;
  }

  fs.writeFileSync(pendingPath, JSON.stringify([], null, 2), "utf8");
  console.log(`✅ 已標記 ${payload.updated ?? ids.length} 個項目為完成`);
}

markDone().catch((error) => {
  console.error(`❌ ${error?.message || error}`);
  process.exit(1);
});
