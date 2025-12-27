/**
 * Vue Chunk 全局类型声明
 *
 * 声明 globalThis.VueChunk 的类型
 */

declare global {
    /**
     * Vue Chunk 全局对象
     * 由 vue-chunk.js (IIFE) 导出到全局
     */
    var VueChunk: {
        ref: <T>(value: T) => import('vue').Ref<T>;
        computed: <T>(getter: () => T) => import('vue').ComputedRef<T>;
        reactive: <T extends object>(obj: T) => import('vue').UnwrapNestedRefs<T>;
        readonly: <T extends object>(obj: T) => import('vue').DeepReadonly<import('vue').UnwrapNestedRefs<T>>;
        createApp: <T>(rootComponent: T) => import('vue').App<T>;
    };
}

export {};
