/*---------------------------------------------------------------------------------------------
 *  Kilo Code 版本管理器
 *  负责从 VS Code 扩展市场获取、缓存和管理 kilocode.kilo-code 扩展的版本信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { KiloCodeHeaders, KiloCodeVersionInfo } from '../types/sharedTypes';

/**
 * Kilo Code 版本管理器
 * 提供版本获取、缓存和动态头部生成功能
 */
export class KiloCodeVersionManager {
    private static extensionContext: vscode.ExtensionContext | null = null;
    private static readonly EXTENSION_ID = 'kilocode.kilo-code';
    private static readonly CACHE_KEY = 'kilocode.version.cache';
    private static readonly CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // 24小时
    private static readonly MARKETPLACE_API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

    /**
     * 初始化版本管理器
     * @param context VS Code 扩展上下文
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.extensionContext = context;
        Logger.debug('Kilo Code 版本管理器已初始化');
    }

    /**
     * 从 VS Code 扩展市场获取 Kilo Code 扩展版本信息
     */
    private static async fetchVersionFromMarketplace(): Promise<KiloCodeVersionInfo | null> {
        try {
            Logger.trace('正在从扩展市场获取 Kilo Code 版本信息...');

            const response = await fetch(this.MARKETPLACE_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json;api-version=3.0-preview.1'
                },
                body: JSON.stringify({
                    filters: [{
                        criteria: [{
                            filterType: 7,
                            value: this.EXTENSION_ID
                        }]
                    }],
                    flags: 914
                })
            });

            if (!response.ok) {
                Logger.error(`扩展市场API请求失败: ${response.status} ${response.statusText}`);
                return null;
            }

            const data = await response.json() as {
                results?: Array<{
                    extensions?: Array<{
                        extensionId?: string;
                        displayName?: string;
                        shortDescription?: string;
                        versions?: Array<{
                            version?: string;
                            lastUpdated?: string;
                        }>;
                        statistics?: Array<{
                            statisticName?: string;
                            value?: number;
                        }>;
                    }>;
                }>;
            };

            const extension = data.results?.[0]?.extensions?.[0];
            if (!extension?.versions?.[0]?.version) {
                Logger.warn('从扩展市场响应中未找到有效的版本信息');
                return null;
            }

            const versionInfo: KiloCodeVersionInfo = {
                version: extension.versions[0].version,
                displayName: extension.displayName,
                lastUpdated: Date.now(),
                source: 'marketplace'
            };

            Logger.debug(`从扩展市场获取到 Kilo Code 版本: ${versionInfo.version}`);

            // 输出详细信息到控制台
            console.log('Kilo Code Marketplace Info:', {
                id: extension.extensionId,
                displayName: extension.displayName,
                version: versionInfo.version,
                description: extension.shortDescription,
                publishedDate: extension.versions[0].lastUpdated,
                downloadCount: extension.statistics?.find((s) => s.statisticName === 'install')?.value
            });

