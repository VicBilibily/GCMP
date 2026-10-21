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
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { withDirectoryLock } from '../persistence/directoryLock';
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
import { sanitizeRawUsage, type TokenRequestLog } from './types';
import {
    normalizeRequestClassification,
    normalizeRequestContinuity
} from '../../handlers/classification/requestClassification';

export class SnapshotManager {
    private static readonly MAX_RECORD_CACHE_ENTRIES = 2;
    private static readonly MAX_RECORD_CACHE_RECORDS = 20_000;
    private static readonly SNAPSHOT_LOCK_WAIT_MS = 30_000;
    private static readonly SNAPSHOT_LOCK_RETRY_MS = 25;
    private static readonly SNAPSHOT_LOCK_ORPHAN_MS = 5_000;
    private readonly pathManager: LogPathManager;
    private readonly onRawLogsDeleted: (dateStr: string) => void;

    // requests.jsonl 按文件 mtime 失效；不缓存 merged 结果。
    private readonly recordCache = new Map<
        string,
        {
            records: ExtendedTokenRequestLog[] | null;
            mtime: number;
            value?: SnapshotFile;
            recordCount: number;
        }
    >();
    private cachedSnapshotRecords = 0;
    private cacheGeneration = 0;

    // 同一天的 requests.jsonl 写入串行化，避免并发构建时旧快照覆盖新快照
    private readonly snapshotWriteChains = new Map<string, Promise<void>>();

    constructor(pathManager: LogPathManager, onRawLogsDeleted: (dateStr: string) => void) {
        this.pathManager = pathManager;
        this.onRawLogsDeleted = onRawLogsDeleted;
    }

