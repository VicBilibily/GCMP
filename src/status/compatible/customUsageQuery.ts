/**---------------------------------------------------------------------------------------------
 *  Compatible 提供商通用余额查询器
 *  通过 provider usage / usages 配置查询余额
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from './balanceQuery';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigManager } from '../../utils/config/configManager';
import { getNumberByPath, getValueByPath } from '../../utils/text/pathExtractor';
import { KnownProviders } from '../../utils/config/knownProviders';
import { Logger } from '../../utils/runtime/logger';
import type { ProviderUsageConfig, UsageFieldValueSource } from '../../types/sharedTypes';
import {
    mergeProviderUsageOverride,
    parseCustomUsageTarget,
    resolveCustomUsageEntries,
    resolveUsageConfig
} from './usageConfigResolver';

/**
 * Compatible 提供商通用余额查询器
 * 处理内置默认 usage 配置及 providerOverrides 中的 usage/usages 覆盖
 */
export class CustomUsageQuery implements IBalanceQuery {
    /**
     * 查询 Compatible provider 余额
     * @param providerId 提供商标识
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[CustomUsageQuery] Querying balance for provider ${providerId}`);

        const usageTarget = parseCustomUsageTarget(providerId);
        const usageConfig = this.getUsageConfig(providerId);
        if (!usageConfig) {
            throw new Error(`No usage configuration found for provider ${providerId}`);
        }

        const requiresApiKey = usageConfig.authType !== 'none';
        const apiKey = requiresApiKey ? await ApiKeyManager.getApiKey(usageTarget.baseProviderId) : undefined;
        if (requiresApiKey && !apiKey) {
            throw new Error(`No API key found for provider ${providerId}`);
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

            this.assertSuccessConditions(data, usageConfig);

            const paid = this.resolveFieldValue(data, usageConfig.fields.paid, 'paid');
            const granted = this.resolveFieldValue(data, usageConfig.fields.granted, 'granted');

            let balance = this.resolveFieldValue(data, usageConfig.fields.balance, 'balance');
            if (balance === undefined && paid !== undefined && granted !== undefined) {
                balance = paid + granted;
            }

            if (balance === undefined) {
                throw new Error('Failed to extract balance from response');
            }

            return {
                balance,
                currency: usageConfig.unit || 'USD',
                paid,
                granted
            };
        } catch (error) {
            Logger.error(`[CustomUsageQuery] Failed to query balance for ${providerId}`, error);
            throw new Error(
                `Provider balance query failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * 获取 provider 的 usage/usages 配置
     */
    private getUsageConfig(providerId: string): ProviderUsageConfig | undefined {
        const overrides = ConfigManager.getProviderOverrides();
        const { baseProviderId, usageKey } = parseCustomUsageTarget(providerId);
        const override = mergeProviderUsageOverride(KnownProviders[baseProviderId], overrides[baseProviderId]);
        if (!override) {
            return undefined;
        }

        const usageEntries = resolveCustomUsageEntries(baseProviderId, override);

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
                ...(KnownProviders[providerId]?.customHeader || {}),
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
            throw new Error('Provider usage.url must be a valid http(s) URL');
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

    private assertSuccessConditions(data: unknown, usageConfig: ProviderUsageConfig): void {
        if (!usageConfig.successConditions || usageConfig.successConditions.length === 0) {
            return;
        }

        const isSuccess = usageConfig.successConditions.every(condition => {
            const actualValue = getValueByPath(data, condition.path);
            return actualValue === condition.equals;
        });

        if (isSuccess) {
            return;
        }

        const configuredMessage =
            usageConfig.errorMessagePath ? getValueByPath(data, usageConfig.errorMessagePath) : undefined;
        const errorMessage =
            typeof configuredMessage === 'string' && configuredMessage ?
                configuredMessage
            :   'Business success condition not matched';
        throw new Error(errorMessage);
    }

    private resolveFieldValue(
        data: unknown,
        fieldSource: UsageFieldValueSource | undefined,
        fieldName: 'balance' | 'paid' | 'granted'
    ): number | undefined {
        if (fieldSource === undefined) {
            return undefined;
        }

        if (typeof fieldSource === 'string') {
            return getNumberByPath(data, fieldSource);
        }

        if (fieldSource === null || typeof fieldSource !== 'object' || Array.isArray(fieldSource)) {
            throw new Error(`Invalid usage.fields.${fieldName} computed field configuration`);
        }

        if (
            (fieldSource.operation !== 'sum' && fieldSource.operation !== 'subtract') ||
            (fieldSource.treatMissingAsZero !== undefined && typeof fieldSource.treatMissingAsZero !== 'boolean') ||
            !Array.isArray(fieldSource.paths) ||
            fieldSource.paths.length === 0 ||
            fieldSource.paths.some(path => typeof path !== 'string' || path.trim().length === 0)
        ) {
            throw new Error(`Invalid usage.fields.${fieldName} computed field configuration`);
        }

        const values = fieldSource.paths.map(path => {
            const value = getNumberByPath(data, path);
            return value === undefined && fieldSource.treatMissingAsZero ? 0 : value;
        });
        if (values.some(value => value === undefined)) {
            return undefined;
        }

        const resolvedValues = values as number[];
        if (fieldSource.operation === 'sum') {
            return resolvedValues.reduce((total, value) => total + value, 0);
        }

        return resolvedValues.slice(1).reduce((total, value) => total - value, resolvedValues[0]);
    }
}