            return versionInfo;
        } catch (error) {
            Logger.error('从扩展市场获取 Kilo Code 版本失败:', error);
            return null;
        }
    }

    /**
     * 获取缓存的版本信息
     */
    private static getCachedVersionInfo(): KiloCodeVersionInfo | null {
        if (!this.extensionContext) {
            Logger.warn('扩展上下文未初始化，无法读取缓存');
            return null;
        }

        try {
            const cached = this.extensionContext.globalState.get<KiloCodeVersionInfo>(this.CACHE_KEY);
            if (!cached) {
                Logger.debug('没有找到缓存的版本信息');
                return null;
            }

            const isExpired = (Date.now() - cached.lastUpdated) > this.CACHE_EXPIRATION;
            if (isExpired) {
                Logger.debug('缓存的版本信息已过期');
                return null;
            }

            Logger.debug(`使用缓存的 Kilo Code 版本: ${cached.version} (来源: ${cached.source})`);
            return cached;
        } catch (error) {
            Logger.error('读取版本缓存失败:', error);
            return null;
        }
    }

    /**
     * 缓存版本信息
     */
    private static async cacheVersionInfo(versionInfo: KiloCodeVersionInfo): Promise<void> {
        if (!this.extensionContext) {
            Logger.warn('扩展上下文未初始化，无法缓存版本信息');
            return;
        }

        try {
            await this.extensionContext.globalState.update(this.CACHE_KEY, versionInfo);
            Logger.debug(`已缓存 Kilo Code 版本信息: ${versionInfo.version} (来源: ${versionInfo.source})`);
        } catch (error) {
            Logger.error('缓存版本信息失败:', error);
        }
    }

    /**
     * 创建回退版本信息
     */
    private static createFallbackVersionInfo(fallbackVersion: string): KiloCodeVersionInfo {
        return {
            version: fallbackVersion,
            lastUpdated: Date.now(),
            source: 'fallback'
        };
    }

    /**
     * 获取 Kilo Code 版本信息
     * 优先使用缓存，缓存过期时从市场获取，失败时回退到提供的版本
     */
    static async getVersionInfo(fallbackVersion?: string): Promise<KiloCodeVersionInfo | null> {
        // 1. 尝试从缓存获取
        const cached = this.getCachedVersionInfo();
        if (cached) {
            return cached;
        }

        // 2. 从扩展市场获取最新版本
        const marketplaceVersion = await this.fetchVersionFromMarketplace();
        if (marketplaceVersion) {
            // 缓存获取到的版本信息
            await this.cacheVersionInfo(marketplaceVersion);
            return marketplaceVersion;
        }

        // 3. 使用回退版本
        if (fallbackVersion) {
            const fallbackVersionInfo = this.createFallbackVersionInfo(fallbackVersion);
            Logger.warn(`使用回退版本: ${fallbackVersion}`);
            // 也缓存回退版本，避免重复请求失败
            await this.cacheVersionInfo(fallbackVersionInfo);
            return fallbackVersionInfo;
        }

        Logger.error('无法获取 Kilo Code 版本信息');
        return null;
    }

    /**
     * 强制更新版本缓存
     * 用于扩展初始化时主动获取最新版本
     */
    static async updateVersionCache(): Promise<KiloCodeVersionInfo | null> {
        try {
            Logger.debug('正在更新 Kilo Code 版本缓存...');

            const versionInfo = await this.fetchVersionFromMarketplace();
            if (versionInfo) {
                await this.cacheVersionInfo(versionInfo);
                Logger.debug(`Kilo Code 版本缓存已更新: ${versionInfo.version}`);
                return versionInfo;
            } else {
                Logger.warn('无法从市场获取 Kilo Code 版本，保持现有缓存');
                return this.getCachedVersionInfo();
            }
        } catch (error) {
            Logger.error('更新 Kilo Code 版本缓存失败:', error);
            return this.getCachedVersionInfo();
        }
    }

    /**
     * 生成动态的 kiloCode 头部配置
     * 基于获取到的版本信息更新请求头
     */
    static async generateDynamicHeaders(baseHeaders: KiloCodeHeaders): Promise<KiloCodeHeaders> {
        try {
            // 获取版本信息，使用原有头部中的版本作为回退
            const fallbackVersion = baseHeaders['X-KiloCode-Version'];
            const versionInfo = await this.getVersionInfo(fallbackVersion);

            if (versionInfo) {
                // 更新版本相关的头部信息
                return {
                    ...baseHeaders,
                    'X-KiloCode-Version': versionInfo.version,
                    'User-Agent': `Kilo-Code/${versionInfo.version}`
                };
            }

            // 如果无法获取版本信息，返回原始头部
            Logger.debug('使用原始 kiloCode 头部配置');
            return baseHeaders;
        } catch (error) {
            Logger.error('生成动态头部失败，使用原始配置:', error);
            return baseHeaders;
        }
    }

    /**
     * 清理版本缓存
     */
    static async clearCache(): Promise<void> {
        if (!this.extensionContext) {
            return;
        }

        try {
            await this.extensionContext.globalState.update(this.CACHE_KEY, undefined);
            Logger.info('版本缓存已清理');
        } catch (error) {
            Logger.error('清理版本缓存失败:', error);
        }
    }

    /**
     * 获取缓存状态信息
     */
    static getCacheStatus(): { hasCache: boolean; isExpired: boolean; version?: string; source?: string } {
        const cached = this.getCachedVersionInfo();
        if (!cached) {
            return { hasCache: false, isExpired: false };
        }

        const isExpired = (Date.now() - cached.lastUpdated) > this.CACHE_EXPIRATION;
        return {
            hasCache: true,
            isExpired,
            version: cached.version,
            source: cached.source
        };
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        this.extensionContext = null;
        Logger.trace('Kilo Code 版本管理器已清理');
    }
}