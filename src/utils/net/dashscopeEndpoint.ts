/*---------------------------------------------------------------------------------------------
 *  阿里云百炼接入点主机映射
 *  国内站（cn-beijing）与国际站（ap-southeast-1）之间按主机名切换，路径保持不变
 *--------------------------------------------------------------------------------------------*/

import type { DashscopeConfig } from '../config/configManager';
import { configProviders } from '../../providers/config';

/** 国内站主机 → 国际站主机映射 */
const INTERNATIONAL_HOST_MAP: ReadonlyArray<readonly [string, string]> = [
    ['coding.dashscope.aliyuncs.com', 'coding-intl.dashscope.aliyuncs.com'],
    ['token-plan.cn-beijing.maas.aliyuncs.com', 'token-plan.ap-southeast-1.maas.aliyuncs.com'],
    ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']
];

/**
 * 归属百炼的 provider 槽位：标准槽位 + 内置模型清单声明的套餐变体
 * （Coding Plan / Token Plan 团队版 / Token Plan 个人版）
 */
const DASHSCOPE_PROVIDER_SLOTS: ReadonlySet<string> = new Set([
    'dashscope',
    ...configProviders.dashscope.models.map(model => model.provider).filter((slot): slot is string => Boolean(slot))
]);

/**
 * provider 槽位是否归属百炼（标准或套餐变体）。
 * compatible 面板中自定义的百炼模型同样命中，保证接入点切换覆盖全部百炼路径。
 */
export function isDashscopeProviderSlot(slot?: string): boolean {
    return slot !== undefined && DASHSCOPE_PROVIDER_SLOTS.has(slot);
}

/**
 * 按接入点替换 URL 的主机名；国内站或未知主机原样返回，路径与查询串保持不变
 */
export function resolveDashscopeBaseUrl(baseUrl: string, endpoint: DashscopeConfig['endpoint']): string {
    const hostMap =
        endpoint === 'ap-southeast-1' ? INTERNATIONAL_HOST_MAP : (
            INTERNATIONAL_HOST_MAP.map(([cnHost, internationalHost]) => [internationalHost, cnHost] as const)
        );

    const match = /^(https?:\/\/)([^/]+)/.exec(baseUrl);
    if (!match) {
        return baseUrl;
    }

    const mapped = hostMap.find(([sourceHost]) => sourceHost === match[2])?.[1];
    return mapped ? `${match[1]}${mapped}${baseUrl.slice(match[0].length)}` : baseUrl;
}
