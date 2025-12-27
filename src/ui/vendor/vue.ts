/**
 * Vue 模块重新导出
 *
 * 这个文件将全局的 VueChunk 重新导出，作为 'vue' 模块的替代
 * 用于在 WebView 中共享 Vue 响应式系统
 */

// 从全局 VueChunk 获取响应式 API
const vue = globalThis.VueChunk;

export const ref = vue.ref;
export const computed = vue.computed;
export const reactive = vue.reactive;
export const readonly = vue.readonly;
export const createApp = vue.createApp;
