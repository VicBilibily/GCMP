/*---------------------------------------------------------------------------------------------
 *  历史请求快照管理器
 *
 *  requests.jsonl — 历史日期的请求最终状态快照，每行一条 requestId 记录。
 *
 *  当前策略：
 *  - 今天/昨天：只读取原始 hourly .jsonl，不生成/读取 requests.jsonl
 *  - 2 天前及更早：由 hourly .jsonl 整理为 requests.jsonl，并删除原始 hourly .jsonl
 *  - 运行时只使用 hourly .jsonl / requests.jsonl
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import {
    mergeSnapshotFiles,
    parseSnapshotFileContent,
    stringifySnapshotFile,
    type SnapshotFile,
    type SnapshotRequestRecord
} from './snapshotMerge';
import { LogPathManager } from './logPathManager';
import { StatsCalculator } from './statsCalculator';
import { UsageParser, type ExtendedTokenRequestLog } from './usageParser';
import type { TokenRequestLog } from './types';

export class SnapshotManager {
    private readonly pathManager: LogPathManager;

    // requests.jsonl 按文件 mtime 失效；不缓存 merged 结果。
    private readonly recordCache = new Map<
        string,
        {
            records: ExtendedTokenRequestLog[] | null;
            mtime: number;
            value?: SnapshotFile;
        }
    >();

    // 同一天的 requests.jsonl 写入串行化，避免并发构建时旧快照覆盖新快照
    private readonly snapshotWriteChains = new Map<string, Promise<void>>();

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    /** 读取历史 requests.jsonl */
    async read(dateStr: string): Promise<ExtendedTokenRequestLog[] | null> {
        const snapshotPath = this.getExistingSnapshotPath(dateStr);
        if (!snapshotPath) {
            return null;
        }

        const snapshotCacheKey = `snapshot:${dateStr}`;
        const snapshotFileMtime = fsSync.statSync(snapshotPath).mtimeMs;
        const snapshotCache = this.recordCache.get(snapshotCacheKey);
        let store: SnapshotFile;
        if (snapshotCache && snapshotCache.mtime === snapshotFileMtime) {
            store = snapshotCache.value as SnapshotFile;
        } else {
            store = await this.readFile(snapshotPath);
            this.recordCache.set(snapshotCacheKey, { records: null, mtime: snapshotFileMtime, value: store });
        }

        const records = Object.values(store)
            .map(c => this.fromSnapshot(c))
            .sort((a, b) => b.timestamp - a.timestamp);
        if (records.length === 0) {
            return null;
        }
        if (!(records[0] as unknown as Record<string, unknown>).isoTime) {
            StatusLogger.debug(`[SnapshotManager] Requests snapshot ${dateStr} has incomplete data, rebuild triggered`);
            return null;
        }
        return records;
    }

    /** 从请求记录构建历史 requests.jsonl 快照，并直接写入 */
    async buildSnapshotFromLogs(dateStr: string, logs: TokenRequestLog[]): Promise<void> {
        const store: SnapshotFile = {};
        for (const log of logs) {
            store[log.requestId] = this.toSnapshotRecord(log);
        }

        await this.writeSnapshotFile(dateStr, store);
        StatusLogger.debug(`[SnapshotManager] Built requests snapshot for ${dateStr}: ${logs.length} records`);

        const todayStr = this.getDateStr(Date.now());
        if (dateStr !== todayStr) {
            await this.purgeJsonlForDate(dateStr);
        }
    }

    /**
     * 将超过指定天数的历史日期从 JSONL 整理为 requests.jsonl
     * 之后删除原始 .jsonl，释放磁盘空间
     */
    async compactHistoricalDates(daysThreshold: number): Promise<number> {
        const baseDir = this.pathManager.getBaseDir();
        if (!fsSync.existsSync(baseDir)) {
            return 0;
        }

        const now = Date.now();
        const thresholdMs = daysThreshold * 86400_000;
        let compactedCount = 0;

        try {
            const entries = await fs.readdir(baseDir, { withFileTypes: true });
            const dateDirs = entries
                .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
                .map(e => e.name)
                .sort();

            for (const dateStr of dateDirs) {
                const dateMs = new Date(dateStr + 'T23:59:59').getTime();
                if (now - dateMs < thresholdMs) {
                    continue;
                } // 未超过阈值，跳过

                const dateFolder = this.pathManager.getDateFolderPath(dateStr);
                try {
                    const files = await fs.readdir(dateFolder);
                    const jsonlFiles = files.filter(f => /^\d{2}\.jsonl$/.test(f));
                    if (jsonlFiles.length === 0) {
                        continue;
                    }

                    // 读所有 hourly .jsonl（保留原始 TokenRequestLog，先合并再转 requests.jsonl 快照）
                    const allLogs: TokenRequestLog[] = [];
                    for (const f of jsonlFiles.sort()) {
                        const content = await fs.readFile(path.join(dateFolder, f), 'utf-8');
                        const lines = content.split('\n').filter(line => line.trim());
                        for (const line of lines) {
                            try {
                                const log = JSON.parse(line) as TokenRequestLog;
                                if (log.requestId) {
                                    allLogs.push(log);
                                }
                            } catch {
                                /* 跳过畸行 */
                            }
                        }
                    }

                    const store: SnapshotFile = {};
                    if (allLogs.length > 0) {
                        // 合并去重：与 statsCalculator.mergeLogsByRequestId 相同规则
                        // - timestamp 保留最早（请求开始时间）
                        // - status/rawUsage/stream* 取最后一条
                        const mergedMap = StatsCalculator.mergeLogsByRequestId(allLogs);
                        for (const log of mergedMap.values()) {
                            store[log.requestId] = this.toSnapshotRecord(log);
                        }
                    }

                    // 防御：合并已有快照中 hourly jsonl 不涵盖的独有记录。
                    const existingSnapshotPath = this.getExistingSnapshotPath(dateStr);
                    if (existingSnapshotPath) {
                        try {
                            const existingSnapshot = await this.readFile(existingSnapshotPath);
                            for (const [reqId, record] of Object.entries(existingSnapshot)) {
                                if (record && !store[reqId]) {
                                    store[reqId] = record;
                                }
                            }
                        } catch {
                            /* 旧快照读取失败，忽略 */
                        }
                    }
                    if (Object.keys(store).length === 0) {
                        continue;
                    }

                    // 写 requests.jsonl 快照
                    await this.writeSnapshotFile(dateStr, store);
                    // 删除原始 .jsonl（已全量合入 requests.jsonl），释放磁盘空间
                    await Promise.all(jsonlFiles.map(f => fs.rm(path.join(dateFolder, f), { force: true })));
                    compactedCount++;
                    StatusLogger.debug(
                        `[SnapshotManager] Compacted historical date ${dateStr}: ${Object.keys(store).length} records`
                    );
                } catch (err) {
                    StatusLogger.warn(`[SnapshotManager] Failed to compact historical date ${dateStr}`, err);
                }
            }
        } catch (err) {
            StatusLogger.warn('[SnapshotManager] Failed to scan historical dates for compaction', err);
        }

        return compactedCount;
    }

    async purgeJsonlForDate(dateStr: string): Promise<void> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return;
        }
        try {
            const files = await fs.readdir(dateFolder);
            const jsonlFiles = files.filter(f => /^\d{2}\.jsonl$/.test(f));
            if (jsonlFiles.length === 0) {
                return;
            }
            await Promise.all(jsonlFiles.map(f => fs.rm(path.join(dateFolder, f), { force: true })));
        } catch (err) {
            StatusLogger.warn(`[SnapshotManager] Failed to purge .jsonl for ${dateStr}`, err);
        }
    }

    /**
     * 写入历史 requests.jsonl 快照。
     */
    private async writeSnapshotFile(dateStr: string, store: SnapshotFile): Promise<void> {
        const previous = this.snapshotWriteChains.get(dateStr) ?? Promise.resolve();

        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const mergedStore = await this.mergeWithLatestSnapshot(dateStr, store);
                await this.atomicWriteStore(this.pathManager.getSnapshotFilePath(dateStr), mergedStore);
                this.invalidateCache(dateStr);
            })
            .finally(() => {
                if (this.snapshotWriteChains.get(dateStr) === next) {
                    this.snapshotWriteChains.delete(dateStr);
                }
            });

        this.snapshotWriteChains.set(dateStr, next);
        await next;
    }

    private async mergeWithLatestSnapshot(dateStr: string, incomingStore: SnapshotFile): Promise<SnapshotFile> {
        const snapshotPath = this.getExistingSnapshotPath(dateStr);
        let latestSnapshot: SnapshotFile = {};
        if (snapshotPath) {
            latestSnapshot = await this.readFile(snapshotPath);
        }
        return mergeSnapshotFiles(latestSnapshot, incomingStore);
    }

    invalidateCache(dateStr: string): void {
        for (const key of this.recordCache.keys()) {
            if (key === dateStr || key.endsWith(`:${dateStr}`)) {
                this.recordCache.delete(key);
            }
        }
    }

    clearCache(): void {
        this.recordCache.clear();
    }

    private getExistingSnapshotPath(dateStr: string): string | null {
        const snapshotPath = this.pathManager.getSnapshotFilePath(dateStr);
        return fsSync.existsSync(snapshotPath) ? snapshotPath : null;
    }

    private async atomicWriteStore(filePath: string, store: SnapshotFile): Promise<void> {
        const serialized = stringifySnapshotFile(store);
        const dirPath = path.dirname(filePath);
        const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.mkdir(dirPath, { recursive: true });
        try {
            await fs.writeFile(tempPath, serialized, 'utf-8');
            await this.renameWithRetry(tempPath, filePath);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private async renameWithRetry(fromPath: string, toPath: string): Promise<void> {
        const maxAttempts = 4;
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await fs.rename(fromPath, toPath);
                return;
            } catch (error) {
                lastError = error;
                if (!this.isRetryableRenameError(error) || attempt === maxAttempts) {
                    throw error;
                }
                await fs.rm(toPath, { force: true }).catch(() => undefined);
                await this.delay(attempt * 10);
            }
        }

        throw lastError instanceof Error ? lastError : new Error('rename failed');
    }

    private isRetryableRenameError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }
        const fsError = error as Error & { code?: string };
        return fsError.code === 'EPERM' || fsError.code === 'EACCES' || fsError.code === 'EBUSY';
    }

    private async delay(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private toSnapshotRecord(log: TokenRequestLog): SnapshotRequestRecord {
        const parsed = log.rawUsage ? UsageParser.parseRawUsage(log.rawUsage) : undefined;
        return {
            requestId: log.requestId,
            timestamp: log.timestamp,
            isoTime: log.isoTime,
            providerKey: log.providerKey,
            providerName: log.providerName,
            modelId: log.modelId,
            modelName: log.modelName,
            estimatedInput: log.estimatedInput,
            rawUsage: log.rawUsage as Record<string, unknown> | null,
            status: log.status,
            maxInputTokens: log.maxInputTokens,
            requestKind: log.requestKind,
            sessionId: log.sessionId,
            requestInitiator: log.requestInitiator,
            capturingTokenCorrelationId: log.capturingTokenCorrelationId,
            otelTraceContext:
                log.otelTraceContext ?
                    { traceId: log.otelTraceContext.traceId, spanId: log.otelTraceContext.spanId }
                :   undefined,
            streamStartTime: log.streamStartTime,
            streamEndTime: log.streamEndTime,
            actualInput: parsed?.actualInput,
            outputTokens: parsed?.outputTokens ?? log.outputTokens,
            totalTokens: parsed?.totalTokens,
            cacheRead: parsed?.cacheReadTokens,
            cacheCreation: parsed?.cacheCreationTokens,
            streamDuration:
                log.streamEndTime && log.streamStartTime ? log.streamEndTime - log.streamStartTime : undefined,
            outputSpeed: log.outputSpeed,
            estimatedCost: log.estimatedCost,
            costBreakdown: log.costBreakdown
        };
    }

    private fromSnapshot(c: SnapshotRequestRecord): ExtendedTokenRequestLog {
        const parsed = c.rawUsage ? UsageParser.parseRawUsage(c.rawUsage as TokenRequestLog['rawUsage']) : undefined;

        const actualInput = parsed?.actualInput ?? c.actualInput ?? c.estimatedInput;
        const outputTokens = parsed?.outputTokens ?? c.outputTokens ?? 0;
        const totalTokens = parsed?.totalTokens ?? c.totalTokens ?? actualInput + outputTokens;
        const cacheRead = parsed?.cacheReadTokens ?? c.cacheRead ?? 0;
        const cacheCreation = parsed?.cacheCreationTokens ?? c.cacheCreation ?? 0;

        let streamDuration: number | undefined;
        if (c.streamDuration !== undefined) {
            streamDuration = c.streamDuration;
        } else if (c.streamEndTime && c.streamStartTime) {
            streamDuration = c.streamEndTime - c.streamStartTime;
        }

        let outputSpeed: number | undefined;
        if (c.outputSpeed !== undefined) {
            outputSpeed = c.outputSpeed;
        } else if (streamDuration && streamDuration > 0 && outputTokens > 0) {
            outputSpeed = (outputTokens / streamDuration) * 1000;
        }

        return {
            requestId: c.requestId,
            timestamp: c.timestamp,
            isoTime: c.isoTime,
            providerKey: c.providerKey,
            providerName: c.providerName,
            modelId: c.modelId,
            modelName: c.modelName,
            estimatedInput: c.estimatedInput,
            rawUsage: (c.rawUsage as TokenRequestLog['rawUsage']) ?? null,
            status: c.status,
            maxInputTokens: c.maxInputTokens,
            requestKind: c.requestKind,
            sessionId: c.sessionId,
            requestInitiator: c.requestInitiator,
            capturingTokenCorrelationId: c.capturingTokenCorrelationId,
            otelTraceContext: c.otelTraceContext,
            streamStartTime: c.streamStartTime,
            streamEndTime: c.streamEndTime,
            actualInput,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            outputTokens,
            totalTokens,
            streamDuration,
            outputSpeed,
            estimatedCost: c.estimatedCost,
            costBreakdown: c.costBreakdown
        } as ExtendedTokenRequestLog;
    }

    private getDateStr(timestamp: number): string {
        const d = new Date(timestamp);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    private async readFile(filePath: string): Promise<SnapshotFile> {
        try {
            return parseSnapshotFileContent(await fs.readFile(filePath, 'utf-8'));
        } catch {
            return {};
        }
    }
}
