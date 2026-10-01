/**---------------------------------------------------------------------------------------------
 *  Compatible 提供商通用余额查询器
 *  通过 provider usage / usages 配置查询余额
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult, BalanceQueryItem } from './balanceQuery';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigManager } from '../../utils/config/configManager';
import { getValueByPath } from '../../utils/text/pathExtractor';
import { resolveBuiltinProviderConfig } from '../../utils/config/knownProviders';
import { Logger } from '../../utils/runtime/logger';
import { applyCustomHeaders, isSensitiveHeaderName, mergeCustomHeaders } from '../../utils/net/httpHeaders';
import type {
    CustomHeaderValue,
    CustomHeaders,
    ProviderUsageConfig,
    UsageFieldItemConfig,
    UsageFieldValueSource
} from '../../types/sharedTypes';
import { resolveUsageFieldValue } from './usageComputedField';
import {
    mergeProviderUsageOverride,
    parseCustomUsageTarget,
    resolveCustomUsageEntries,
    resolveUsageConfig
} from './usageConfigResolver';

interface UsageItemContext {
    data: unknown;
    scopes: string[][];
    bindings: ReadonlyMap<string, number>;
}

/**
 * Compatible 提供商通用余额查询器
 * 处理内置默认 usage 配置及 providerOverrides 中的 usage/usages 覆盖
 */
