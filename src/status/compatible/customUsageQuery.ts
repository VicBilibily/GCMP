/**---------------------------------------------------------------------------------------------
 *  自定义 Compatible 提供商余额查询器
 *  通过 gcmp.providerOverrides.<customProviderId>.usage / usages 配置查询余额
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from './balanceQuery';
import { StatusLogger } from '../../utils/statusLogger';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { ConfigManager } from '../../utils/configManager';
import { getNumberByPath } from '../../utils/pathExtractor';
import { Logger } from '../../utils/logger';
import type { ProviderUsageConfig } from '../../types/sharedTypes';
import { parseCustomUsageTarget, resolveCustomUsageEntries, resolveUsageConfig } from './usageConfigResolver';

/**
 * 自定义 Compatible 提供商余额查询器
 * 仅处理在 gcmp.providerOverrides 中配置了 usage/usages 的自定义 provider
 */
export class CustomUsageQuery implements IBalanceQuery {
    /**
     * 查询自定义 provider 余额
     * @param providerId 自定义提供商标识
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[CustomUsageQuery] Querying balance for custom provider ${providerId}`);

        const usageTarget = parseCustomUsageTarget(providerId);
        const usageConfig = this.getUsageConfig(providerId);
        if (!usageConfig) {
            throw new Error(`No usage configuration found for custom provider ${providerId}`);
        }

        const requiresApiKey = usageConfig.authType !== 'none';
        const apiKey = requiresApiKey ? await ApiKeyManager.getApiKey(usageTarget.baseProviderId) : undefined;
        if (requiresApiKey && !apiKey) {
            throw new Error(`No API key found for custom provider ${providerId}`);
        }

        const requestUrl = this.buildRequestUrl(usageConfig, apiKey);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.buildMergedCustomHeader(usageTarget.baseProviderId, apiKey, usageConfig.authType),
            ...(usageConfig.headers || {})
        };

        if (apiKey && usageConfig.authType !== 'url_key' && usageConfig.authType !== 'none') {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const requestInit: RequestInit = {
            method: usageConfig.method || 'GET',
            headers
        };

        if (usageConfig.method === 'POST' && usageConfig.body) {
            requestInit.body = JSON.stringify(usageConfig.body);
        }

        try {
            const response = await ConfigManager.fetchWithProxy(requestUrl, requestInit, {
                providerKey: usageTarget.baseProviderId
            });

            const responseText = await response.text();

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }

            let data: unknown;
            try {
                data = JSON.parse(responseText);
            } catch {
                throw new Error(`Invalid JSON response: ${responseText.substring(0, 200)}`);
            }

            const balance = getNumberByPath(data, usageConfig.fields.balance);
            if (balance === undefined) {
                throw new Error(`Failed to extract balance from response using path "${usageConfig.fields.balance}"`);
            }

            return {
                balance,
                currency: usageConfig.unit || 'USD',
                paid: getNumberByPath(data, usageConfig.fields.paid),
                granted: getNumberByPath(data, usageConfig.fields.granted)
            };
        } catch (error) {
            Logger.error(`[CustomUsageQuery] Failed to query balance for ${providerId}`, error);
            throw new Error(
                `Custom provider balance query failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * 获取 provider 的 usage/usages 配置
     */
    private getUsageConfig(providerId: string): ProviderUsageConfig | undefined {
        const overrides = ConfigManager.getProviderOverrides();
        const { baseProviderId, usageKey } = parseCustomUsageTarget(providerId);
        const override = overrides[baseProviderId];
        if (!override) {
            return undefined;
        }

        const usageEntries = override.usages ? resolveCustomUsageEntries(baseProviderId, override) : [];

        if (usageKey) {
            const usageEntry = usageEntries.find(entry => entry.usageKey === usageKey);
            return usageEntry?.usageConfig;
        }

        if (usageEntries.length === 1) {
            return usageEntries[0].usageConfig;
        }

        return resolveUsageConfig(undefined, override.usage);
    }

    /**
     * 构造合并后的自定义请求头
     * 合并顺序：compatible 全局默认 → provider 专属覆盖 → usage 级别
     * 并处理 ${APIKEY} 占位符替换
     *
     * 注意：
     * - 当 authType 为 'url_key' 或 'none' 时，仍保留 provider 级非鉴权头（如 UA / 版本头），
     *   但会过滤鉴权相关头，以及值中包含 ${APIKEY} 占位符的头，避免与 usage 显式声明的鉴权方式冲突。
     */
    private buildMergedCustomHeader(
        providerId: string,
        apiKey: string | undefined,
        authType: ProviderUsageConfig['authType']
    ): Record<string, string> {
        const allOverrides = ConfigManager.getProviderOverrides();
        const mergedCustomHeader = this.filterProviderCustomHeaders(
            {
                ...(allOverrides['compatible']?.customHeader || {}),
                ...(allOverrides[providerId]?.customHeader || {})
            },
            authType
        );

        if (!apiKey || authType === 'url_key' || authType === 'none') {
            return mergedCustomHeader;
        }

        return ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);
    }

    /**
     * 在显式鉴权模式下过滤 provider 级鉴权头，保留普通请求头。
     */
    private filterProviderCustomHeaders(
        headers: Record<string, string>,
        authType: ProviderUsageConfig['authType']
    ): Record<string, string> {
        if (authType !== 'url_key' && authType !== 'none') {
            return headers;
        }

        return Object.fromEntries(
            Object.entries(headers).filter(
                ([headerName, headerValue]) => !this.shouldStripProviderHeader(headerName, headerValue)
            )
        );
    }

    /**
     * 判断 provider 级请求头是否应在显式鉴权模式下剔除。
     */
    private shouldStripProviderHeader(headerName: string, headerValue: string): boolean {
        return (
            /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(headerName) ||
            /(^|[-_])(api[-_]?key|auth[-_]?token|access[-_]?token)([-_]|$)/i.test(headerName) ||
            /\$\{\s*APIKEY\s*\}/i.test(headerValue)
        );
    }

    /**
     * 构造最终请求 URL
     */
    private buildRequestUrl(usageConfig: ProviderUsageConfig, apiKey: string | undefined): string {
        if (!/^https?:\/\//.test(usageConfig.url)) {
            throw new Error('Custom provider usage.url must be a valid http(s) URL');
        }

        const endpoint = usageConfig.url;

        const searchParams = new URLSearchParams();

        if (usageConfig.params) {
            for (const [key, value] of Object.entries(usageConfig.params)) {
                searchParams.set(key, value);
            }
        }

        if (usageConfig.authType === 'url_key') {
            if (!apiKey) {
                throw new Error('authType is url_key but no API key is available');
            }
            searchParams.set('key', apiKey);
        }

        const queryString = searchParams.toString();
        if (!queryString) {
            return endpoint;
        }

        const separator = endpoint.includes('?') ? '&' : '?';
        return `${endpoint}${separator}${queryString}`;
    }
}
