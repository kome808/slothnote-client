/**
 * pull-pending.js
 * 從 Cloudflare Worker 拉取待處理連結，寫入本地 _pending.json
 *
 * 用法：WORKER_BASE_URL=... WORKER_CLIENT_API_KEY=... node scripts/pull-pending.js
 */

const fs = require("fs");
const path = require("path");

const workerBaseUrl = process.env.WORKER_BASE_URL;
const workerApiKey = process.env.WORKER_CLIENT_API_KEY;
let lineUserId = process.env.LINE_USER_ID;

if (!workerBaseUrl) {
    console.error("❌ 缺少 WORKER_BASE_URL");
    process.exit(1);
}

if (!workerApiKey) {
    console.error("❌ 缺少 WORKER_CLIENT_API_KEY");
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
    const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}/client/bootstrap-line-user`, {
        method: "GET",
        headers: {
            "x-client-key": workerApiKey,
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

async function pullPending() {
    if (!lineUserId) {
        await inferLineUserId();
    }

    console.log("🔄 從 Cloudflare Worker 拉取待處理連結...\n");

    const url = new URL(`${workerBaseUrl.replace(/\/$/, "")}/client/pending`);
    url.searchParams.set("line_user_id", lineUserId);

    const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "x-client-key": workerApiKey,
        },
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`拉取失敗 (${response.status}): ${text}`);
    }

    const payload = await response.json();
    const links = Array.isArray(payload.links) ? payload.links : [];

    if (links.length === 0) {
        console.log("✅ 沒有待處理的連結！");
    }

    // 確保 notes 目錄存在
    const notesDir = path.join(__dirname, "..", "notes");
    if (!fs.existsSync(notesDir)) {
        fs.mkdirSync(notesDir, { recursive: true });
    }

    // 寫入 _pending.json
    const pendingPath = path.join(notesDir, "_pending.json");
    fs.writeFileSync(pendingPath, JSON.stringify(links, null, 2), "utf8");

    if (links.length > 0) {
        console.log(`📋 找到 ${links.length} 個待處理連結：\n`);
    }
    links.forEach((link, i) => {
        console.log(`   ${i + 1}. [${link.source}] ${link.url}`);
        if (link.memo) {
            console.log(`      📝 ${link.memo}`);
        }
    });

    console.log(`\n✅ 已寫入 ${pendingPath}`);
    console.log("💡 提示：在 AI 對話輸入「整理筆記」即可啟動處理流程");
}

pullPending().catch(console.error);