export class CustomUsageQuery implements IBalanceQuery {
    /**
     * 查询 Compatible provider 余额
     * @param providerId 提供商标识
     */
    async queryBalance(providerId: string, apiKeyOverride?: string, usageKey?: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[CustomUsageQuery] Querying balance for provider ${providerId}`);

        const usageTarget = this.getUsageConfig(providerId, usageKey);
        if (!usageTarget) {
            throw new Error(`No usage configuration found for provider ${providerId}`);
        }
        const { baseProviderId, usageConfig } = usageTarget;

        const requiresApiKey = usageConfig.authType !== 'none';
        const apiKey = requiresApiKey ? (apiKeyOverride ?? (await ApiKeyManager.getApiKey(baseProviderId))) : undefined;
        if (requiresApiKey && !apiKey) {
            throw new Error(`No API key found for provider ${providerId}`);
        }

        const requestUrl = this.buildRequestUrl(usageConfig, apiKey);

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        applyCustomHeaders(
            headers,
            mergeCustomHeaders(
                this.buildMergedCustomHeader(baseProviderId, apiKey, usageConfig.authType),
                usageConfig.headers
            )
        );

        if (apiKey && usageConfig.authType !== 'url_key' && usageConfig.authType !== 'none') {
            applyCustomHeaders(headers, { Authorization: `Bearer ${apiKey}` });
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
                providerKey: baseProviderId
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

            const items = this.resolveUsageItems(data, usageConfig);
            if (items.length === 0) {
                throw new Error('Failed to extract balance from response');
            }

            const primary = items[0];
            return {
                balance: primary.balance,
                currency: primary.currency,
                paid: primary.paid,
                granted: primary.granted,
                items
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
    private getUsageConfig(
        providerId: string,
        usageKey?: string
    ): { baseProviderId: string; usageConfig: ProviderUsageConfig } | undefined {
        const overrides = ConfigManager.getProviderOverrides();
        const target = parseCustomUsageTarget(providerId);
        const targets: (typeof target)[] = [{ baseProviderId: providerId, usageKey }];
        if (
            usageKey === undefined &&
            target.usageKey !== undefined &&
            !overrides[providerId] &&
            !resolveBuiltinProviderConfig(providerId)
        ) {
            targets.push(target);
        }

        for (const { baseProviderId, usageKey } of targets) {
            const override = mergeProviderUsageOverride(
                resolveBuiltinProviderConfig(baseProviderId),
                overrides[baseProviderId]
            );
            const usageEntries = resolveCustomUsageEntries(baseProviderId, override);
            const usageConfig =
                usageKey !== undefined ? usageEntries.find(entry => entry.usageKey === usageKey)?.usageConfig
                : usageEntries.length === 1 ? usageEntries[0].usageConfig
                : resolveUsageConfig(undefined, override?.usage);
            if (usageConfig) {
                return { baseProviderId, usageConfig };
            }
        }
        return undefined;
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
    ): CustomHeaders {
        const allOverrides = ConfigManager.getProviderOverrides();
        const mergedCustomHeader = this.filterProviderCustomHeaders(
            mergeCustomHeaders(
                allOverrides['compatible']?.customHeader,
                resolveBuiltinProviderConfig(providerId)?.customHeader,
                allOverrides[providerId]?.customHeader
            ),
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
        headers: CustomHeaders,
        authType: ProviderUsageConfig['authType']
    ): CustomHeaders {
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
    private shouldStripProviderHeader(headerName: string, headerValue: CustomHeaderValue): boolean {
        return (
            isSensitiveHeaderName(headerName) ||
            (typeof headerValue === 'string' && /\$\{\s*APIKEY\s*\}/i.test(headerValue))
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

    /**
     * 从接口返回数据中解析出所有额度项
     */
    resolveUsageItems(data: unknown, usageConfig: ProviderUsageConfig): BalanceQueryItem[] {
        const fieldConfigs: UsageFieldItemConfig[] =
            Array.isArray(usageConfig.fields) ? usageConfig.fields : [usageConfig.fields];
        const context: UsageItemContext = { data, scopes: [], bindings: new Map() };
        return fieldConfigs.flatMap(fields => this.parseFieldContext(context, fields, usageConfig));
    }

    private parseFieldContext(
        context: UsageItemContext,
        fields: UsageFieldItemConfig,
        usageConfig: ProviderUsageConfig
    ): BalanceQueryItem[] {
        let split: { path: string[]; items: unknown[] } | undefined;
        if (fields.arrayPath !== undefined) {
            const arrayPath = fields.arrayPath.trim();
            const path = this.getPathSegments(arrayPath === '$' || arrayPath === '@' ? '' : arrayPath);
            const boundPath = this.bindItemPath(path, context.bindings);
            split = this.findArrayInPath(context.data, boundPath);
            const selectedArrayPath = boundPath.slice(0, -1).join('.');
            if (!split && !context.bindings.has(selectedArrayPath)) {
                return [];
            }
        }

        const balancePaths = this.getSourcePaths(fields.balance);
        for (const path of balancePaths) {
            if (split) {
                break;
            }
            split = this.findArrayInPath(context.data, this.getItemPath(context, path));
        }

        if (split) {
            const arrayPath = split.path;
            return split.items.flatMap((_item, index) =>
                this.parseFieldContext(
                    {
                        ...context,
                        scopes: [...context.scopes, [...arrayPath, String(index)]],
                        bindings: new Map([...context.bindings, [arrayPath.join('.'), index]])
                    },
                    fields,
                    usageConfig
                )
            );
        }

        const paid = this.resolveItemField(context, fields.paid, 'paid');
        const granted = this.resolveItemField(context, fields.granted, 'granted');
        let balance = this.resolveItemField(context, fields.balance, 'balance');
        if (balance === undefined && paid !== undefined && granted !== undefined) {
            balance = paid + granted;
        }
        if (balance === undefined) {
            return [];
        }

        return [
            {
                displayName: this.resolveDisplayName(context, fields.displayName),
                balance,
                currency: fields.unit || usageConfig.unit || 'USD',
                paid,
                granted
            }
        ];
    }

    private resolveItemField(
        context: UsageItemContext,
        source: UsageFieldValueSource | undefined,
        name: 'balance' | 'paid' | 'granted'
    ): number | undefined {
        const mapped = source === undefined ? undefined : this.mapFieldSource(context, source);
        return resolveUsageFieldValue({ response: context.data }, mapped, name);
    }

    private mapFieldSource(context: UsageItemContext, source: UsageFieldValueSource): UsageFieldValueSource {
        if (typeof source === 'string') {
            const path = this.getItemPath(context, source)
                .join('.')
                .replace(/(^|\.)\*/g, '[*]');
            return path ? `response.${path}` : 'response';
        }
        return {
            ...source,
            paths: source.paths.map(entry =>
                typeof entry === 'number' || (typeof entry === 'string' && !entry.trim()) ?
                    entry
                :   this.mapFieldSource(context, entry)
            )
        };
    }

    private getSourcePaths(source: UsageFieldValueSource): string[] {
        return typeof source === 'string' ?
                [source]
            :   source.paths.flatMap(entry => (typeof entry === 'number' ? [] : this.getSourcePaths(entry)));
    }

    private resolveDisplayName(
        context: UsageItemContext,
        pattern?: UsageFieldItemConfig['displayName']
    ): string | undefined {
        if (pattern !== undefined) {
            const source = typeof pattern === 'string' ? pattern : pattern.path;
            const path = this.getItemPath(context, source).join('.');
            const value = path ? getValueByPath(context.data, path) : context.data;
            const name =
                typeof value === 'string' && value.trim() ? value.trim()
                : typeof value === 'number' && Number.isFinite(value) ? String(value)
                : source;
            return typeof pattern === 'string' ? name : `${pattern.prefix ?? ''}${name}${pattern.suffix ?? ''}`;
        }

        const scope = context.scopes.at(-1);
        const candidate = scope ? getValueByPath(context.data, scope.join('.')) : undefined;
        if (candidate && typeof candidate === 'object') {
            for (const key of ['name', 'model', 'title', 'id', 'type', 'plan']) {
                const val = (candidate as Record<string, unknown>)[key];
                if (typeof val === 'string' && val.trim().length > 0) {
                    return val.trim();
                }
            }
        }
        return scope ? `#${Number(scope.at(-1)) + 1}` : undefined;
    }

