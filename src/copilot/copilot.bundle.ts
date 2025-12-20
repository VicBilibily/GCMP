/*---------------------------------------------------------------------------------------------
 *  Copilot Bundle - 延迟加载入口
 *
 *  此文件作为独立的 bundle 入口点，包含 @vscode/chat-lib 等重型依赖。
 *  在首次触发内联补全时，由 InlineCompletionShim 动态加载。
 *
 *  打包输出: dist/copilot.bundle.js
 *--------------------------------------------------------------------------------------------*/

// 导出完整的 InlineCompletionProvider
export { InlineCompletionProvider } from './completionProvider';
