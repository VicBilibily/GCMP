/*---------------------------------------------------------------------------------------------
 *  Proxy Agent 工具模块
 *  统一处理 ProxyAgent 的创建、缓存、关闭，以及代理 fetch 的包装
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import * as tls from 'node:tls';
import { EnvHttpProxyAgent, fetch as undiciFetch, ProxyAgent } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { Logger } from '../runtime/logger';

export type ProxiedFetch = typeof globalThis.fetch;
export const NO_PROXY_SENTINEL = 'noproxy';

type ManagedProxyDispatcher = ProxyAgent | EnvHttpProxyAgent;

interface SystemProxyConfig {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
}

const SYSTEM_PROXY_CACHE_MARKER = '::system::';
const SYSTEM_PROXY_CACHE_TTL_MS = 30_000;
let systemProxyConfigCache: { expiresAt: number; value: SystemProxyConfig | null } | null = null;

function getDirectFetch(): ProxiedFetch {
    return undiciFetch as unknown as ProxiedFetch;
}

export function isNoProxyValue(proxyUrl?: string | null): boolean {
    return typeof proxyUrl === 'string' && proxyUrl.trim().toLowerCase() === NO_PROXY_SENTINEL;
}

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
const proxyAgents = new Map<string, ManagedProxyDispatcher>();
/** 按代理地址缓存 fetch 包装函数，避免重复创建相同闭包 */
const proxiedFetchCache = new Map<string, ProxiedFetch>();

const proxySchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

function normalizeProxyEndpoint(proxyValue?: string): string | undefined {
    const trimmed = proxyValue?.trim();
    if (!trimmed) {
        return undefined;
    }

    try {
        const candidate = proxySchemePattern.test(trimmed) ? trimmed : `http://${trimmed}`;
        return new URL(candidate).toString();
    } catch {
        return undefined;
    }
}

function normalizeNoProxyList(rawValue?: string, separators = /[;,]/): string | undefined {
    const trimmed = rawValue?.trim();
    if (!trimmed) {
        return undefined;
    }

    const values = new Set<string>();
    for (const item of trimmed.split(separators)) {
        const entry = item.trim();
        if (!entry) {
            continue;
        }

        if (entry.toLowerCase() === '<local>') {
            values.add('localhost');
            values.add('127.0.0.1');
            values.add('::1');
            continue;
        }

        values.add(entry);
    }

    return values.size > 0 ? Array.from(values).join(',') : undefined;
}

function readCommandOutput(command: string, args: string[]): string | undefined {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        }).trim();
    } catch {
        return undefined;
    }
}

function buildSystemProxyCacheKey(proxyConfig: SystemProxyConfig, signature: string): string {
    return `${signature}${SYSTEM_PROXY_CACHE_MARKER}${proxyConfig.httpProxy || ''}::${proxyConfig.httpsProxy || ''}::${proxyConfig.noProxy || ''}`;
}

function clearStaleSystemProxyCacheEntries(activeCacheKey: string): void {
    for (const [cacheKey, agent] of proxyAgents) {
        if (cacheKey !== activeCacheKey && cacheKey.includes(SYSTEM_PROXY_CACHE_MARKER)) {
            proxyAgents.delete(cacheKey);
            void agent.close().catch(() => {
                /* 忽略关闭异常 */
            });
        }
    }

    for (const cacheKey of proxiedFetchCache.keys()) {
        if (cacheKey !== activeCacheKey && cacheKey.includes(SYSTEM_PROXY_CACHE_MARKER)) {
            proxiedFetchCache.delete(cacheKey);
        }
    }
}

function parseWindowsRegistryValue(output: string, valueName: string): string | undefined {
    const escapedName = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return output.match(new RegExp(`^\\s*${escapedName}\\s+REG_\\w+\\s+(.+)$`, 'mi'))?.[1]?.trim();
}