    private getItemPath(context: UsageItemContext, source: string): string[] {
        const path = this.getPathSegments(source);
        const absolutePath = this.bindItemPath(path, context.bindings);
        if (absolutePath.join('.') !== path.join('.')) {
            return absolutePath;
        }

        for (let i = context.scopes.length - 1; i >= 0; i--) {
            const relativePath = this.bindItemPath([...context.scopes[i], ...path], context.bindings);
            const marker = relativePath.findIndex(segment => segment === '*' || segment === '[]');
            const prefix = marker < 0 ? relativePath : relativePath.slice(0, marker);
            if (
                this.findArrayInPath(context.data, relativePath) ||
                getValueByPath(context.data, prefix.join('.')) !== undefined
            ) {
                return relativePath;
            }
        }
        return absolutePath;
    }

    private bindItemPath(path: string[], bindings: ReadonlyMap<string, number>): string[] {
        const result: string[] = [];
        for (let i = 0; i <= path.length; i++) {
            const segment = path[i];
            let index = bindings.get(result.join('.'));
            while (index !== undefined && segment !== '*' && (segment === undefined || !/^\d+$/.test(segment))) {
                result.push(String(index));
                if (segment === '[]') {
                    break;
                }
                index = bindings.get(result.join('.'));
            }
            if (segment === '[]' && index !== undefined) {
                continue;
            }
            if (segment !== undefined) {
                result.push(segment);
            }
        }
        return result;
    }

    private getPathSegments(path: string): string[] {
        return path
            .trim()
            .replace(/\[(\d+|\*)\]/g, '.$1')
            .replace(/\[\]/g, '.[]')
            .split('.')
            .filter(s => s.length > 0);
    }

    private findArrayInPath(data: unknown, path: string[]): { path: string[]; items: unknown[] } | undefined {
        let current = data;
        for (let i = 0; i <= path.length; i++) {
            const segment = path[i];
            if (Array.isArray(current)) {
                if (segment === '*' || (segment !== '[]' && path.slice(i).includes('*'))) {
                    return undefined;
                }
                if (segment === undefined || !/^\d+$/.test(segment)) {
                    return { path: path.slice(0, i), items: current };
                }
            }
            if (current == null || typeof current !== 'object') {
                return undefined;
            }
            current = (current as Record<string, unknown>)[segment];
        }
        return undefined;
    }
}
