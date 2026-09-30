/*---------------------------------------------------------------------------------------------
 *  IPC 降级文件传输
 *  当 Leader/Follower 之间无法建立本地 IPC 时，通过文件系统事件文件实现跨窗口同步
 *  每个实例写入自己的 events 文件，所有实例监听目录下全部 events 文件
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import { InterInstanceEvent, parseIncrementalEvents, INTER_INSTANCE_EVENT_TYPES } from './eventProtocol';
import { StatusLogger } from '../utils/runtime/statusLogger';

export interface FallbackTransportOptions {
    /** 当前实例 ID */
    instanceId: string;
    /** 接收到事件时的回调 */
    onEvent: (event: InterInstanceEvent, replayed: boolean) => void;
}

interface FileReadState {
    /** 文件最后读取的字节位置 */
    position: number;
    /** 上次读取后残留的半条 NDJSON 事件 */
    remaining?: string;
    /** Node fs.FSWatcher */
    watcher?: fs.FSWatcher;
    reading?: boolean;
    readAgain?: boolean;
    continuityTail?: Buffer;
    decoder?: StringDecoder;
    replayUntil?: number;
    rewrite?: {
        readUntil?: number;
        records: FallbackRecord[];
        history: Set<string>;
    };
    seenEvents?: Map<string, number>;
    seenEventBytes?: number;
}

const EVENT_FILE_PREFIX = 'events-';
const EVENT_FILE_SUFFIX = '.jsonl';
const EVENT_FILE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 天
/** 单个事件文件的最大体积，超过后压缩，避免活跃实例的事件文件无限增长 */
const MAX_EVENT_FILE_SIZE_BYTES = 1024 * 1024; // 1MB
const CONTINUITY_TAIL_BYTES = 64;
const REPLAY_BOUNDARY_LINE = '{"gcmpFallbackReplayBoundary":1}';
const RETAINED_REPLAY_EVENT_TYPES = new Set<InterInstanceEvent['type']>([
    'apiKeyFailoverRequested',
    'apiKeyFailoverReset'
]);

type FallbackRecord = { event: InterInstanceEvent } | { boundary: true };

function parseFallbackRecords(previous: string, chunk: string): { records: FallbackRecord[]; remaining: string } {
    const lines = (previous + chunk).split('\n');
    const remaining = lines.pop() ?? '';
    const records: FallbackRecord[] = [];
    for (const line of lines) {
        if (line.trim() === REPLAY_BOUNDARY_LINE) {
            records.push({ boundary: true });
            continue;
        }
        const parsed = parseIncrementalEvents('', `${line}\n`);
        for (const event of parsed.events) {
            records.push({ event });
        }
    }
    return { records, remaining };
}

/**
 * 基于文件系统的降级传输层
 * 原理：每个实例将事件追加写入自己的 ndjson 文件，其他实例通过 fs.watch 监听变更并读取新增字节
 */
export class FallbackTransport {
    private options: FallbackTransportOptions;
    private context: vscode.ExtensionContext | undefined;
    private eventsDir: string | undefined;
    private ownFilePath: string | undefined;
    private fileStates = new Map<string, FileReadState>();
    private disposed = false;
    private cleanupTimer: NodeJS.Timeout | undefined;
    private darwinPollTimer: NodeJS.Timeout | undefined;
    private directoryWatcher: fs.FSWatcher | undefined;
    private readonly DARWIN_POLL_INTERVAL_MS = 2000;
    /** 本实例事件文件写队列，保证截断与追加是不可交错的单一操作序列 */
    private publishChain: Promise<void> = Promise.resolve();

    constructor(options: FallbackTransportOptions) {
        this.options = options;
    }

    /**
     * 启动文件传输
     */
    start(context: vscode.ExtensionContext): void {
        if (this.disposed) {
            return;
        }
        this.context = context;
        // 使用 fsPath 确保所有 VS Code 版本（Stable/Insiders）基于同一扩展 ID 的 globalStorage 目录
        this.eventsDir = path.join(context.globalStorageUri.fsPath, 'inter-instance');
        this.ownFilePath = path.join(
            this.eventsDir,
            `${EVENT_FILE_PREFIX}${this.options.instanceId}${EVENT_FILE_SUFFIX}`
        );

        fs.mkdirSync(this.eventsDir, { recursive: true });

        // 初始化已有文件读取位置
        this.initializeExistingFiles();

        // 监听目录新增/删除的文件
        this.watchDirectory();

        // 启动过期文件清理（每小时一次）
        this.cleanupTimer = setInterval(() => this.cleanupStaleFiles(), 60 * 60 * 1000);
        this.cleanupStaleFiles();

        // macOS 上 fs.watch 对目录变更不可靠，额外启动一个轮询兜底
        if (process.platform === 'darwin') {
            this.startDarwinPolling();
        }

        StatusLogger.debug('[FallbackTransport] Started file-based fallback transport');
    }