function parseWindowsProxyServer(proxyServer: string): SystemProxyConfig | null {
    const trimmed = proxyServer.trim();
    if (!trimmed) {
        return null;
    }

    if (!trimmed.includes('=')) {
        const proxyUrl = normalizeProxyEndpoint(trimmed);
        return proxyUrl ? { httpProxy: proxyUrl, httpsProxy: proxyUrl } : null;
    }

    const entries = new Map<string, string>();
    for (const segment of trimmed.split(';')) {
        const [rawKey, ...rest] = segment.split('=');
        if (!rawKey || rest.length === 0) {
            continue;
        }

        entries.set(rawKey.trim().toLowerCase(), rest.join('=').trim());
    }

    const sharedProxy = normalizeProxyEndpoint(entries.get('proxy') || entries.get('all'));
    const httpProxy = normalizeProxyEndpoint(entries.get('http')) || sharedProxy;
    const httpsProxy = normalizeProxyEndpoint(entries.get('https')) || sharedProxy || httpProxy;

    if (!httpProxy && !httpsProxy) {
        return null;
    }

    return { httpProxy, httpsProxy };
}

function detectWindowsSystemProxy(): SystemProxyConfig | null {
    const output = readCommandOutput('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    ]);
    if (!output) {
        return null;
    }

    const proxyEnable = parseWindowsRegistryValue(output, 'ProxyEnable');
    const proxyServer = parseWindowsRegistryValue(output, 'ProxyServer');
    const proxyOverride = parseWindowsRegistryValue(output, 'ProxyOverride');
    const autoConfigUrl = parseWindowsRegistryValue(output, 'AutoConfigURL');

    if (proxyEnable !== '0x1' || !proxyServer) {
        if (autoConfigUrl) {
            Logger.debug(
                '[ProxyAgent] Windows system proxy uses PAC/AutoConfigURL; direct PAC resolution is not supported'
            );
        }
        return null;
    }

    const proxyConfig = parseWindowsProxyServer(proxyServer);
    if (!proxyConfig) {
        return null;
    }

    return {
        ...proxyConfig,
        noProxy: normalizeNoProxyList(proxyOverride)
    };
}

function parseScutilValue(output: string, key: string): string | undefined {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return output.match(new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.+)$`, 'mi'))?.[1]?.trim();
}

function parseScutilExceptions(output: string): string | undefined {
    const block = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)^\s*\}/m)?.[1];
    if (!block) {
        return undefined;
    }

    const entries = Array.from(block.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)).map(match => match[1].trim());
    return normalizeNoProxyList(entries.join(','), /,/);
}

function buildMacProxyUrl(host?: string, port?: string): string | undefined {
    if (!host) {
        return undefined;
    }

    const normalizedHost = host.trim();
    const normalizedPort = port?.trim();
    return normalizeProxyEndpoint(normalizedPort ? `${normalizedHost}:${normalizedPort}` : normalizedHost);
}

function detectMacSystemProxy(): SystemProxyConfig | null {
    const output = readCommandOutput('scutil', ['--proxy']);
    if (!output) {
        return null;
    }

    const httpsEnabled = parseScutilValue(output, 'HTTPSEnable') === '1';
    const httpEnabled = parseScutilValue(output, 'HTTPEnable') === '1';
    const httpsProxy =
        httpsEnabled ?
            buildMacProxyUrl(parseScutilValue(output, 'HTTPSProxy'), parseScutilValue(output, 'HTTPSPort'))
        :   undefined;
    const httpProxy =
        httpEnabled ?
            buildMacProxyUrl(parseScutilValue(output, 'HTTPProxy'), parseScutilValue(output, 'HTTPPort'))
        :   undefined;

    if (!httpProxy && !httpsProxy) {
        return null;
    }

    return {
        httpProxy,
        httpsProxy: httpsProxy || httpProxy,
        noProxy: parseScutilExceptions(output)
    };
}

function detectSystemProxyConfig(): SystemProxyConfig | null {
    switch (process.platform) {
        case 'win32':
            return detectWindowsSystemProxy();
        case 'darwin':
            return detectMacSystemProxy();
        default:
            return null;
    }
}

function getSystemProxyConfig(): SystemProxyConfig | null {
    const proxySupport = vscode.workspace.getConfiguration('http').get<string>('proxySupport');
    if (proxySupport === 'off') {
        return null;
    }

    if (systemProxyConfigCache && systemProxyConfigCache.expiresAt > Date.now()) {
        return systemProxyConfigCache.value;
    }

    const value = detectSystemProxyConfig();
    systemProxyConfigCache = {
        expiresAt: Date.now() + SYSTEM_PROXY_CACHE_TTL_MS,
        value
    };
    return value;
}

function createSystemProxyFetch(): ProxiedFetch | undefined {
    const proxyConfig = getSystemProxyConfig();
    if (!proxyConfig) {
        return undefined;
    }

    const { signature } = getTlsConfig();
    const cacheKey = buildSystemProxyCacheKey(proxyConfig, signature);
    clearStaleSystemProxyCacheEntries(cacheKey);

    const cached = proxiedFetchCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    let agent = proxyAgents.get(cacheKey);
    if (!agent) {
        agent = new EnvHttpProxyAgent(proxyConfig);
        proxyAgents.set(cacheKey, agent);
        Logger.info(
            `[ProxyAgent] Created system proxy agent (http: ${redactProxyUrl(proxyConfig.httpProxy || '') || 'off'}, https: ${redactProxyUrl(proxyConfig.httpsProxy || '') || 'off'}, no_proxy: ${proxyConfig.noProxy || 'none'})`
        );
    }

    const proxied: ProxiedFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const options = {
            ...(init as unknown as UndiciRequestInit | undefined),
            dispatcher: agent
        } satisfies UndiciRequestInit;
        return (await undiciFetch(url as never, options)) as unknown as Response;
    }) as ProxiedFetch;
    proxiedFetchCache.set(cacheKey, proxied);
    return proxied;
}

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
    const normalizedProxyUrl = normalizeProxyEndpoint(proxyUrl) || proxyUrl;
    const { useSystemCertificates, signature } = getTlsConfig();
    const cacheKey = buildProxyCacheKey(normalizedProxyUrl, signature);
    clearStaleProxyCacheEntries(normalizedProxyUrl, cacheKey);

    let agent = proxyAgents.get(cacheKey);
    if (!agent) {
        agent = new ProxyAgent(normalizedProxyUrl);
        proxyAgents.set(cacheKey, agent);
        Logger.info(
            `[ProxyAgent] Created ProxyAgent for ${redactProxyUrl(normalizedProxyUrl)} (system CA: ${useSystemCertificates ? 'on' : 'off'})`
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
    if (isNoProxyValue(proxyUrl)) {
        return getDirectFetch();
    }
    const normalizedProxyUrl = normalizeProxyEndpoint(proxyUrl);
    if (!normalizedProxyUrl) {
        return createSystemProxyFetch() || getDirectFetch();
    }
    const { signature } = getTlsConfig();
    const cacheKey = buildProxyCacheKey(normalizedProxyUrl, signature);
    clearStaleProxyCacheEntries(normalizedProxyUrl, cacheKey);

    // 命中缓存则直接返回
    const cached = proxiedFetchCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = getProxyAgent(normalizedProxyUrl);
    const proxied: ProxiedFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const options = {
            ...(init as unknown as UndiciRequestInit | undefined),
            dispatcher: agent
        } satisfies UndiciRequestInit;
        return (await undiciFetch(url as never, options)) as unknown as Response;
    }) as ProxiedFetch;
    proxiedFetchCache.set(cacheKey, proxied);
    return proxied;
}

/**
 * 关闭所有缓存的 ProxyAgent，释放底层连接池
 */
export async function closeProxyAgents(): Promise<void> {
    const promises: Promise<unknown>[] = [];
    systemProxyConfigCache = null;
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
