/**
 * VSCode WebView API 全局接口
 */
interface VsCodeApi {
    postMessage(message: { command: string; [key: string]: unknown }): void;
}

interface Window {
    vscode: VsCodeApi;
}

declare module '*.less' {
    const content: string;
    export default content;
}
