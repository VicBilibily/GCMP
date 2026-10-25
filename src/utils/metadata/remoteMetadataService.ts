/*---------------------------------------------------------------------------------------------
 *  远程元数据服务（宿主层）
 *  生产环境：激活读磁盘缓存；仅主实例在用户活跃时每 3 分钟拉取 GitHub Pages 元数据并原子写盘，
 *  同时查询 npm registry latest 版本，npm 较新时自动覆盖 CLI 仿真版本（免等待发版），
 *  本地非主实例重读共享缓存；远程兼容模式独立联网刷新当前宿主缓存
 *  开发环境：直接读取共享源文件 src/utils/metadata/gcmp-metadata.json，跳过远程与磁盘缓存
 *  任何失败仅 warn 并保留当前生效值（内置兜底见 metadataResolver）
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { InterInstanceBus, type RemoteMetadataUpdatedEvent } from '../../interInstance';
import { LeaderElectionService } from '../../status/leaderElectionService';
import { UserActivityService } from '../../status/userActivityService';
import { Logger } from '../runtime/logger';
import { readMetadataSnapshot, withMetadataCacheTransaction, writeMetadataSnapshot } from './metadataCache';
import {
    hashCliMetadata,
    isOlderGcmpMetadata,
    mergeNpmCliVersions,
    parseGcmpMetadata,
    parseNpmLatestVersion,
    setRemoteCliMetadata,
    type GcmpCliMetadata,
    type NpmCliLatestVersions
} from './metadataResolver';
import { fetchRemoteText } from './remoteFetch';
import { RemoteModelsService } from './remoteModelsService';

const REMOTE_METADATA_URL = 'https://gcmp.dev/gcmp-metadata.json';
const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const NPM_CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const NPM_CODEX_PACKAGE = '@openai/codex';
const REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const METADATA_MAX_BYTES = 256 * 1024;
const NPM_LATEST_MAX_BYTES = 64 * 1024;

export class RemoteMetadataService {
    private static timer?: NodeJS.Timeout;
    private static cacheFilePath = '';
    private static localFilePath = '';
    private static isDevelopment = false;
    /** 当前生效快照的内容哈希，用于刷新时跳过无变化的写盘 */
    private static currentContentHash?: string;
    private static cacheLoadGeneration = 0;
    private static lifecycleGeneration = 0;
    private static disposed = false;
    private static refreshPromise?: Promise<void>;

    /** 初始化：同步段仅读本地/磁盘缓存（不发起网络），随后启动定时刷新（首次立即执行） */
    static async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.dispose();
        this.disposed = false;
        this.refreshPromise = undefined;
        const lifecycleGeneration = this.lifecycleGeneration;
        this.isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        this.cacheFilePath = path.join(context.globalStorageUri.fsPath, 'metadata', 'gcmp-metadata.json');
        this.localFilePath = path.join(context.extensionPath, 'src', 'utils', 'metadata', 'gcmp-metadata.json');

        await this.loadInitial();
        if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) {
            return;
        }

        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.metadata.refresh', async () => {
                if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) {
                    return;
                }
                // 一条命令同时刷新 CLI 元数据与模型清单；非主实例仅重读共享缓存
                await this.refresh();
                if (this.disposed || lifecycleGeneration !== this.lifecycleGeneration) {
                    return;
                }
                await RemoteModelsService.refresh();
                Logger.info('[Metadata] Manual refresh finished');
            }),
            LeaderElectionService.onLeaderChanged(isLeader => this.handleLeaderChanged(isLeader)),
            InterInstanceBus.subscribe('remoteMetadataUpdated', event => {
                const payload = (event as RemoteMetadataUpdatedEvent).payload;
                if (!this.isDevelopment && !LeaderElectionService.isLeader() && payload.target === 'cli') {
                    void this.loadFromCache();
                }
            }),
            {
                dispose: () => {
                    if (lifecycleGeneration === this.lifecycleGeneration) {
                        this.dispose();
                    }
                }
            }
        );

        this.refreshIfActive();
        this.timer = setInterval(() => this.refreshIfActive(), REFRESH_INTERVAL_MS);
        this.timer.unref();
        Logger.trace(`[Metadata] Service initialized (dev=${this.isDevelopment})`);
    }

    private static refreshIfActive(): void {
        if (
            this.isDevelopment ||
            (typeof vscode.env.remoteName === 'undefined' && !LeaderElectionService.isLeader()) ||
            UserActivityService.isUserActive()
        ) {
            void this.refresh();
        }
    }

    static dispose(): void {
        this.disposed = true;
        this.lifecycleGeneration++;
        this.cacheLoadGeneration++;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private static handleLeaderChanged(isLeader: boolean): void {
        if (this.disposed) {
            return;
        }
        this.cacheLoadGeneration++;
        if (!isLeader) {
            return;
        }
        const pendingRefresh = this.refreshPromise;
        if (!pendingRefresh) {
            this.refreshIfActive();
            return;
        }
        const lifecycleGeneration = this.lifecycleGeneration;
        const refreshAfterPending = (): void => {
            if (lifecycleGeneration === this.lifecycleGeneration && LeaderElectionService.isLeader()) {
                this.refreshIfActive();
            }
        };
        void pendingRefresh.then(refreshAfterPending, refreshAfterPending);
    }

    /** 激活同步段：开发环境优先读本地源文件，失败回退磁盘缓存；生产环境读磁盘缓存 */
    private static async loadInitial(): Promise<void> {
        if (this.isDevelopment && (await this.loadFromLocalFile())) {
            return;
        }
        await this.loadFromCache();
    }

    private static async loadFromLocalFile(): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        const lifecycleGeneration = this.lifecycleGeneration;
        const snapshot = await readMetadataSnapshot(this.localFilePath);
        if (!snapshot || this.disposed || lifecycleGeneration !== this.lifecycleGeneration) {
            return false;
        }
        setRemoteCliMetadata(snapshot.cli);
        this.currentContentHash = snapshot.contentHash;
        Logger.debug(`[Metadata] Loaded local metadata (hash=${snapshot.contentHash})`);
        return true;
    }

    private static async loadFromCache(): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        const generation = ++this.cacheLoadGeneration;
        const snapshot = await readMetadataSnapshot(this.cacheFilePath);
        if (!snapshot || generation !== this.cacheLoadGeneration) {
            return false;
        }
        setRemoteCliMetadata(snapshot.cli);
        this.currentContentHash = snapshot.contentHash;
        Logger.debug(`[Metadata] Loaded cached metadata (hash=${snapshot.contentHash})`);
        return true;
    }

    /** 立即刷新一次：生产拉远程并落盘，开发重读本地文件；失败保留当前生效值；并发调用单飞合并 */
    static async refresh(): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (!this.refreshPromise) {
            const refresh = this.refreshCore().finally(() => {
                if (this.refreshPromise === refresh) {
                    this.refreshPromise = undefined;
                }
            });
            this.refreshPromise = refresh;
        }
        await this.refreshPromise;
    }

    private static async refreshCore(): Promise<void> {
        if (this.isDevelopment) {
            if (!(await this.loadFromLocalFile())) {
                Logger.warn('[Metadata] Local metadata refresh failed, keeping current values');
            }
            return;
        }
        const remoteName = vscode.env.remoteName;
        const standalone = remoteName !== undefined;
        if (!standalone && !LeaderElectionService.isLeader()) {
            await this.loadFromCache();
            return;
        }
        const authorityTerm = LeaderElectionService.getAuthorityTerm();
        const generation = this.cacheLoadGeneration;
        const lifecycleGeneration = this.lifecycleGeneration;
        const isCurrentLifecycle = () => lifecycleGeneration === this.lifecycleGeneration;
        const canRefresh = () =>
            isCurrentLifecycle() &&
            vscode.env.remoteName === remoteName &&
            generation === this.cacheLoadGeneration &&
            (standalone ||
                (LeaderElectionService.isLeader() && LeaderElectionService.getAuthorityTerm() === authorityTerm));
        try {
            const text = await this.fetchText(REMOTE_METADATA_URL, METADATA_MAX_BYTES);
            if (text === undefined) {
                return;
            }
            const parsed = parseGcmpMetadata(text);
            if (!parsed) {
                Logger.warn('[Metadata] Remote metadata content invalid, keeping current values');
                return;
            }
            if (!canRefresh()) {
                if (isCurrentLifecycle()) {
                    await this.loadFromCache();
                }
                return;
            }
            const npmVersions = await this.fetchNpmCliVersions();
            if (!canRefresh()) {
                if (isCurrentLifecycle()) {
                    await this.loadFromCache();
                }
                return;
            }
            try {
                await withMetadataCacheTransaction(this.cacheFilePath, canRefresh, async () => {
                    const existing = await readMetadataSnapshot(this.cacheFilePath);
                    const siteIsOlder =
                        existing !== undefined &&
                        isOlderGcmpMetadata(parsed, {
                            schemaVersion: 1,
                            cli: existing.cli,
                            generatedAt: existing.generatedAt
                        });
                    const baseCli = siteIsOlder ? existing.cli : parsed.cli;
                    const generatedAt = siteIsOlder ? existing.generatedAt : parsed.generatedAt;
                    let cli = mergeNpmCliVersions(baseCli, npmVersions);
                    if (existing) {
                        cli = mergeNpmCliVersions(cli, existing.cli);
                    }
                    const contentHash = hashCliMetadata(cli);
                    const cacheUnchanged =
                        existing?.contentHash === contentHash && existing.generatedAt === generatedAt;
                    if (cacheUnchanged && contentHash === this.currentContentHash) {
                        Logger.trace(`[Metadata] Remote metadata unchanged (hash=${contentHash})`);
                        return;
                    }
                    if (!canRefresh()) {
                        if (isCurrentLifecycle()) {
                            await this.loadFromCache();
                        }
                        return;
                    }
                    if (!cacheUnchanged) {
                        await writeMetadataSnapshot(
                            this.cacheFilePath,
                            this.serializeSnapshot(parsed.schemaVersion, generatedAt, cli, contentHash),
                            canRefresh
                        );
                    }
                    if (!canRefresh()) {
                        if (isCurrentLifecycle()) {
                            await this.loadFromCache();
                        }
                        return;
                    }
                    if (contentHash === this.currentContentHash) {
                        return;
                    }
                    setRemoteCliMetadata(cli);
                    // 写盘成功才推进哈希并通知其他实例：失败时保留旧哈希，下一次 tick 重试落盘
                    this.currentContentHash = contentHash;
                    if (!standalone) {
                        InterInstanceBus.publish(
                            { type: 'remoteMetadataUpdated', payload: { target: 'cli', contentHash } },
                            { alsoFallback: true }
                        );
                    }
                    Logger.debug(`[Metadata] Remote metadata updated (hash=${contentHash})`);
                });
            } catch (error) {
                Logger.warn('[Metadata] Failed to persist metadata cache:', error);
            }
        } catch (error) {
            Logger.warn('[Metadata] Remote metadata fetch failed:', error);
        }
    }

    /** 拉取两个 CLI 包的 npm latest 版本（best-effort：任一失败仅不合并该字段） */
    private static async fetchNpmCliVersions(): Promise<NpmCliLatestVersions> {
        const [claudeCodeVersion, codexTuiVersion] = await Promise.all([
            this.fetchNpmLatestVersion(NPM_CLAUDE_CODE_PACKAGE),
            this.fetchNpmLatestVersion(NPM_CODEX_PACKAGE)
        ]);
        return { claudeCodeVersion, codexTuiVersion };
    }

    private static async fetchNpmLatestVersion(packageName: string): Promise<string | undefined> {
        try {
            const text = await this.fetchText(
                `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/latest`,
                NPM_LATEST_MAX_BYTES
            );
            if (text === undefined) {
                Logger.debug(`[Metadata] npm latest fetch failed (${packageName}), skipped`);
                return undefined;
            }
            const version = parseNpmLatestVersion(text);
            if (!version) {
                Logger.warn(`[Metadata] npm latest response invalid (${packageName}), skipped`);
            }
            return version;
        } catch (error) {
            Logger.warn(
                `[Metadata] npm latest request failed (${packageName}), skipped:`,
                error instanceof Error ? error.message : String(error)
            );
            return undefined;
        }
    }

    /** 将合并后的 cli 元数据序列化为缓存文件文本（generatedAt 保持站点时间戳语义） */
    private static serializeSnapshot(
        schemaVersion: number,
        generatedAt: number | undefined,
        cli: GcmpCliMetadata,
        contentHash: string
    ): string {
        return JSON.stringify({
            schemaVersion,
            contentHash,
            ...(generatedAt !== undefined ? { generatedAt: new Date(generatedAt).toISOString() } : {}),
            cli: {
                claudeCode: { version: cli.claudeCodeVersion },
                codexTui: { version: cli.codexTuiVersion, originator: cli.codexTuiOriginator }
            }
        });
    }

    private static fetchText(url: string, maxBytes: number): Promise<string | undefined> {
        return fetchRemoteText(url, maxBytes, '[Metadata]');
    }
}
