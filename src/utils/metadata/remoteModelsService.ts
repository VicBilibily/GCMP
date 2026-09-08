/*---------------------------------------------------------------------------------------------
 *  模型清单远程更新服务（宿主层）
 *  生产环境：激活读磁盘缓存；仅主实例每 2 小时拉取 /configs/index.json 清单，
 *  仅下载内容哈希有变化的 provider 文件，白名单清洗后原子更新共享缓存并热推送
 *  非主实例在定时/手动刷新或收到主实例通知时重读共享缓存，不发起远程同步
 *  模型策略：远端与内置合并去重，同 id 用远端定义，内置剩余项作为回退（待下次插件更新移除）
 *  缓存提交为整体事务：任一变化 provider 下载/写盘失败即放弃本轮提交，等待下轮重试
 *  开发环境：直接读取共享源文件目录 src/providers/config/*.json，跳过远程与磁盘缓存
 *  任何失败仅 warn 并保留当前生效值（内置兜底即 configProviders 本身）
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { InterInstanceBus, type RemoteMetadataUpdatedEvent } from '../../interInstance';
import { LeaderElectionService } from '../../status/leaderElectionService';
import { Logger } from '../runtime/logger';
import { registeredProviders } from '../config/providerRegistry';
import { configProviders } from '../../providers/config';
import { writeMetadataSnapshot } from './metadataCache';
import { fetchRemoteText } from './remoteFetch';
import type { ModelConfig } from '../../types/sharedTypes';
import {
    compareGcmpVersions,
    hashModelsText,
    parseModelsManifest,
    sanitizeProviderModels,
    setRemoteProviderModels,
    getRemoteModelsOverlay
} from './modelsResolver';
import type { ModelsManifest } from './modelsResolver';

const MANIFEST_URL = 'https://gcmp.dev/configs/index.json';
const CONFIG_FILE_BASE_URL = 'https://gcmp.dev/configs/';
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MANIFEST_FILE_NAME = 'index.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const PROVIDER_CONFIG_MAX_BYTES = 4 * 1024 * 1024;

export class RemoteModelsService {
    private static timer?: NodeJS.Timeout;
    private static cacheDir = '';
    private static localDir = '';
    private static isDevelopment = false;
    private static refreshPromise?: Promise<void>;
    private static cacheLoadGeneration = 0;
    /** 各 provider 当前生效快照的文本哈希，用于刷新时跳过无变化的下载与写盘 */
    private static currentContentHashes = new Map<string, string>();
    private static currentManifestHash?: string;

    /** 初始化：同步段仅读本地/磁盘缓存并启动定时器；首次网络刷新在 provider 注册完成后触发 */
    static async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        this.cacheDir = path.join(context.globalStorageUri.fsPath, 'models');
        this.localDir = path.join(context.extensionPath, 'src', 'providers', 'config');

        await this.loadInitial();

        context.subscriptions.push(
            LeaderElectionService.onLeaderChanged(isLeader => this.handleLeaderChanged(isLeader)),
            InterInstanceBus.subscribe('remoteMetadataUpdated', event => {
                const payload = (event as RemoteMetadataUpdatedEvent).payload;
                if (!this.isDevelopment && !LeaderElectionService.isLeader() && payload.target === 'models') {
                    void this.loadFromCache();
                }
            }),
            { dispose: () => this.dispose() }
        );

        this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
        this.timer.unref();
        Logger.trace(`[Models] Service initialized (dev=${this.isDevelopment})`);
    }

    /** 提供商注册完成后启动首次网络刷新，避免热推送早于注册表初始化而丢失 */
    static startAfterProvidersRegistered(): void {
        this.pushLoadedModelsToProviders();
        void this.refresh();
    }

    private static pushLoadedModelsToProviders(): void {
        const loadedModels = getRemoteModelsOverlay();
        if (loadedModels.size > 0) {
            this.pushToProviders(new Map([...loadedModels].map(([providerKey, models]) => [providerKey, [...models]])));
        }
    }

    private static handleLeaderChanged(isLeader: boolean): void {
        this.cacheLoadGeneration++;
        if (!isLeader) {
            return;
        }
        const pendingRefresh = this.refreshPromise;
        if (!pendingRefresh) {
            void this.refresh();
            return;
        }
        const refreshAfterPending = (): void => {
            if (LeaderElectionService.isLeader()) {
                void this.refresh();
            }
        };
        void pendingRefresh.then(refreshAfterPending, refreshAfterPending);
    }

    private static dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 激活同步段：开发环境优先读共享源文件目录，失败回退磁盘缓存；生产环境读磁盘缓存 */
    private static async loadInitial(): Promise<void> {
        if (this.isDevelopment && (await this.loadFromLocalFiles())) {
            return;
        }
        await this.loadFromCache();
    }

    /** 读取并清洗单个 provider 文件文本；哈希不符或清洗失败返回 undefined */
    private static sanitizeConfigText(
        providerKey: string,
        text: string,
        expectedHash?: string
    ): ModelConfig[] | undefined {
        if (expectedHash && hashModelsText(text) !== expectedHash) {
            Logger.warn(`[Models] ${providerKey}: content hash mismatch, skipped`);
            return undefined;
        }
        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            return undefined;
        }
        const builtinModels = configProviders[providerKey as keyof typeof configProviders]?.models;
        // 传入内置模型：目的地/密钥槽位字段（baseUrl/provider 等）仅从内置同 id 模型继承
        const result = sanitizeProviderModels(payload, builtinModels);
        if (!result) {
            Logger.warn(`[Models] ${providerKey}: invalid provider payload, skipped`);
            return undefined;
        }
        if (result.droppedModels > 0 || result.strippedFields.length > 0) {
            Logger.warn(
                `[Models] ${providerKey}: dropped ${result.droppedModels} invalid models, stripped fields: ${result.strippedFields.join(', ') || '(none)'}`
            );
        }
        return result.models;
    }

    private static providerCacheFileName(entryId: string, contentHash: string): string {
        return `${entryId}.${contentHash}.json`;
    }

    private static manifestGeneratedAt(text: string): number | undefined {
        try {
            const value = JSON.parse(text) as unknown;
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                return undefined;
            }
            const generatedAt = (value as Record<string, unknown>).generatedAt;
            if (typeof generatedAt !== 'string') {
                return undefined;
            }
            const timestamp = Date.parse(generatedAt);
            return Number.isFinite(timestamp) ? timestamp : undefined;
        } catch {
            return undefined;
        }
    }

    private static isOlderManifest(incomingText: string, existingText: string): boolean {
        const incoming = parseModelsManifest(incomingText);
        const existing = parseModelsManifest(existingText);
        if (!incoming || !existing) {
            return false;
        }
        const versionComparison = compareGcmpVersions(incoming.gcmpVersion, existing.gcmpVersion);
        if (versionComparison !== undefined && versionComparison !== 0) {
            return versionComparison < 0;
        }
        const incomingTimestamp = this.manifestGeneratedAt(incomingText);
        const existingTimestamp = this.manifestGeneratedAt(existingText);
        return (
            existingTimestamp !== undefined &&
            (incomingTimestamp === undefined || incomingTimestamp < existingTimestamp)
        );
    }

    private static async persistCache(
        manifestText: string,
        downloadedFiles: ReadonlyMap<string, string>,
        supportedEntries: readonly ModelsManifest['providers'][number][],
        isCurrent?: () => boolean
    ): Promise<boolean> {
        const manifestPath = path.join(this.cacheDir, MANIFEST_FILE_NAME);
        const existingText = await this.readText(manifestPath);
        if (existingText && this.isOlderManifest(manifestText, existingText)) {
            return false;
        }
        for (const entry of supportedEntries) {
            if (downloadedFiles.has(entry.id)) {
                continue;
            }
            try {
                await fs.access(path.join(this.cacheDir, this.providerCacheFileName(entry.id, entry.contentHash)));
            } catch {
                return false;
            }
        }
        for (const [entryId, text] of downloadedFiles) {
            if (isCurrent && !isCurrent()) {
                return false;
            }
            await writeMetadataSnapshot(
                path.join(this.cacheDir, this.providerCacheFileName(entryId, hashModelsText(text))),
                text
            );
        }
        if (isCurrent && !isCurrent()) {
            return false;
        }
        await writeMetadataSnapshot(manifestPath, manifestText);
        // 清单一旦落盘即提交成功：后续清理失败或任期失效不得撤销
        await this.pruneStaleCacheFiles(supportedEntries, isCurrent).catch(error => {
            Logger.warn('[Models] Failed to prune stale config cache:', error);
        });
        return true;
    }

    private static async pruneStaleCacheFiles(
        entries: readonly ModelsManifest['providers'][number][],
        isCurrent?: () => boolean
    ): Promise<boolean> {
        const keep = new Set([
            MANIFEST_FILE_NAME,
            ...entries.map(entry => this.providerCacheFileName(entry.id, entry.contentHash))
        ]);
        const files = await fs.readdir(this.cacheDir);
        if (isCurrent && !isCurrent()) {
            return false;
        }
        for (const file of files.filter(file => /^[a-z0-9-]+\.[0-9a-f]{12}\.json$/.test(file) && !keep.has(file))) {
            if (isCurrent && !isCurrent()) {
                return false;
            }
            try {
                await fs.rm(path.join(this.cacheDir, file), { force: true });
            } catch (error) {
                Logger.warn('[Models] Failed to prune stale config cache:', error);
            }
        }
        return !isCurrent || isCurrent();
    }

    private static async readText(filePath: string): Promise<string | undefined> {
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch {
            return undefined;
        }
    }

    /** 开发环境：逐个读取共享源文件目录的 provider 配置作为快照（无清单、无新鲜度门槛） */
    private static async loadFromLocalFiles(): Promise<boolean> {
        let files: string[];
        try {
            files = (await fs.readdir(this.localDir)).filter(name => name.endsWith('.json'));
        } catch {
            return false;
        }
        let loaded = 0;
        const changedProviders = new Map<string, ModelConfig[]>();
        const removedProviders = new Map<string, ModelConfig[]>();
        // 目录中存在的 provider 集合：移除判定以文件消失为准，读取/清洗失败不触发移除
        const expected = new Set(files.map(file => path.basename(file, '.json')));
        for (const file of files) {
            const providerKey = path.basename(file, '.json');
            const text = await this.readText(path.join(this.localDir, file));
            if (!text) {
                continue;
            }
            const models = this.sanitizeConfigText(providerKey, text);
            if (!models) {
                continue;
            }
            const hash = hashModelsText(text);
            if (this.currentContentHashes.get(providerKey) !== hash) {
                changedProviders.set(providerKey, models);
            }
            setRemoteProviderModels(providerKey, models);
            this.currentContentHashes.set(providerKey, hash);
            loaded++;
        }
        // 本地已删除的配置文件同步移出快照（回退内置）
        for (const providerKey of [...this.currentContentHashes.keys()]) {
            if (!expected.has(providerKey)) {
                this.currentContentHashes.delete(providerKey);
                setRemoteProviderModels(providerKey, undefined);
                const builtinModels = configProviders[providerKey as keyof typeof configProviders]?.models;
                if (builtinModels) {
                    removedProviders.set(providerKey, builtinModels);
                }
            }
        }
        if (changedProviders.size > 0 || removedProviders.size > 0) {
            this.pushToProviders(new Map([...changedProviders, ...removedProviders]));
        }
        if (loaded > 0) {
            Logger.debug(`[Models] Loaded local configs (${loaded} providers)`);
        }
        return loaded > 0;
    }

    /** 生产环境读磁盘缓存；激活与主实例更新通知共用，按哈希差异热推送 */
    private static async loadFromCache(): Promise<boolean> {
        const generation = ++this.cacheLoadGeneration;
        const manifestText = await this.readText(path.join(this.cacheDir, MANIFEST_FILE_NAME));
        if (!manifestText) {
            return false;
        }
        const manifest = parseModelsManifest(manifestText);
        if (!manifest) {
            return false;
        }
        const manifestHash = hashModelsText(manifestText);
        const supportedProviderIds = new Set(
            manifest.providers.filter(entry => Object.hasOwn(configProviders, entry.id)).map(entry => entry.id)
        );
        const previousProviderIds = new Set(this.currentContentHashes.keys());
        const snapshot = new Map<string, { hash: string; models: ModelConfig[] }>();
        let loadedCount = 0;
        for (const entry of manifest.providers) {
            if (!Object.hasOwn(configProviders, entry.id)) {
                continue;
            }
            const text = await this.readText(
                path.join(this.cacheDir, this.providerCacheFileName(entry.id, entry.contentHash))
            );
            if (!text) {
                continue;
            }
            const models = this.sanitizeConfigText(entry.id, text, entry.contentHash);
            if (!models) {
                continue;
            }
            snapshot.set(entry.id, { hash: entry.contentHash, models });
            loadedCount++;
        }
        if (generation !== this.cacheLoadGeneration || loadedCount !== supportedProviderIds.size) {
            return false;
        }
        const changedProviders = new Map<string, ModelConfig[]>();
        const removedProviders = new Map<string, ModelConfig[]>();
        for (const [entryId, value] of snapshot) {
            if (this.currentContentHashes.get(entryId) !== value.hash) {
                changedProviders.set(entryId, value.models);
            }
        }
        this.currentManifestHash = manifestHash;
        this.currentContentHashes = new Map([...snapshot].map(([id, value]) => [id, value.hash]));
        for (const [entryId, value] of snapshot) {
            setRemoteProviderModels(entryId, value.models);
        }
        for (const providerKey of previousProviderIds) {
            if (!supportedProviderIds.has(providerKey)) {
                this.currentContentHashes.delete(providerKey);
                setRemoteProviderModels(providerKey, undefined);
                const builtinModels = configProviders[providerKey as keyof typeof configProviders]?.models;
                if (builtinModels) {
                    removedProviders.set(providerKey, builtinModels);
                }
            }
        }
        if (changedProviders.size > 0 || removedProviders.size > 0) {
            this.pushToProviders(new Map([...changedProviders, ...removedProviders]));
        }
        if (loadedCount > 0) {
            Logger.debug(`[Models] Loaded cached configs (${loadedCount} providers, manifest ${manifest.gcmpVersion})`);
        }
        return true;
    }

    /** 立即刷新一次：生产拉远程清单并按哈希条件下载，开发重读本地目录；失败保留当前生效值 */
    static async refresh(): Promise<void> {
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshCore().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        await this.refreshPromise;
    }

    private static async refreshCore(): Promise<void> {
        if (this.isDevelopment) {
            if (!(await this.loadFromLocalFiles())) {
                Logger.warn('[Models] Local configs refresh failed, keeping current values');
            }
            return;
        }
        if (!LeaderElectionService.isLeader()) {
            await this.loadFromCache();
            return;
        }
        const authorityTerm = LeaderElectionService.getAuthorityTerm();
        const stillLeader = () =>
            LeaderElectionService.isLeader() && LeaderElectionService.getAuthorityTerm() === authorityTerm;
        try {
            const manifestText = await this.fetchText(MANIFEST_URL, MANIFEST_MAX_BYTES);
            if (!manifestText || !stillLeader()) {
                return;
            }
            const manifest = parseModelsManifest(manifestText);
            if (!manifest) {
                Logger.warn('[Models] Remote manifest content invalid, keeping current values');
                return;
            }
            const manifestHash = hashModelsText(manifestText);
            const manifestChanged = this.currentManifestHash !== manifestHash;
            const supportedEntries = manifest.providers.filter(entry => Object.hasOwn(configProviders, entry.id));
            const supportedProviderIds = new Set(supportedEntries.map(entry => entry.id));

            const downloadedFiles = new Map<string, string>();
            const changedProviders = new Map<string, ModelConfig[]>();
            const removedProviders = new Map<string, ModelConfig[]>();
            let failedChangedEntries = 0;
            for (const entry of supportedEntries) {
                if (this.currentContentHashes.get(entry.id) === entry.contentHash) {
                    try {
                        await fs.access(
                            path.join(this.cacheDir, this.providerCacheFileName(entry.id, entry.contentHash))
                        );
                        continue;
                    } catch {
                        // 缓存文件缺失时继续下载，但提交成功前保留当前快照状态
                    }
                }
                try {
                    if (!stillLeader()) {
                        return;
                    }
                    const text = await this.fetchText(
                        `${CONFIG_FILE_BASE_URL}${entry.id}.json`,
                        PROVIDER_CONFIG_MAX_BYTES
                    );
                    if (!stillLeader()) {
                        return;
                    }
                    if (!text) {
                        failedChangedEntries++;
                        continue;
                    }
                    const models = this.sanitizeConfigText(entry.id, text, entry.contentHash);
                    if (!models) {
                        failedChangedEntries++;
                        continue;
                    }
                    downloadedFiles.set(entry.id, text);
                    changedProviders.set(entry.id, models);
                } catch (error) {
                    if (!stillLeader()) {
                        return;
                    }
                    failedChangedEntries++;
                    Logger.warn(`[Models] Failed to refresh ${entry.id}:`, error);
                }
            }

            // 清单中移除的 provider：回退内置并随 manifest 一次性提交
            for (const providerKey of [...this.currentContentHashes.keys()]) {
                if (!supportedProviderIds.has(providerKey)) {
                    const builtinModels = configProviders[providerKey as keyof typeof configProviders]?.models;
                    if (builtinModels) {
                        removedProviders.set(providerKey, builtinModels);
                    }
                }
            }

            if (failedChangedEntries > 0) {
                Logger.warn(`[Models] Skipped manifest commit: ${failedChangedEntries} provider(s) failed to refresh`);
                return;
            }
            if (downloadedFiles.size === 0 && removedProviders.size === 0 && !manifestChanged) {
                return;
            }
            if (!stillLeader()) {
                Logger.trace('[Models] Leadership changed before cache commit, skipped');
                return;
            }

            if (!(await this.persistCache(manifestText, downloadedFiles, supportedEntries, stillLeader))) {
                Logger.warn('[Models] Failed to persist config cache, keeping current values');
                return;
            }
            if (!stillLeader()) {
                await this.loadFromCache();
                return;
            }
            for (const [entryId, models] of changedProviders) {
                setRemoteProviderModels(entryId, models);
            }
            for (const providerKey of removedProviders.keys()) {
                setRemoteProviderModels(providerKey, undefined);
            }
            this.currentContentHashes = new Map(supportedEntries.map(entry => [entry.id, entry.contentHash]));
            this.currentManifestHash = manifestHash;
            this.pushToProviders(new Map([...changedProviders, ...removedProviders]));
            InterInstanceBus.publish(
                { type: 'remoteMetadataUpdated', payload: { target: 'models', contentHash: manifestHash } },
                { alsoFallback: true }
            );
            Logger.debug(
                `[Models] Remote configs updated (${changedProviders.size + removedProviders.size} providers, manifest ${manifest.gcmpVersion})`
            );
        } catch (error) {
            Logger.warn('[Models] Remote configs fetch failed:', error);
        }
    }

    /** 热推送：替换各 provider 基线模型并重算覆盖配置、清模型缓存、触发 VS Code 模型列表刷新 */
    private static pushToProviders(changedProviders: ReadonlyMap<string, ModelConfig[]>): void {
        for (const [providerKey, models] of changedProviders) {
            const provider = registeredProviders[providerKey];
            if (!provider) {
                continue;
            }
            try {
                provider.updateRemoteModels(models);
            } catch (error) {
                Logger.warn(`[Models] Failed to push models to ${providerKey}:`, error);
            }
        }
    }

    private static fetchText(url: string, maxBytes: number): Promise<string | undefined> {
        return fetchRemoteText(url, maxBytes, '[Models]');
    }
}
