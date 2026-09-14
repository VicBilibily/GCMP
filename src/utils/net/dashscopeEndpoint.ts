/*---------------------------------------------------------------------------------------------
 *  阿里云百炼接入点主机映射
 *  国内站（cn-beijing）与国际站（ap-southeast-1）之间按主机名切换，路径保持不变
 *--------------------------------------------------------------------------------------------*/

import type { DashscopeConfig } from '../config/configManager';

/** 国内站主机 → 国际站主机映射 */
const INTERNATIONAL_HOST_MAP: ReadonlyArray<readonly [string, string]> = [
    ['coding.dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com'],
    ['token-plan.cn-beijing.maas.aliyuncs.com', 'token-plan.ap-southeast-1.maas.aliyuncs.com'],
    ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']
];

/**
 * 按接入点替换 URL 的主机名；国内站或未知主机原样返回，路径与查询串保持不变
 */
export function resolveDashscopeBaseUrl(baseUrl: string, endpoint: DashscopeConfig['endpoint']): string {
    if (endpoint !== 'ap-southeast-1') {
        return baseUrl;
    }

    const match = /^(https?:\/\/)([^/]+)/.exec(baseUrl);
    if (!match) {
        return baseUrl;
    }

    const mapped = INTERNATIONAL_HOST_MAP.find(([cnHost]) => cnHost === match[2])?.[1];
    return mapped ? `${match[1]}${mapped}${baseUrl.slice(match[0].length)}` : baseUrl;
}