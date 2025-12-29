/**
 * VSCode WebView API 全局接口
 */
interface VsCodeApi {
    postMessage(message: { command: string; [key: string]: unknown }): void;
}

/**
 * 扩展 Window 接口，添加 VSCode WebView API
 */
declare global {
    interface Window {
        vscode: VsCodeApi;
    }
}

export {};
