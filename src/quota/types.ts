/*---------------------------------------------------------------------------------------------
 *  Provider 配额查询共享层 - 类型定义
 *  被 src/quota 内部、src/status 状态栏、src/ui/configSetManager 面板共用。
 *---------------------------------------------------------------------------------------------*/

/** 配额/余额展示表格（一行行字符串，已格式化好） */
export interface QuotaTable {
    /** 表格标题（可选，用于多表格场景的分组标题；markdown 语法由填值方决定，渲染方原样输出） */
    title?: string;
    /** 列头 */
    columns: string[];
    /** 行数据（每行为已格式化的字符串数组） */
    rows: string[][];
    /** 各列对齐方式（缺省由渲染方默认；与状态栏重构前逐列对齐保持一致） */
    align?: Array<'left' | 'center' | 'right'>;
    /** 需要加粗的列索引（缺省 = 无） */
    boldColumns?: number[];
}

/** provider 配额查询返回结构（已格式化好的展示数据） */
export interface QuotaQueryResult {
    /** 指标类型：usage=剩余额度/限频，balance=账号余额 */
    metricType: 'usage' | 'balance';
    /** 摘要文本（如 "85% (92%)"） */
    summary: string;
    /** 主表格列表 */
    tables?: QuotaTable[];
    /** 多余额条目（自定义 provider 多账号场景） */
    quotaEntries?: Array<{ label?: string; summary: string; tables?: QuotaTable[] }>;
    /** 补充说明（如"最高并发 · 5"） */
    details?: string[];
    /** 最后更新时间（已格式化） */
    lastUpdated: string;
}
