/*---------------------------------------------------------------------------------------------
 *  状态栏展示适配器（纯逻辑，无 UI 依赖）
 *  为通用 ProviderQuotaStatusBar 提供 query / summary / tables / 高亮 / 刷新提示。
 *  tables 逐字还原各状态栏重构前的 tooltip 表格（对齐/加粗元数据与重构前一致），
 *  与面板使用的 provider.format 表格是两套独立文案，禁止互相替换。
 *---------------------------------------------------------------------------------------------*/

import { t } from '../../utils/runtime/l10n';
import type { QuotaTable } from '../types';

/** 状态栏适配器：数据查询与展示决策，UI 渲染在 status 层通用类 */
export interface QuotaStatusAdapter<TRaw> {
    /** 查询状态数据（站点等上下文在此读取） */
    query(apiKey: string): Promise<TRaw>;
    /** 状态栏摘要文本（不含图标） */
    summary(data: TRaw): string;
    /** tooltip 表格（对齐/加粗元数据与重构前一致） */
    tables(data: TRaw): QuotaTable[];
    /** tooltip 补充行（markdown 原样输出） */
    details?(data: TRaw): string[];
    /** 高亮警告判定（缺省不高亮） */
    highlightWarning?(data: TRaw, threshold: number): boolean;
    /** 返回未来重置点时间戳；缓存写入早于重置点且当前已越过时触发刷新 */
    refreshHints?(data: TRaw, cachedAt: number): number[];
}

export { t };
export type { QuotaTable };
