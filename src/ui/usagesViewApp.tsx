/**
 * UsagesView App Entry
 * 用于 WebView 中的 Vue 应用初始化
 */

import { createApp } from './vendor/vue';
import usagesViewPage from './usagesViewPage';

// 全局初始化函数，由 WebView HTML 调用
// @ts-ignore
window.initializeUsagesView = function () {
    try {
        const app = createApp(usagesViewPage);
        app.mount('#app');

        // 暴露卸载方法供调试使用
        // @ts-ignore
        window.unmountUsagesView = () => {
            app.unmount();
        };
    } catch (error) {
        console.error('[UsagesView] Initialization error:', error);
        const appDiv = document.getElementById('app');
        if (appDiv) {
            appDiv.innerHTML = `<div style="color: red; padding: 20px;">Failed to initialize: ${(error as Error).message}</div>`;
        }
    }
};