    /**
     * 停止文件传输并释放资源
     */
    async stop(): Promise<void> {
        this.disposed = true;
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        if (this.darwinPollTimer) {
            clearInterval(this.darwinPollTimer);
            this.darwinPollTimer = undefined;
        }
        this.directoryWatcher?.close();
        this.directoryWatcher = undefined;
        for (const state of this.fileStates.values()) {
            state.watcher?.close();
        }
        this.fileStates.clear();
        this.context = undefined;
        await this.publishChain;
        StatusLogger.debug('[FallbackTransport] Stopped file-based fallback transport');
    }

    /**
     * 将事件追加写入本实例的事件文件
     */
    publish(event: InterInstanceEvent): Promise<void> {
        if (this.disposed || !this.ownFilePath) {
            return Promise.resolve();
        }

        const task = this.publishChain.then(async () => {
            // 能进入队列说明 publish 发生在 stop 之前；即使随后开始停用，也必须完成这些已接收事件的写盘。
            if (!this.ownFilePath) {
                return;
            }
            try {
                const line = JSON.stringify(event) + '\n';
                if (!(await this.compactOwnFileIfOversized(line))) {
                    await fs.promises.appendFile(this.ownFilePath, line, 'utf8');
                }
            } catch (error) {
                StatusLogger.warn('[FallbackTransport] Failed to append event to own file', error);
            }
        });
        this.publishChain = task.catch(() => undefined);
        return task;
    }

    /** 超限时仅保留允许重放的 failover 事件，再单独追加当前事件。 */
    private async compactOwnFileIfOversized(currentLine: string): Promise<boolean> {
        if (!this.ownFilePath) {
            return false;
        }
        const stats = await fs.promises.stat(this.ownFilePath).catch(() => null);
        if (!stats || stats.size <= MAX_EVENT_FILE_SIZE_BYTES) {
            return false;
        }
        const keepBytes = Math.floor(MAX_EVENT_FILE_SIZE_BYTES / 2);
        const handle = await fs.promises.open(this.ownFilePath, 'r');
        let tail: string;
        try {
            const buffer = Buffer.alloc(keepBytes);
            await handle.read(buffer, 0, keepBytes, stats.size - keepBytes);
            tail = buffer.toString('utf8');
        } finally {
            await handle.close();
        }
        // 丢弃可能截断的首行，从下一个换行符开始保留
        const firstNewline = tail.indexOf('\n');
        const safeTail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : '';
        const { records } = parseFallbackRecords('', safeTail);
        const retained = records
            .filter(
                (record): record is { event: InterInstanceEvent } =>
                    'event' in record &&
                    record.event.senderInstanceId === this.options.instanceId &&
                    RETAINED_REPLAY_EVENT_TYPES.has(record.event.type)
            )
            .map(record => JSON.stringify(record.event) + '\n')
            .join('');
        await fs.promises.writeFile(this.ownFilePath, `${retained}${REPLAY_BOUNDARY_LINE}\n`, 'utf8');
        await fs.promises.appendFile(this.ownFilePath, currentLine, 'utf8');
        StatusLogger.debug('[FallbackTransport] Compacted oversized event file');
        return true;
    }

    private initializeExistingFiles(): void {
        if (!this.eventsDir) {
            return;
        }
        try {
            const entries = fs.readdirSync(this.eventsDir);
            for (const entry of entries) {
                if (!this.isEventFile(entry)) {
                    continue;
                }
                const filePath = path.join(this.eventsDir, entry);
                this.fileStates.set(filePath, { position: 0, remaining: '' });
                this.watchFile(filePath);
                void this.readNewEvents(filePath, true);
            }
        } catch {
            // 目录可能不存在或为空，忽略
        }
    }

    private watchDirectory(): void {
        if (!this.eventsDir) {
            return;
        }
        try {
            this.directoryWatcher = fs.watch(this.eventsDir, (eventType, filename) => {
                if (eventType !== 'rename' || !filename || !this.isEventFile(filename)) {
                    return;
                }
                const filePath = path.join(this.eventsDir!, filename);
                if (this.fileStates.has(filePath)) {
                    return;
                }
                // 新文件出现：从文件头开始读取，避免在 watcher 挂上前已经写入的事件丢失
                try {
                    this.fileStates.set(filePath, { position: 0, remaining: '' });
                    this.watchFile(filePath);
                    void this.readNewEvents(filePath);
                } catch {
                    // 文件可能已被删除
                }
            });
        } catch (error) {
            StatusLogger.warn('[FallbackTransport] Failed to watch events directory', error);
        }
    }

