/*---------------------------------------------------------------------------------------------
 *  状态栏展示适配器（纯逻辑，无 UI 依赖）
 *  为通用 ProviderQuotaStatusBar 提供 query / summary / tables / 高亮 / 刷新提示。
 *  tables 逐字还原各状态栏重构前的 tooltip 表格（对齐/加粗元数据与重构前一致），
 *  与面板使用的 provider.format 表格是两套独立文案，禁止互相替换。
 *---------------------------------------------------------------------------------------------*/

export { zhipuStatusAdapter, type ZhipuStatusData } from './zhipu';
export { minimaxStatusAdapter, type MiniMaxStatusData } from './minimax';
export { kimiStatusAdapter, type KimiStatusData } from './kimi';
export { deepseekStatusAdapter, type DeepSeekStatusData } from './deepseek';
export { moonshotStatusAdapter, type MoonshotStatusData } from './moonshot';
export { clinepassStatusAdapter, type ClinePassStatusData } from './clinepass';
export { opencodeStatusAdapter, type OpenCodeStatusData } from './opencode';
export { commandcodeStatusAdapter, type CommandCodeStatusData } from './commandcode';
export type { QuotaStatusAdapter } from './types';
