/*---------------------------------------------------------------------------------------------
 *  JSON 文件原子写入工具
 *  供 CLI 认证与 oauth 凭证存储共用，避免半写入导致凭证损坏
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';

/**
 * 原子写入 JSON 文件：先写临时文件再 rename。
 * Windows 上目标文件被其他进程短暂占用时 renameSync 会报 EPERM/EBUSY/EACCES，线性退避重试。
 */
export async function writeJsonFileAtomically(filePath: string, data: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
        const retryable = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tempPath, filePath);
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException)?.code;
                if (!retryable.has(code ?? '') || attempt >= 4) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
            }
        }
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // ignore cleanup failures
        }
        throw error;
    }
}