    private watchFile(filePath: string): void {
        if (this.disposed) {
            return;
        }
        const state = this.fileStates.get(filePath);
        if (!state || state.watcher) {
            return;
        }
        try {
            state.watcher = fs.watch(filePath, () => {
                void this.readNewEvents(filePath);
            });
        } catch (error) {
            StatusLogger.warn(`[FallbackTransport] Failed to watch file ${filePath}`, error);
        }
    }

    private async readNewEvents(filePath: string, replayed = false): Promise<void> {
        if (this.disposed) {
            return;
        }
        const state = this.fileStates.get(filePath);
        if (!state) {
            return;
        }
        if (state.reading) {
            state.readAgain = true;
            return;
        }
        state.reading = true;

        let handle: fs.promises.FileHandle | undefined;
        try {
            let stats = await fs.promises.stat(filePath).catch(() => null);
            if (!stats) {
                // 文件被删除：同步关闭 watcher，避免句柄泄漏
                state.watcher?.close();
                this.fileStates.delete(filePath);
                return;
            }

            handle = await fs.promises.open(filePath, 'r');
            let rewritten = stats.size < state.position;
            if (!rewritten && state.position > 0 && state.continuityTail?.length) {
                const probeLength = Math.min(state.continuityTail.length, state.position);
                const probe = Buffer.alloc(probeLength);
                let probeBytesRead = 0;
                while (probeBytesRead < probeLength) {
                    const probeRead = await handle.read(
                        probe,
                        probeBytesRead,
                        probeLength - probeBytesRead,
                        state.position - probeLength + probeBytesRead
                    );
                    if (probeRead.bytesRead === 0) {
                        break;
                    }
                    probeBytesRead += probeRead.bytesRead;
                }
                if (probeBytesRead < probeLength) {
                    stats = await handle.stat();
                    if (stats.size >= state.position) {
                        return;
                    }
                    rewritten = true;
                } else {
                    rewritten = !probe.equals(state.continuityTail.subarray(state.continuityTail.length - probeLength));
                }
            }

            if (rewritten) {
                state.position = 0;
                state.remaining = '';
                state.continuityTail = undefined;
                state.decoder = new StringDecoder('utf8');
                state.replayUntil = undefined;
                state.rewrite = {
                    readUntil: stats.size,
                    records: [],
                    history: new Set(state.seenEvents?.keys())
                };
            }

            if (replayed) {
                state.replayUntil ??= stats.size;
            }
            if (state.replayUntil !== undefined) {
                state.replayUntil = Math.min(state.replayUntil, stats.size);
                if (state.position >= state.replayUntil) {
                    state.replayUntil = undefined;
                }
            }
            if (state.rewrite?.readUntil !== undefined) {
                state.rewrite.readUntil =
                    state.rewrite.readUntil === 0 ? stats.size : Math.min(state.rewrite.readUntil, stats.size);
            }
            const replaying = state.replayUntil !== undefined;
            const readUntil = Math.min(
                stats.size,
                state.replayUntil ?? stats.size,
                state.rewrite?.readUntil ?? stats.size
            );
            const readLength = readUntil - state.position;
            if (readLength <= 0) {
                return;
            }

            const buffer = Buffer.alloc(readLength);
            const read = await handle.read(buffer, 0, readLength, state.position);
            if (read.bytesRead <= 0) {
                return;
            }
            const bytes = buffer.subarray(0, read.bytesRead);
            state.position += read.bytesRead;
            if (bytes.length >= CONTINUITY_TAIL_BYTES) {
                state.continuityTail = Buffer.from(bytes.subarray(bytes.length - CONTINUITY_TAIL_BYTES));
            } else {
                const combined = Buffer.concat([state.continuityTail ?? Buffer.alloc(0), bytes]);
                state.continuityTail = Buffer.from(
                    combined.subarray(Math.max(0, combined.length - CONTINUITY_TAIL_BYTES))
                );
            }
            if (state.position < stats.size) {
                state.readAgain = true;
            }
            if (state.replayUntil !== undefined && state.position >= state.replayUntil) {
                state.replayUntil = undefined;
            }

            state.decoder ??= new StringDecoder('utf8');
            const chunk = state.decoder.write(bytes);
            const parsed = parseFallbackRecords(state.remaining ?? '', chunk);
            let records = parsed.records;
            state.remaining = parsed.remaining;
            if (state.rewrite?.readUntil !== undefined) {
                for (const record of records) {
                    state.rewrite.records.push(record);
                }
                if (state.position < state.rewrite.readUntil) {
                    return;
                }
                records = state.rewrite.records;
                state.rewrite.records = [];
                state.rewrite.readUntil = undefined;
            }
            const sourceInstanceId = this.getEventFileInstanceId(filePath);
            let latestBoundary = -1;
            for (let index = records.length - 1; index >= 0; index--) {
                if ('boundary' in records[index]) {
                    latestBoundary = index;
                    break;
                }
            }
            if (latestBoundary >= 0) {
                state.rewrite = undefined;
            }
            for (let index = 0; index < records.length; index++) {
                const record = records[index];
                if ('boundary' in record) {
                    continue;
                }
                const event = record.event;
                if (!INTER_INSTANCE_EVENT_TYPES.includes(event.type)) {
                    continue;
                }
                if (!sourceInstanceId || event.senderInstanceId !== sourceInstanceId) {
                    StatusLogger.warn('[FallbackTransport] Ignored event with a mismatched sender identity');
                    continue;
                }
                if (event.senderInstanceId === this.options.instanceId) {
                    continue;
                }
                const serialized = JSON.stringify(event);
                const identity = createHash('sha256').update(serialized).digest('hex');
                // 旧版重写没有边界，已消费事件用于识别历史记录。
                const eventReplayed =
                    replaying ||
                    (latestBoundary >= 0 ? index < latestBoundary : state.rewrite?.history.has(identity) === true);
                const seenEvents = (state.seenEvents ??= new Map());
                state.seenEventBytes = (state.seenEventBytes ?? 0) + Buffer.byteLength(serialized) + 1;
                seenEvents.delete(identity);
                seenEvents.set(identity, state.seenEventBytes);
                for (const [seenIdentity, end] of seenEvents) {
                    if (end > state.seenEventBytes - MAX_EVENT_FILE_SIZE_BYTES) {
                        break;
                    }
                    seenEvents.delete(seenIdentity);
                }
                this.options.onEvent(event, eventReplayed);
            }
        } catch (error) {
            StatusLogger.warn(`[FallbackTransport] Failed to read events from ${filePath}`, error);
        } finally {
            await handle?.close();
            state.reading = false;
            if (state.readAgain && this.fileStates.get(filePath) === state) {
                state.readAgain = false;
                void this.readNewEvents(filePath);
            }
        }
    }

