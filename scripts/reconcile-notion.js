/**
 * reconcile-notion.js
 * 強制執行本機 notes 與 Notion 的一致性補齊（不依賴是否有新連結）
 */

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function runStep(label, cmd, args) {
  console.log(`\n🔄 ${label}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} 失敗（exit=${result.status}）`);
  }
}

function main() {
  runStep("本機筆記動態重分類", process.execPath, [path.join(__dirname, "auto-categorize.js")]);
  runStep("同步並補齊 Notion", process.execPath, [path.join(__dirname, "notion-sync.js")]);

  console.log("\n✅ 已完成本機與 Notion 一致性補齊");
}

main();
