/*---------------------------------------------------------------------------------------------
 *  Provider 配额查询 - 泛型基类
 *  统一"构建请求 → HTTP → JSON 解析 → 业务校验 → 格式化"骨架；
 *  子类通过 TRaw 泛型声明各自的原始数据结构，仅实现差异部分。
 *---------------------------------------------------------------------------------------------*/

import { ConfigManager } from '../../utils/config/configManager';
import { t } from '../../utils/runtime/l10n';
import type { QuotaQueryResult } from '../types';

export abstract class QuotaProviderBase<TRaw> {
    /** fetchWithProxy 的 providerKey（代理选择用） */
    protected abstract readonly providerKey: string;

    /** 构建最终 HTTP 请求（无站点概念的子类可省略 site 参数） */
    protected abstract buildRequest(apiKey: string, site: string | undefined): { url: string; init: RequestInit };

    /** 解析已通过 JSON.parse 的响应体并完成业务校验，失败时抛错 */
    protected abstract parseAndValidate(payload: unknown, response: Response, responseText: string): TRaw;

    /** 将原始数据格式化为面板展示结构 */
    protected abstract format(raw: TRaw, lastUpdated: string): QuotaQueryResult;

    /** JSON 解析失败错误（子类可覆盖为 provider 专属文案） */
    protected createInvalidJsonError(parseError: unknown): Error {
        return new Error(t('Invalid response format: {0}', '响应格式错误: {0}', String(parseError)));
    }

    /** 查询原始数据：HTTP 执行与 JSON 解析统一在此，业务校验交给子类 */
    async fetch(apiKey: string, site?: string): Promise<TRaw> {
        const { url, init } = this.buildRequest(apiKey, site);
        const response = await ConfigManager.fetchWithProxy(url, init, { providerKey: this.providerKey });
        const responseText = await response.text();

        let payload: unknown;
        try {
            payload = JSON.parse(responseText);
        } catch (parseError) {
            throw this.createInvalidJsonError(parseError);
        }

        return this.parseAndValidate(payload, response, responseText);
    }

    /** 查询并格式化（面板入口） */
    async query(apiKey: string, site: string | undefined, lastUpdated: string): Promise<QuotaQueryResult> {
        return this.format(await this.fetch(apiKey, site), lastUpdated);
    }
}