    /** 读取历史 requests.jsonl */
    async read(dateStr: string): Promise<ExtendedTokenRequestLog[] | null> {
        const snapshotPath = this.getExistingSnapshotPath(dateStr);
        if (!snapshotPath) {
            return null;
        }

        const snapshotCacheKey = `snapshot:${dateStr}`;
        const cacheGeneration = this.cacheGeneration;
        const snapshotFileMtime = fsSync.statSync(snapshotPath).mtimeMs;
        const snapshotCache = this.recordCache.get(snapshotCacheKey);
        let store: SnapshotFile;
        if (snapshotCache && snapshotCache.mtime === snapshotFileMtime) {
            this.recordCache.delete(snapshotCacheKey);
            this.recordCache.set(snapshotCacheKey, snapshotCache);
            store = snapshotCache.value as SnapshotFile;
        } else {
            store = await this.readFile(snapshotPath);
            if (this.cacheGeneration === cacheGeneration) {
                this.setRecordCache(snapshotCacheKey, snapshotFileMtime, store);
            }
        }
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        try {
            const rawFiles = await this.listRawFiles(dateFolder);
            if (rawFiles.length > 0) {
                store = mergeSnapshotFiles((await this.readRawStore(dateFolder, rawFiles)).store, store);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            const latestSnapshotPath = this.getExistingSnapshotPath(dateStr);
            if (latestSnapshotPath) {
                store = await this.readFile(latestSnapshotPath);
            }
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

    async readRecord(dateStr: string, requestId: string): Promise<ExtendedTokenRequestLog | null> {
        const snapshotPath = this.getExistingSnapshotPath(dateStr);
        if (!snapshotPath) {
            return null;
        }
        const record = (await this.readFile(snapshotPath))[requestId];
        return record ? this.fromSnapshot(record) : null;
    }

    /** 从请求记录构建历史 requests.jsonl 快照，并直接写入 */
    async buildSnapshotFromLogs(dateStr: string, logs: TokenRequestLog[]): Promise<void> {
        const store: SnapshotFile = {};
        for (const log of logs) {
            store[log.requestId] = this.toSnapshotRecord(log);
        }

        await this.writeSnapshotFile(dateStr, store);
        StatusLogger.debug(`[SnapshotManager] Built requests snapshot for ${dateStr}: ${logs.length} records`);
    }

    /** 向 requests 快照补写/覆盖单条请求记录（保留其他 requestId 不变）。 */
    async upsertRecord(dateStr: string, log: TokenRequestLog): Promise<void> {
        await this.writeSnapshotFile(dateStr, {
            [log.requestId]: this.toSnapshotRecord(log)
        });
    }

    /**
     * 将超过指定天数的历史日期从 JSONL 整理为 requests.jsonl
     * 之后删除原始 .jsonl，释放磁盘空间
     */
    async compactHistoricalDates(daysThreshold: number): Promise<number> {
        let compactedCount = 0;
        for (let pass = 0; pass < 2; pass++) {
            const result = await this.compactHistoricalDatesPass(daysThreshold);
            compactedCount += result.compactedCount;
            if (!result.foundAttribution) {
                break;
            }
            if (pass === 0) {
                StatusLogger.debug('[SnapshotManager] Attribution found during compaction; rescanning historical logs');
            }
        }
        return compactedCount;
    }

    private async compactHistoricalDatesPass(
        daysThreshold: number
    ): Promise<{ compactedCount: number; foundAttribution: boolean }> {
        const baseDir = this.pathManager.getBaseDir();
        if (!fsSync.existsSync(baseDir)) {
            return { compactedCount: 0, foundAttribution: false };
        }

        const now = Date.now();
        const thresholdMs = daysThreshold * 86400_000;
        let compactedCount = 0;
        let foundAttribution = false;

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
                    const compacted = await this.withSnapshotLock(dateStr, async () => {
                        const files = await fs.readdir(dateFolder);
                        const jsonlFiles = files.filter(f => /^\d{2}\.jsonl$/.test(f)).sort();
                        if (jsonlFiles.length === 0) {
                            return false;
                        }
                        const sourceSignature = await this.getRawSourceSignature(dateFolder);

                        // 读所有 hourly .jsonl（保留原始 TokenRequestLog，先合并再转 requests.jsonl 快照）
                        const rawStore = await this.readRawStore(dateFolder, jsonlFiles);
                        foundAttribution ||= rawStore.hasAttribution;
                        let store = rawStore.store;

                        // 防御：合并已有快照中 hourly jsonl 不涵盖的独有记录。
                        const existingSnapshotPath = this.getExistingSnapshotPath(dateStr);
                        if (existingSnapshotPath) {
                            try {
                                const existingSnapshot = await this.readFile(existingSnapshotPath);
                                store = mergeSnapshotFiles(store, existingSnapshot);
                            } catch {
                                /* 旧快照读取失败，忽略 */
                            }
                        }
                        if (Object.keys(store).length === 0) {
                            return false;
                        }

                        await this.writeSnapshotStoreLocked(dateStr, store);
                        if ((await this.getRawSourceSignature(dateFolder)) !== sourceSignature) {
                            StatusLogger.debug(
                                `[SnapshotManager] Raw logs changed during compaction, keeping source files: ${dateStr}`
                            );
                            return false;
                        }

                        await Promise.all(jsonlFiles.map(f => fs.rm(path.join(dateFolder, f), { force: true })));
                        this.onRawLogsDeleted(dateStr);
                        StatusLogger.debug(
                            `[SnapshotManager] Compacted historical date ${dateStr}: ${Object.keys(store).length} records`
                        );
                        return true;
                    });
                    if (compacted) {
                        compactedCount++;
                    }
                } catch (err) {
                    StatusLogger.warn(`[SnapshotManager] Failed to compact historical date ${dateStr}`, err);
                }
            }
        } catch (err) {
            StatusLogger.warn('[SnapshotManager] Failed to scan historical dates for compaction', err);
        }

        return { compactedCount, foundAttribution };
    }

