/*---------------------------------------------------------------------------------------------
 *  IPC 降级文件传输
 *  当 Leader/Follower 之间无法建立本地 IPC 时，通过文件系统事件文件实现跨窗口同步
 *  每个实例写入自己的 events 文件，所有实例监听目录下全部 events 文件
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceEvent, parseEventsFromBuffer, INTER_INSTANCE_EVENT_TYPES } from './eventProtocol';
import { StatusLogger } from '../utils/statusLogger';

export interface FallbackTransportOptions {
    /** 当前实例 ID */
    instanceId: string;
    /** 接收到事件时的回调 */
    onEvent: (event: InterInstanceEvent) => void;
}

interface FileReadState {
    /** 文件最后读取的字节位置 */
    position: number;
    /** Node fs.FSWatcher */
    watcher?: fs.FSWatcher;
}

const EVENT_FILE_PREFIX = 'events-';
const EVENT_FILE_SUFFIX = '.jsonl';
const EVENT_FILE_RETENTION_MS = 24 * 60 * 60 * 1000; // 1 天

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
    stop(): void {
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
        StatusLogger.debug('[FallbackTransport] Stopped file-based fallback transport');
    }

    /**
     * 将事件追加写入本实例的事件文件
     */
    async publish(event: InterInstanceEvent): Promise<void> {
        if (this.disposed || !this.ownFilePath) {
            return;
        }
        try {
            const line = JSON.stringify(event) + '\n';
            await fs.promises.appendFile(this.ownFilePath, line, 'utf8');
        } catch (error) {
            StatusLogger.warn('[FallbackTransport] Failed to append event to own file', error);
        }
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
                const stats = fs.statSync(filePath);
                this.fileStates.set(filePath, { position: stats.size });
                this.watchFile(filePath);
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
                    this.fileStates.set(filePath, { position: 0 });
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

    private async readNewEvents(filePath: string): Promise<void> {
        if (this.disposed) {
            return;
        }
        const state = this.fileStates.get(filePath);
        if (!state) {
            return;
        }

        let handle: fs.promises.FileHandle | undefined;
        try {
            const stats = await fs.promises.stat(filePath).catch(() => null);
            if (!stats) {
                // 文件被删除
                this.fileStates.delete(filePath);
                return;
            }

            // 文件被截断或重写，从头读取
            if (stats.size < state.position) {
                state.position = 0;
            }

            const readLength = stats.size - state.position;
            if (readLength <= 0) {
                return;
            }

            handle = await fs.promises.open(filePath, 'r');
            const buffer = Buffer.alloc(readLength);
            await handle.read(buffer, 0, readLength, state.position);
            state.position = stats.size;

            const chunk = buffer.toString('utf8');
            const { events } = parseEventsFromBuffer(chunk);
            for (const event of events) {
                if (!INTER_INSTANCE_EVENT_TYPES.includes(event.type)) {
                    continue;
                }
                if (event.senderInstanceId === this.options.instanceId) {
                    continue;
                }
                this.options.onEvent(event);
            }
        } catch (error) {
            StatusLogger.warn(`[FallbackTransport] Failed to read events from ${filePath}`, error);
        } finally {
            await handle?.close();
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
