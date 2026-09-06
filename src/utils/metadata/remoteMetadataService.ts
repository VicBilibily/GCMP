/*---------------------------------------------------------------------------------------------
 *  远程元数据服务（宿主层）
 *  生产环境：激活读磁盘缓存，随后每 2 小时定时拉取 GitHub Pages 元数据，成功则原子写盘
 *  开发环境：直接读取共享源文件 src/utils/metadata/gcmp-metadata.json，跳过远程与磁盘缓存
 *  任何失败仅 warn 并保留当前生效值（内置兜底见 metadataResolver）
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../runtime/logger';
import { readMetadataSnapshot, writeMetadataSnapshot } from './metadataCache';
import { hashCliMetadata, parseGcmpMetadata, setRemoteCliMetadata } from './metadataResolver';

const REMOTE_METADATA_URL = 'https://gcmp.dev/gcmp-metadata.json';
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export class RemoteMetadataService {
    private static timer?: NodeJS.Timeout;
    private static cacheFilePath = '';
    private static localFilePath = '';
    private static isDevelopment = false;
    /** 当前生效快照的内容哈希，用于刷新时跳过无变化的写盘 */
    private static currentContentHash?: string;

    /** 初始化：同步段仅读本地/磁盘缓存（不发起网络），随后启动定时刷新（首次立即执行） */
    static async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        this.cacheFilePath = path.join(context.globalStorageUri.fsPath, 'metadata', 'gcmp-metadata.json');
        this.localFilePath = path.join(context.extensionPath, 'src', 'utils', 'metadata', 'gcmp-metadata.json');

        await this.loadInitial();

        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.metadata.refresh', async () => {
                await this.refresh();
                Logger.info('[Metadata] Manual refresh finished');
            }),
            { dispose: () => this.dispose() }
        );

        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
        this.timer.unref();
        Logger.trace(`[Metadata] Service initialized (dev=${this.isDevelopment})`);
    }

    private static dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 激活同步段：开发环境优先读本地源文件，失败回退磁盘缓存；生产环境读磁盘缓存 */
    private static async loadInitial(): Promise<void> {
        if (this.isDevelopment && (await this.loadFromLocalFile())) {
            return;
        }
        await this.loadFromCache();
    }

    private static async loadFromLocalFile(): Promise<boolean> {
        const snapshot = await readMetadataSnapshot(this.localFilePath);
        if (!snapshot) {
            return false;
        }
        setRemoteCliMetadata(snapshot.cli);
        this.currentContentHash = snapshot.contentHash;
        Logger.debug(`[Metadata] Loaded local metadata (hash=${snapshot.contentHash})`);
        return true;
    }

    private static async loadFromCache(): Promise<boolean> {
        const snapshot = await readMetadataSnapshot(this.cacheFilePath);
        if (!snapshot) {
            return false;
        }
        setRemoteCliMetadata(snapshot.cli);
        this.currentContentHash = snapshot.contentHash;
        Logger.debug(`[Metadata] Loaded cached metadata (hash=${snapshot.contentHash})`);
        return true;
    }

    /** 立即刷新一次：生产拉远程并落盘，开发重读本地文件；失败保留当前生效值 */
    static async refresh(): Promise<void> {
        if (this.isDevelopment) {
            if (!(await this.loadFromLocalFile())) {
                Logger.warn('[Metadata] Local metadata refresh failed, keeping current values');
            }
            return;
        }
        try {
            const abortController = new AbortController();
            const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
            let text: string;
            try {
                const response = await ConfigManager.fetchWithProxy(REMOTE_METADATA_URL, {
                    signal: abortController.signal
                });
                if (!response.ok) {
                    Logger.warn(`[Metadata] Remote metadata fetch failed: HTTP ${response.status}`);
                    return;
                }
                text = await response.text();
            } finally {
                clearTimeout(timeoutId);
            }
            const parsed = parseGcmpMetadata(text);
            if (!parsed) {
                Logger.warn('[Metadata] Remote metadata content invalid, keeping current values');
                return;
            }
            const contentHash = hashCliMetadata(parsed.cli);
            if (contentHash === this.currentContentHash) {
                Logger.trace(`[Metadata] Remote metadata unchanged (hash=${contentHash})`);
                return;
            }
            setRemoteCliMetadata(parsed.cli);
            try {
                await writeMetadataSnapshot(this.cacheFilePath, text);
                // 写盘成功才推进哈希：失败时保留旧哈希，下一次 tick 重试落盘
                this.currentContentHash = contentHash;
                Logger.debug(`[Metadata] Remote metadata updated (hash=${contentHash})`);
            } catch (error) {
                Logger.warn('[Metadata] Failed to persist metadata cache:', error);
            }
        } catch (error) {
            Logger.warn('[Metadata] Remote metadata fetch failed:', error);
        }
    }
}
