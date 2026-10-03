/*---------------------------------------------------------------------------------------------
 *  限流 Leader 交接快照文件
 *  Agents 窗体与普通窗口的 globalState 互相隔离，崩溃切主无法靠 per-window 状态交接桶快照。
 *  读写与消费均使用进程内队列和跨进程票据锁。
 *  本模块不依赖 vscode，可被 node:test 单元测试直接引用。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
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

interface HandoffTicket {
    choosing: boolean;
    number: number;
}

async function withHandoffLock<TResult>(filePath: string, action: () => Promise<TResult>): Promise<TResult> {
    const lockPath = `${filePath}.lock`;
    const name = `${process.pid}-${randomUUID()}.json`;
    const ticketPath = join(lockPath, name);
    const deadline = performance.now() + 10_000;
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
    try {
        await fs.writeFile(ticketPath, JSON.stringify({ choosing: true, number: 0 }), { flag: 'wx', mode: 0o600 });
        const readTickets = async (): Promise<Array<{ name: string; ticket: HandoffTicket }>> => {
            const tickets: Array<{ name: string; ticket: HandoffTicket }> = [];
            for (const candidate of await fs.readdir(lockPath)) {
                if (candidate === name) {
                    continue;
                }
                const match = /^(\d+)-[\da-f-]+\.json$/i.exec(candidate);
                if (!match) {
                    continue;
                }
                const pid = Number(match[1]);
                try {
                    process.kill(pid, 0);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                        await fs.rm(join(lockPath, candidate), { force: true });
                        continue;
                    }
                    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                        throw error;
                    }
                }
                let raw: string;
                try {
                    raw = await fs.readFile(join(lockPath, candidate), 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        continue;
                    }
                    throw error;
                }
                let ticket: unknown;
                try {
                    ticket = JSON.parse(raw);
                } catch {
                    /* 写入中的票据按 choosing 处理。 */
                }
                tickets.push({
                    name: candidate,
                    ticket:
                        (
                            isRecord(ticket) &&
                            typeof ticket.choosing === 'boolean' &&
                            typeof ticket.number === 'number' &&
                            Number.isSafeInteger(ticket.number) &&
                            ticket.number >= 0
                        ) ?
                            { choosing: ticket.choosing, number: ticket.number }
                        :   { choosing: true, number: 0 }
                });
            }
            return tickets;
        };
        const number = 1 + Math.max(0, ...(await readTickets()).map(entry => entry.ticket.number));
        if (!Number.isSafeInteger(number)) {
            throw new Error('Rate-limit handoff lock ticket overflow');
        }
        await AtomicJsonFile.writeJsonAtomically(ticketPath, { choosing: false, number });
        // Lamport 票据顺序避免共享锁文件的回收/重建竞争；活进程不因锁龄被抢占。
        for (;;) {
            const blocked = (await readTickets()).some(
                entry =>
                    entry.ticket.choosing ||
                    entry.ticket.number < number ||
                    (entry.ticket.number === number && entry.name < name)
            );
            if (!blocked) {
                return await action();
            }
            if (performance.now() >= deadline) {
                throw new Error('Timed out waiting for rate-limit handoff file lock');
            }
            await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
    } finally {
        await fs.rm(ticketPath, { force: true });
    }
}

async function readHandoffUnlocked(filePath: string): Promise<RateLimitLeaderHandoffPayload | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return isHandoffPayload(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

async function removeHandoffUnlocked(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true });
}

/**
 * 写入交接快照。已有更新的快照（receivedAt 更大）不会被覆盖。
 */
export async function writeRateLimitLeaderHandoff(
    payload: RateLimitLeaderHandoffPayload,
    filePath: string = resolveRateLimitHandoffFilePath(),
    options?: { strict?: boolean }
): Promise<void> {
    try {
        await AtomicJsonFile.runExclusive(filePath, () =>
            withHandoffLock(filePath, async () => {
                const existing = await readHandoffUnlocked(filePath);
                if (existing && existing.receivedAt > payload.receivedAt) {
                    return;
                }
                await AtomicJsonFile.writeJsonAtomically(filePath, payload);
            })
        );
    } catch (error) {
        if (options?.strict) {
            throw error;
        }
        console.warn('[RateLimitHandoff] Failed to write handoff file', error);
    }
}

/**
 * 读取交接快照，默认读取后删除；恢复可保留有效状态，损坏文件始终清理。
 */
export async function consumeRateLimitLeaderHandoff(
    filePath: string = resolveRateLimitHandoffFilePath(),
    options?: { strict?: boolean; preserve?: boolean }
): Promise<RateLimitLeaderHandoffPayload | undefined> {
    try {
        return await AtomicJsonFile.runExclusive(filePath, () =>
            withHandoffLock(filePath, async () => {
                const payload = await readHandoffUnlocked(filePath);
                if (!payload || !options?.preserve) {
                    await removeHandoffUnlocked(filePath);
                }
                return payload;
            })
        );
    } catch (error) {
        if (options?.strict) {
            throw error;
        }
        console.warn('[RateLimitHandoff] Failed to consume handoff file', error);
        return undefined;
    }
}

export async function clearRateLimitLeaderHandoff(filePath: string = resolveRateLimitHandoffFilePath()): Promise<void> {
    try {
        await AtomicJsonFile.runExclusive(filePath, () =>
            withHandoffLock(filePath, async () => {
                await removeHandoffUnlocked(filePath);
            })
        );
    } catch (error) {
        console.warn('[RateLimitHandoff] Failed to clear handoff file', error);
    }
}
