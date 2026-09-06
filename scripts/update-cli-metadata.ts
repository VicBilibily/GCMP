// 查询 npm registry 上 claude-code / codex 的最新版本，更新共享元数据源文件
// 仅更新文件不提交：维护者审查 diff 后随发布单独提交；--check 只报告不写入
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashCliMetadata } from '../src/utils/metadata/cliMetadataHash';

const metadataPath = fileURLToPath(new URL('../src/utils/metadata/gcmp-metadata.json', import.meta.url));
const checkOnly = process.argv.includes('--check');

async function latestVersion(packageName: string): Promise<string> {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!response.ok) {
        throw new Error(`${packageName}: HTTP ${response.status}`);
    }
    const { version } = (await response.json()) as { version?: string };
    if (typeof version !== 'string' || !version) {
        throw new Error(`${packageName}: 响应缺少 version`);
    }
    return version;
}

async function main(): Promise<void> {
    const current = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        schemaVersion: number;
        cli?: { claudeCode?: { version?: string }; codexTui?: { version?: string; originator?: string } };
    };
    const [claudeCode, codexTui] = await Promise.all([
        latestVersion('@anthropic-ai/claude-code'),
        latestVersion('@openai/codex')
    ]);

    const updates: Array<[string, string | undefined, string]> = [
        ['claudeCode', current.cli?.claudeCode?.version, claudeCode],
        ['codexTui', current.cli?.codexTui?.version, codexTui]
    ];
    for (const [name, from, to] of updates) {
        console.log(from === to ? `${name}: ${to}（已是最新）` : `${name}: ${from ?? '(缺失)'} -> ${to}`);
    }

    if (!updates.some(([, from, to]) => from !== to)) {
        console.log('无变更，文件保持不变');
        return;
    }
    if (checkOnly) {
        console.log('--check 模式：未写入');
        return;
    }

    const originator = current.cli?.codexTui?.originator ?? 'codex-tui';
    // 保持源文件既有排版（紧凑单行分组），不做整体 JSON 格式化
    const contentHash = hashCliMetadata({
        claudeCodeVersion: claudeCode,
        codexTuiVersion: codexTui,
        codexTuiOriginator: originator
    });
    const text = `{
    "schemaVersion": ${current.schemaVersion},
    "contentHash": ${JSON.stringify(contentHash)},
    "cli": {
        "claudeCode": { "version": ${JSON.stringify(claudeCode)} },
        "codexTui": { "version": ${JSON.stringify(codexTui)}, "originator": ${JSON.stringify(originator)} }
    }
}
`;
    await writeFile(metadataPath, text, 'utf8');
    console.log(`已更新 ${metadataPath}，请审查 diff 后单独提交`);
}

void main();
