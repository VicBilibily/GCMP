/**
 * Vue 响应式系统 Chunk
 *
 * 这个文件作为独立的 Vue chunk，导出 Vue 的响应式 API
 * 可以在多个 WebView 之间共享，减少重复打包
 */

// 导出 Vue 的响应式 API
export { ref, computed, reactive, readonly } from 'vue';

// 导出 createApp 用于创建应用实例
export { createApp } from 'vue';

// 导出类型定义
export type { Ref, ComputedRef, DeepReadonly } from 'vue';
