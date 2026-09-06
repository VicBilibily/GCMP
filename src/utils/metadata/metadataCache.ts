/*---------------------------------------------------------------------------------------------
 *  元数据磁盘读写（纯逻辑层）
 *  读：加锁读文件并解析校验，任何失败返回 undefined；写：原文原子落盘
 *  不依赖 vscode，可供 node:test 单测；宿主层见 remoteMetadataService
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { AtomicJsonFile } from '../../usages/atomicJsonFile';
import { hashCliMetadata, parseGcmpMetadata } from './metadataResolver';
import type { GcmpCliMetadata } from './metadataResolver';

/** 一次成功的元数据读取结果 */
export interface MetadataSnapshot {
    cli: GcmpCliMetadata;
    contentHash: string;
}

/** 读取并解析元数据文件（本地源文件或磁盘缓存）；文件缺失/内容非法均返回 undefined */
export async function readMetadataSnapshot(filePath: string): Promise<MetadataSnapshot | undefined> {
    try {
        // 读与写同一把锁，规避 Windows 上 rename/read 句柄冲突（EPERM）
        const text = await AtomicJsonFile.runExclusive(filePath, () => fs.readFile(filePath, 'utf-8'));
        const parsed = parseGcmpMetadata(text);
        if (!parsed) {
            return undefined;
        }
        return { cli: parsed.cli, contentHash: hashCliMetadata(parsed.cli) };
    } catch {
        return undefined;
    }
}

/** 元数据原文原子写盘；失败抛错由调用方决定降级策略 */
export async function writeMetadataSnapshot(filePath: string, text: string): Promise<void> {
    await AtomicJsonFile.runExclusive(filePath, () =>
        AtomicJsonFile.writeJsonAtomically(filePath, text, value => value as string)
    );
}
