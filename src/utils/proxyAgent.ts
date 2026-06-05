/*---------------------------------------------------------------------------------------------
 *  Proxy Agent 工具模块
 *  统一处理 ProxyAgent 的创建、缓存、关闭，以及代理 fetch 的包装
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as tls from 'node:tls';
import { fetch, ProxyAgent } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { Logger } from './logger';

export type ProxiedFetch = typeof globalThis.fetch;

const sensitiveHeaderNamePattern =
    /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

type TlsModuleWithCaApis = typeof tls & {
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
};

const tlsModule = tls as TlsModuleWithCaApis;
const initialDefaultCaCertificates = tlsModule.getCACertificates?.('default') ?? [];
let lastTlsConfigSignature: string | null = null;

/** 按代理地址缓存 ProxyAgent，避免重复创建连接池 */
/** 缓存键格式：${tlsSignature}::${proxyUrl} */
const proxyAgents = new Map<string, ProxyAgent>();
/** 按代理地址缓存 fetch 包装函数，避免重复创建相同闭包 */
const proxiedFetchCache = new Map<string, ProxiedFetch>();

function buildProxyCacheKey(proxyUrl: string, signature: string): string {
    return `${signature}::${proxyUrl}`;
}

function clearStaleProxyCacheEntries(proxyUrl: string, activeCacheKey: string): void {
    const proxyUrlSuffix = `::${proxyUrl}`;

    for (const [cacheKey, agent] of proxyAgents) {
        if (cacheKey !== activeCacheKey && cacheKey.endsWith(proxyUrlSuffix)) {
            proxyAgents.delete(cacheKey);
            void agent.close().catch(() => {
                /* 忽略关闭异常 */
            });
        }
    }

    for (const cacheKey of proxiedFetchCache.keys()) {
        if (cacheKey !== activeCacheKey && cacheKey.endsWith(proxyUrlSuffix)) {
            proxiedFetchCache.delete(cacheKey);
        }
    }
}

function getTlsConfig(): { caCertificates: string[]; signature: string; useSystemCertificates: boolean } {
    const useSystemCertificates = vscode.workspace
        .getConfiguration('gcmp')
        .get<boolean>('tls.useSystemCertificates', true);

    const caCertificates =
        useSystemCertificates && tlsModule.getCACertificates ?
            [...initialDefaultCaCertificates, ...tlsModule.getCACertificates('system')]
        :   [...initialDefaultCaCertificates];

    return {
        caCertificates,
        signature: `system:${useSystemCertificates};ca:${caCertificates.length}`,
        useSystemCertificates
    };
}

function configureTlsCertificates(): void {
    const { caCertificates, signature, useSystemCertificates } = getTlsConfig();
    if (lastTlsConfigSignature === signature) {
        return;
    }

    try {
        if (!tlsModule.getCACertificates || !tlsModule.setDefaultCACertificates) {
            Logger.debug('[TLS] Current Node.js type/runtime does not expose CA certificate APIs; skipping');
            lastTlsConfigSignature = signature;
            return;
        }

        if (useSystemCertificates) {
            const systemCertificates = tlsModule.getCACertificates('system');
            if (systemCertificates.length > 0) {
                tlsModule.setDefaultCACertificates(caCertificates);
                Logger.info(
                    `[TLS] Enabled system CA certificates (${systemCertificates.length} additional certificate(s))`
                );
            } else {
                Logger.debug('[TLS] No system CA certificates available; keeping Node default CA list');
            }
        } else {
            tlsModule.setDefaultCACertificates(initialDefaultCaCertificates);
            Logger.info('[TLS] Using Node default CA certificates only');
        }
        lastTlsConfigSignature = signature;
    } catch (error) {
        Logger.warn('[TLS] Failed to configure CA certificates', error);
    }
}

/**
 * 脱敏代理 URL，仅保留协议+主机+端口，移除用户凭据
 */
export function redactProxyUrl(raw: string): string {
    try {
        const u = new URL(raw);
        if (u.username || u.password) {
            u.password = '';
            u.username = '';
            return u.toString();
        }
        return raw;
    } catch {
        return raw;
    }
}

/**
 * 脱敏 HTTP 头，仅保留头名，隐藏敏感值
 */
export function redactHeaders(headers?: Record<string, string>): Record<string, string> {
    if (!headers) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, sensitiveHeaderNamePattern.test(key) ? '***' : value])
    );
}

/**
 * 对配置对象进行递归脱敏，避免日志泄露代理凭据或敏感头部
 */
export function sanitizeConfigForLogging<T>(value: T): T {
    const sanitize = (current: unknown, key?: string): unknown => {
        if (typeof current === 'string') {
            if (key === 'proxy') {
                return redactProxyUrl(current);
            }
            if (key === 'apiKey') {
                return '***';
            }
            return current;
        }

        if (Array.isArray(current)) {
            return current.map(item => sanitize(item));
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        const result: Record<string, unknown> = {};
        for (const [entryKey, entryValue] of Object.entries(current)) {
            if (
                entryKey === 'customHeader' &&
                entryValue &&
                typeof entryValue === 'object' &&
                !Array.isArray(entryValue)
            ) {
                result[entryKey] = redactHeaders(entryValue as Record<string, string>);
                continue;
            }

            result[entryKey] = sanitize(entryValue, entryKey);
        }
        return result;
    };

    return sanitize(value) as T;
}

/**
 * 获取或创建指定代理 URL 的 ProxyAgent
 */
export function getProxyAgent(proxyUrl: string): ProxyAgent {
    const { useSystemCertificates, signature } = getTlsConfig();
    const cacheKey = buildProxyCacheKey(proxyUrl, signature);
    clearStaleProxyCacheEntries(proxyUrl, cacheKey);

    let agent = proxyAgents.get(cacheKey);
    if (!agent) {
        agent = new ProxyAgent(proxyUrl);
        proxyAgents.set(cacheKey, agent);
        Logger.info(
            `[ProxyAgent] Created ProxyAgent for ${redactProxyUrl(proxyUrl)} (system CA: ${useSystemCertificates ? 'on' : 'off'})`
        );
    }
    return agent;
}

/**
 * 创建带代理的 fetch 函数
 * 如果提供了 proxyUrl，则自动注入 undici 的 dispatcher 选项
 */
export function createProxiedFetch(proxyUrl?: string): ProxiedFetch {
    configureTlsCertificates();
    if (!proxyUrl) {
        return fetch as unknown as ProxiedFetch;
    }
    const { signature } = getTlsConfig();
    const cacheKey = buildProxyCacheKey(proxyUrl, signature);
    clearStaleProxyCacheEntries(proxyUrl, cacheKey);

    // 命中缓存则直接返回
    const cached = proxiedFetchCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = getProxyAgent(proxyUrl);
    const proxied: ProxiedFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const options = {
            ...(init as unknown as UndiciRequestInit | undefined),
            dispatcher: agent
        } satisfies UndiciRequestInit;
        return (await fetch(url as never, options)) as unknown as Response;
    }) as ProxiedFetch;
    proxiedFetchCache.set(cacheKey, proxied);
    return proxied;
}

/**
 * 关闭所有缓存的 ProxyAgent，释放底层连接池
 */
export async function closeProxyAgents(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const [cacheKey, agent] of proxyAgents) {
        proxyAgents.delete(cacheKey);
        proxiedFetchCache.delete(cacheKey);
        promises.push(
            agent.close().catch(() => {
                /* 忽略关闭异常 */
            })
        );
    }
    if (promises.length) {
        Logger.info(`[ProxyAgent] Closed ${promises.length} ProxyAgent(s)`);
    }
    await Promise.all(promises);
}
