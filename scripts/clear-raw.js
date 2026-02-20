#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'notes', '_raw');

function walkFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeEmptyDirs(full);
    }
  }
  const rest = fs.readdirSync(dir);
  if (rest.length === 0) {
    fs.rmdirSync(dir);
  }
}

function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.log('ℹ️ notes/_raw 不存在，略過清理');
    return;
  }

  const files = walkFiles(RAW_DIR);
  if (files.length === 0) {
    console.log('ℹ️ notes/_raw 無檔案，略過清理');
    return;
  }

  let removed = 0;
  for (const file of files) {
    fs.rmSync(file, { force: true });
    removed += 1;
  }

  removeEmptyDirs(RAW_DIR);
  console.log(`✅ 已清理 notes/_raw：${removed} 個檔案`);
}

main();