    async sanitizeHistoricalSnapshots(versionTimestamp: number): Promise<number> {
        const baseDir = this.pathManager.getBaseDir();
        if (!fsSync.existsSync(baseDir)) {
            return 0;
        }

        let sanitizedCount = 0;
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        const dateDirs = entries
            .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
            .map(entry => entry.name);

        for (const dateStr of dateDirs) {
            const snapshotPath = this.getExistingSnapshotPath(dateStr);
            if (!snapshotPath) {
                continue;
            }

            try {
                const sanitized = await this.withSnapshotLock(dateStr, async () => {
                    const latestSnapshotPath = this.getExistingSnapshotPath(dateStr);
                    if (!latestSnapshotPath) {
                        return false;
                    }
                    const snapshotStats = await fs.stat(latestSnapshotPath);
                    if (snapshotStats.mtimeMs >= versionTimestamp) {
                        return false;
                    }
                    const store = await this.readFile(latestSnapshotPath);
                    const { store: sanitizedStore, changed } = this.sanitizeSnapshotStore(store);
                    if (!changed) {
                        await fs.utimes(
                            latestSnapshotPath,
                            new Date(snapshotStats.atimeMs),
                            new Date(versionTimestamp)
                        );
                        return false;
                    }
                    await this.atomicWriteStore(latestSnapshotPath, sanitizedStore);
                    this.invalidateCache(dateStr);
                    return true;
                });
                if (sanitized) {
                    sanitizedCount++;
                }
            } catch (error) {
                StatusLogger.warn(`[SnapshotManager] Failed to sanitize historical snapshot ${dateStr}`, error);
            }
        }

        return sanitizedCount;
    }

    private sanitizeSnapshotStore(store: SnapshotFile): { store: SnapshotFile; changed: boolean } {
        let changed = false;
        const sanitizedStore: SnapshotFile = {};
        for (const [requestId, record] of Object.entries(store)) {
            const rawUsage = sanitizeRawUsage(record.rawUsage as TokenRequestLog['rawUsage']) as Record<
                string,
                unknown
            > | null;
            if (rawUsage !== record.rawUsage) {
                changed = true;
            }
            sanitizedStore[requestId] = rawUsage === record.rawUsage ? record : { ...record, rawUsage };
        }
        return { store: sanitizedStore, changed };
    }

    /**
     * 写入历史 requests.jsonl 快照。
     */
    private async writeSnapshotFile(dateStr: string, store: SnapshotFile): Promise<void> {
        const previous = this.snapshotWriteChains.get(dateStr) ?? Promise.resolve();

        const next = previous
            .catch(() => undefined)
            .then(() => this.withSnapshotLock(dateStr, () => this.writeSnapshotStoreLocked(dateStr, store)))
            .finally(() => {
                if (this.snapshotWriteChains.get(dateStr) === next) {
                    this.snapshotWriteChains.delete(dateStr);
                }
            });

        this.snapshotWriteChains.set(dateStr, next);
        await next;
    }

    private async writeSnapshotStoreLocked(dateStr: string, store: SnapshotFile): Promise<void> {
        const mergedStore = await this.mergeWithLatestSnapshot(dateStr, store);
        await this.atomicWriteStore(
            this.pathManager.getSnapshotFilePath(dateStr),
            this.sanitizeSnapshotStore(mergedStore).store
        );
        this.invalidateCache(dateStr);
    }

