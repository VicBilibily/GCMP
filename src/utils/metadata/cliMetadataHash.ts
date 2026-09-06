/*---------------------------------------------------------------------------------------------
 *  cli 元数据内容哈希（纯逻辑，无 vscode / JSON 依赖）
 *  字段规范化后 sha256 前 12 位；内容相同则哈希相同
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

export function hashCliMetadata(cli: {
    claudeCodeVersion?: string;
    codexTuiVersion?: string;
    codexTuiOriginator?: string;
}): string {
    const canonical = [cli.claudeCodeVersion ?? '', cli.codexTuiVersion ?? '', cli.codexTuiOriginator ?? ''].join('|');
    return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
