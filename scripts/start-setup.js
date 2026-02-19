/**
 * start-setup.js
 * 非技術使用者初始化精靈：建立/更新 .env.local 並輸出下一步教學
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const ENV_LOCAL = path.join(ROOT, ".env.local");

function parseEnv(content) {
  const map = new Map();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function serializeEnv(map) {
  const lines = [];
  for (const [key, value] of map.entries()) {
    lines.push(`${key}="${String(value).replace(/"/g, "\\\"")}"`);
  }
  return `${lines.join("\n")}\n`;
}

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function claimSetup(workerBaseUrl, pairCode) {
  const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}/setup/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairCode }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`配對失敗 (${response.status}): ${text}`);
  }
  return response.json();
}

async function main() {
  console.log("=== SlothNote 開始設定 ===");

  if (!fs.existsSync(ENV_EXAMPLE)) {
    console.error("❌ 找不到 .env.example，請確認你在專案根目錄執行。");
    process.exit(1);
  }

  const envMap = fs.existsSync(ENV_LOCAL)
    ? parseEnv(fs.readFileSync(ENV_LOCAL, "utf8"))
    : parseEnv(fs.readFileSync(ENV_EXAMPLE, "utf8"));

  const rl = createRl();

  const workerBaseUrlDefault = envMap.get("WORKER_BASE_URL") || "https://noteflow-worker.kome808.workers.dev";
  const workerBaseUrl = await ask(rl, `WORKER_BASE_URL [${workerBaseUrlDefault}]: `) || workerBaseUrlDefault;
  const pairCode = await ask(rl, "請輸入 LINE 顯示的配對碼（8碼）: ");
  if (!workerBaseUrl || !pairCode) {
    console.error("❌ WORKER_BASE_URL 與配對碼必填。");
    rl.close();
    process.exit(1);
  }

  let claimed;
  try {
    claimed = await claimSetup(workerBaseUrl, pairCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`❌ ${message}`);
    console.log("\n請回到 LINE 官方帳號輸入「開始設定」取得新配對碼（10 分鐘內有效）。");
    rl.close();
    process.exit(1);
  }

  envMap.set("WORKER_BASE_URL", claimed.workerBaseUrl || workerBaseUrl);
  envMap.set("WORKER_INTERNAL_API_KEY", claimed.workerInternalApiKey || "");
  envMap.set("LINE_USER_ID", claimed.lineUserId || "");

  fs.writeFileSync(ENV_LOCAL, serializeEnv(envMap), "utf8");
  rl.close();

  console.log("\n✅ 已完成本機設定（配對成功）");
  console.log("已自動寫入：WORKER_BASE_URL、WORKER_INTERNAL_API_KEY、LINE_USER_ID");
  console.log(`設定檔：${ENV_LOCAL}`);

  if (!claimed.notionBound) {
    console.log("\n下一步（LINE 內）：");
    console.log("1) 輸入：綁定 Notion");
    console.log("2) 完成授權後輸入：設定 Notion 頁面 <你的 Notion 頁面網址>");
    console.log("3) 輸入：綁定狀態");
  } else if (!claimed.notionPageConfigured || !claimed.notionDatabaseConfigured) {
    console.log("\n你已綁定 Notion，但尚未完成頁面/資料庫設定。");
    console.log("請在 LINE 輸入：設定 Notion 頁面 <你的 Notion 頁面網址>");
  } else {
    console.log("\nNotion 綁定與資料庫設定已完成，可直接開始整理。");
  }

  console.log("\n接著在 AI 對話輸入：整理筆記");
}

main().catch((err) => {
  console.error("❌ 設定失敗：", err.message);
  process.exit(1);
});
