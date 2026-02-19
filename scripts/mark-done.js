/**
 * mark-done.js
 * 將已處理的連結在 Cloudflare Worker / D1 中標記為完成
 *
 * 用法：node scripts/mark-done.js
 * 讀取 notes/_pending.json 中的所有連結 ID，將 status 改為 'done'
 */

const fs = require("fs");
const path = require("path");

const workerBaseUrl = process.env.WORKER_BASE_URL;
const workerApiKey = process.env.WORKER_INTERNAL_API_KEY;
let lineUserId = process.env.LINE_USER_ID;

if (!workerBaseUrl) {
    console.error("❌ 缺少 WORKER_BASE_URL");
    process.exit(1);
}

if (!workerApiKey) {
    console.error("❌ 缺少 WORKER_INTERNAL_API_KEY");
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
    const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}/internal/bootstrap-line-user`, {
        method: "GET",
        headers: {
            "x-api-key": workerApiKey,
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

async function markDone() {
    if (!lineUserId) {
        await inferLineUserId();
    }

    const pendingPath = path.join(__dirname, "..", "notes", "_pending.json");

    if (!fs.existsSync(pendingPath)) {
        console.log("⚠️ 找不到 _pending.json，沒有需要標記的項目");
        return;
    }

    const links = JSON.parse(fs.readFileSync(pendingPath, "utf8"));

    if (links.length === 0) {
        console.log("✅ 沒有需要標記的項目");
        return;
    }

    console.log(`🔄 標記 ${links.length} 個連結為已完成...\n`);

    const response = await fetch(`${workerBaseUrl.replace(/\/$/, "")}/internal/mark-done`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": workerApiKey,
        },
        body: JSON.stringify({
            ids: links.map((link) => link.id),
            line_user_id: lineUserId,
        }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`標記失敗 (${response.status}): ${text}`);
    }
    const payload = await response.json();

    // 清空 _pending.json
    fs.writeFileSync(pendingPath, JSON.stringify([], null, 2), "utf8");

    console.log(`✅ 已標記 ${payload.updated ?? links.length} 個連結為完成`);
}

markDone().catch(console.error);