    private async withSnapshotLock<T>(dateStr: string, operation: () => Promise<T>): Promise<T> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        const lockPath = path.join(dateFolder, '.requests.lock');
        await fs.mkdir(dateFolder, { recursive: true });
        return withDirectoryLock(
            lockPath,
            {
                waitMs: SnapshotManager.SNAPSHOT_LOCK_WAIT_MS,
                retryMs: SnapshotManager.SNAPSHOT_LOCK_RETRY_MS,
                orphanMs: SnapshotManager.SNAPSHOT_LOCK_ORPHAN_MS,
                reclaimOrphanMs: SnapshotManager.SNAPSHOT_LOCK_WAIT_MS,
                timeoutMessage: `Timed out waiting for snapshot lock: ${dateStr}`,
                ownershipLost: () => new Error(`Snapshot lock ownership changed: ${dateStr}`),
                isProcessAlive: pid => this.isProcessAlive(pid),
                retryTransient: true
            },
            operation
        );
    }

    private isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    }

    private async getRawSourceSignature(dateFolder: string): Promise<string> {
        try {
            const files = await this.listRawFiles(dateFolder);
            const signatures = await Promise.all(
                files.map(async file => {
                    const stats = await fs.stat(path.join(dateFolder, file));
                    return `${file}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
                })
            );
            return signatures.join('|');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return 'changed';
            }
            throw error;
        }
    }

    private async listRawFiles(dateFolder: string): Promise<string[]> {
        return (await fs.readdir(dateFolder)).filter(file => /^\d{2}\.jsonl$/.test(file)).sort();
    }

    private async readRawStore(
        dateFolder: string,
        files: readonly string[]
    ): Promise<{ store: SnapshotFile; hasAttribution: boolean }> {
        const allLogs: TokenRequestLog[] = [];
        let hasAttribution = false;
        for (const file of files) {
            const content = await fs.readFile(path.join(dateFolder, file), 'utf-8');
            for (const line of content.split('\n')) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const log = JSON.parse(line) as TokenRequestLog;
                    if (log.requestId) {
                        if (
                            log.rawUsage &&
                            typeof log.rawUsage === 'object' &&
                            Object.prototype.hasOwnProperty.call(log.rawUsage, 'attribution')
                        ) {
                            hasAttribution = true;
                        }
                        allLogs.push(log);
                    }
                } catch {
                    // 跳过畸行
                }
            }
        }

        const store: SnapshotFile = {};
        for (const log of StatsCalculator.mergeLogsByRequestId(allLogs).values()) {
            store[log.requestId] = this.toSnapshotRecord(log);
        }
        return { store, hasAttribution };
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
        this.cacheGeneration += 1;
        for (const key of this.recordCache.keys()) {
            if (key === dateStr || key.endsWith(`:${dateStr}`)) {
                this.deleteRecordCacheEntry(key);
            }
        }
    }

    clearCache(): void {
        this.cacheGeneration += 1;
        this.recordCache.clear();
        this.cachedSnapshotRecords = 0;
    }

    private setRecordCache(cacheKey: string, mtime: number, value: SnapshotFile): void {
        this.deleteRecordCacheEntry(cacheKey);
        const recordCount = Object.keys(value).length;
        this.recordCache.set(cacheKey, { records: null, mtime, value, recordCount });
        this.cachedSnapshotRecords += recordCount;
        while (
            this.recordCache.size > SnapshotManager.MAX_RECORD_CACHE_ENTRIES ||
            this.cachedSnapshotRecords > SnapshotManager.MAX_RECORD_CACHE_RECORDS
        ) {
            const oldestKey = this.recordCache.keys().next().value;
            if (typeof oldestKey !== 'string') {
                break;
            }
            this.deleteRecordCacheEntry(oldestKey);
        }
    }

    private deleteRecordCacheEntry(cacheKey: string): void {
        const cached = this.recordCache.get(cacheKey);
        if (!cached) {
            return;
        }
        this.recordCache.delete(cacheKey);
        this.cachedSnapshotRecords -= cached.recordCount;
    }

    private getExistingSnapshotPath(dateStr: string): string | null {
        const snapshotPath = this.pathManager.getSnapshotFilePath(dateStr);
        return fsSync.existsSync(snapshotPath) ? snapshotPath : null;
    }

    private async atomicWriteStore(filePath: string, store: SnapshotFile): Promise<void> {
        await this.atomicWriteText(filePath, stringifySnapshotFile(store));
    }

    private async atomicWriteText(filePath: string, serialized: string): Promise<void> {
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
        const outputTokens = parsed?.outputTokens ?? log.outputTokens ?? 0;
        const timing = UsageParser.parseTiming(log, outputTokens);
        return {
            requestId: log.requestId,
            timestamp: log.timestamp,
            isoTime: log.isoTime,
            providerKey: log.providerKey,
            providerName: log.providerName,
            apiKeyHash: log.apiKeyHash,
            apiKeyName: log.apiKeyName,
            balance: log.balance,
            modelId: log.modelId,
            modelName: log.modelName,
            estimatedInput: log.estimatedInput,
            rawUsage: sanitizeRawUsage(log.rawUsage) as Record<string, unknown> | null,
            status: log.status,
            maxInputTokens: log.maxInputTokens,
            requestKind: log.requestKind,
            requestClassification: normalizeRequestClassification(log.requestClassification),
            requestContinuity: normalizeRequestContinuity(log.requestContinuity),
            sessionId: log.sessionId,
            subSessionId: log.subSessionId,
            sessionRecoverySource: log.sessionRecoverySource,
            sessionTitle: log.sessionTitle,
            requestInitiator: log.requestInitiator,
            capturingTokenCorrelationId: log.capturingTokenCorrelationId,
            otelTraceContext:
                log.otelTraceContext ?
                    { traceId: log.otelTraceContext.traceId, spanId: log.otelTraceContext.spanId }
                :   undefined,
            telemetryTurn: log.telemetryTurn,
            requestMetricStartTime: log.requestMetricStartTime,
            wasThrottled: log.wasThrottled,
            streamStartTime: log.streamStartTime,
            streamEndTime: log.streamEndTime,
            actualInput: parsed?.actualInput,
            outputTokens,
            totalTokens: parsed?.totalTokens,
            cacheRead: parsed?.cacheReadTokens,
            cacheCreation: parsed?.cacheCreationTokens,
            streamDuration: timing.streamDuration,
            outputSpeed: timing.outputSpeed,
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

        const timing = UsageParser.parseTiming(c, outputTokens);
        const legacyStreamDuration =
            c.streamDuration !== undefined && Number.isFinite(c.streamDuration) && c.streamDuration >= 0 ?
                c.streamDuration
            :   undefined;
        const streamDuration = timing.streamDuration ?? legacyStreamDuration;
        const timePerOutputToken =
            timing.timePerOutputToken ??
            (outputTokens > 0 && streamDuration !== undefined && streamDuration > 0 ?
                streamDuration / outputTokens
            :   undefined);
        const outputSpeed =
            timing.outputSpeed ??
            (outputTokens > 0 && streamDuration !== undefined && streamDuration > 0 ?
                (outputTokens / streamDuration) * 1000
            :   undefined);

        return {
            requestId: c.requestId,
            timestamp: c.timestamp,
            isoTime: c.isoTime,
            providerKey: c.providerKey,
            providerName: c.providerName,
            apiKeyHash: c.apiKeyHash,
            apiKeyName: c.apiKeyName,
            balance: c.balance,
            modelId: c.modelId,
            modelName: c.modelName,
            estimatedInput: c.estimatedInput,
            rawUsage: (c.rawUsage as TokenRequestLog['rawUsage']) ?? null,
            status: c.status,
            maxInputTokens: c.maxInputTokens,
            requestKind: c.requestKind,
            requestClassification: normalizeRequestClassification(c.requestClassification),
            requestContinuity: normalizeRequestContinuity(c.requestContinuity),
            sessionId: c.sessionId,
            subSessionId: c.subSessionId,
            sessionRecoverySource: c.sessionRecoverySource,
            sessionTitle: c.sessionTitle,
            requestInitiator: c.requestInitiator,
            capturingTokenCorrelationId: c.capturingTokenCorrelationId,
            otelTraceContext: c.otelTraceContext,
            telemetryTurn: c.telemetryTurn,
            requestMetricStartTime: c.requestMetricStartTime,
            wasThrottled: c.wasThrottled,
            streamStartTime: c.streamStartTime,
            streamEndTime: c.streamEndTime,
            actualInput,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            outputTokens,
            totalTokens,
            streamDuration,
            firstTokenLatency: timing.firstTokenLatency,
            timePerOutputToken,
            timingSource: timing.timingSource,
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
        return parseSnapshotFileContent(await fs.readFile(filePath, 'utf-8'));
    }
}
