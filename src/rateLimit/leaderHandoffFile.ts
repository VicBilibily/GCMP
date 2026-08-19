/*---------------------------------------------------------------------------------------------
 *  限流 Leader 交接快照文件
 *  Agents 窗体与普通窗口的 globalState 互相隔离，崩溃切主无法靠 per-window 状态交接桶快照。
 *  读写都进 AtomicJsonFile.runExclusive；consume 在同一把锁内读完即删。
 *  本模块不依赖 vscode，可被 node:test 单元测试直接引用。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { resolveRateLimitHandoffFilePath } from '../interInstance/pathResolver';
import { AtomicJsonFile } from '../usages/atomicJsonFile';
import { isRateLimitStoreSnapshot, type RateLimitStoreSnapshot } from './rateLimitStore';

export interface RateLimitLeaderHandoffPayload {
    leaderId: string;
    authorityTerm?: string;
    receivedAt: number;
    snapshot: RateLimitStoreSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHandoffPayload(value: unknown): value is RateLimitLeaderHandoffPayload {
    return (
        isRecord(value) &&
        typeof value.leaderId === 'string' &&
        Number.isFinite(value.receivedAt) &&
        isRateLimitStoreSnapshot(value.snapshot) &&
        (value.authorityTerm === undefined || typeof value.authorityTerm === 'string')
    );
}

async function readHandoffUnlocked(filePath: string): Promise<RateLimitLeaderHandoffPayload | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return isHandoffPayload(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

async function removeHandoffUnlocked(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
}

/**
 * 写入交接快照。已有更新的快照（receivedAt 更大）不会被覆盖。
 */
export async function writeRateLimitLeaderHandoff(
    payload: RateLimitLeaderHandoffPayload,
    filePath: string = resolveRateLimitHandoffFilePath()
): Promise<void> {
    try {
        await AtomicJsonFile.runExclusive(filePath, async () => {
            const existing = await readHandoffUnlocked(filePath);
            if (existing && existing.receivedAt > payload.receivedAt) {
                return;
            }
            await AtomicJsonFile.writeJsonAtomically(filePath, payload);
        });
    } catch (error) {
        console.warn('[RateLimitHandoff] Failed to write handoff file', error);
    }
}

/**
 * 读取并删除交接快照。成功、损坏或缺失都会清文件，避免陈旧快照被下一任误用。
 */
export async function consumeRateLimitLeaderHandoff(
    filePath: string = resolveRateLimitHandoffFilePath()
): Promise<RateLimitLeaderHandoffPayload | undefined> {
    try {
        return await AtomicJsonFile.runExclusive(filePath, async () => {
            const payload = await readHandoffUnlocked(filePath);
            await removeHandoffUnlocked(filePath);
            return payload;
        });
    } catch (error) {
        console.warn('[RateLimitHandoff] Failed to consume handoff file', error);
        return undefined;
    }
}

export async function clearRateLimitLeaderHandoff(filePath: string = resolveRateLimitHandoffFilePath()): Promise<void> {
    try {
        await AtomicJsonFile.runExclusive(filePath, async () => {
            await removeHandoffUnlocked(filePath);
        });
    } catch (error) {
        console.warn('[RateLimitHandoff] Failed to clear handoff file', error);
    }
}