    private cleanupStaleFiles(): void {
        if (!this.eventsDir) {
            return;
        }
        try {
            const entries = fs.readdirSync(this.eventsDir);
            const now = Date.now();
            for (const entry of entries) {
                if (!this.isEventFile(entry)) {
                    continue;
                }
                const filePath = path.join(this.eventsDir, entry);
                try {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtimeMs > EVENT_FILE_RETENTION_MS) {
                        fs.unlinkSync(filePath);
                        const state = this.fileStates.get(filePath);
                        state?.watcher?.close();
                        this.fileStates.delete(filePath);
                    }
                } catch {
                    // 忽略单个文件清理错误
                }
            }
        } catch {
            // 忽略目录读取错误
        }
    }

    private isEventFile(filename: string): boolean {
        return filename.startsWith(EVENT_FILE_PREFIX) && filename.endsWith(EVENT_FILE_SUFFIX);
    }

    private getEventFileInstanceId(filePath: string): string | undefined {
        const filename = path.basename(filePath);
        if (!this.isEventFile(filename)) {
            return undefined;
        }
        const instanceId = filename.slice(EVENT_FILE_PREFIX.length, -EVENT_FILE_SUFFIX.length);
        return instanceId || undefined;
    }

    /**
     * macOS 轮询兜底
     * macOS fs.watch 对 FSEvents 的触发存在延迟或丢失，定期扫描文件 mtime 确保不漏事件
     */
    private startDarwinPolling(): void {
        if (this.darwinPollTimer) {
            return;
        }
        this.darwinPollTimer = setInterval(() => {
            for (const filePath of this.fileStates.keys()) {
                if (filePath === this.eventsDir) {
                    continue;
                }
                void this.readNewEvents(filePath);
            }
        }, this.DARWIN_POLL_INTERVAL_MS);
    }
}
