/**
 * 从 CHANGELOG.md 中提取指定版本对应的更新内容，输出到 stdout。
 *
 * 用法：
 *   node scripts/extract-changelog.mjs          # 自动获取 package.json 中的版本
 *   node scripts/extract-changelog.mjs v0.22.12 # 指定版本
 *   node scripts/extract-changelog.mjs 0.22.12  # 指定版本（不带 v 前缀）
 *
 * 输出：提取到的 Markdown 内容（不包含外层 `## [version]` 标题）
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---- 获取目标版本 ----
let targetVersion = process.argv[2];
if (!targetVersion) {
    // 从 package.json 读取
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    targetVersion = pkg.version;
}
// 去掉可能的 v 前缀
const cleanVersion = targetVersion.replace(/^v/i, '');

// ---- 读取 CHANGELOG ----
const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8');
const lines = changelog.split('\n');

// ---- 定位版本标题 ----
const versionHeaderRegex = /^## \[([^\]]+)\]/;
let startIndex = -1;

for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(versionHeaderRegex);
    if (match) {
        const headerVersion = match[1];
        if (headerVersion === cleanVersion) {
            startIndex = i;
            break;
        }
    }
}

if (startIndex === -1) {
    console.error(`Version entry [${cleanVersion}] not found in CHANGELOG.md`);
    process.exit(1);
}

// ---- 提取内容到下一个版本标题或文件尾 ----
const resultLines = [];
for (let i = startIndex + 1; i < lines.length; i++) {
    if (versionHeaderRegex.test(lines[i])) {
        break;
    }
    resultLines.push(lines[i]);
}

// ---- 输出 ----
const output = resultLines.join('\n').trim();
if (!output) {
    console.error(`Version [${cleanVersion}] has no content in CHANGELOG.md`);
    process.exit(1);
}

console.log(output);
