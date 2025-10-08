/*---------------------------------------------------------------------------------------------
 *  内联补全工厂
 *  根据配置创建相应的内联补全提供者
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import {
    GenericInlineCompletionProvider,
    InlineCompletionConfig,
    ZhipuCompletionProvider,
    BaiduCompletionProvider,
    DashscopeCompletionProvider,
    DeepSeekCompletionProvider
} from './inlineCompletion';

/**
 * 内联补全工厂类
 */
export class InlineCompletionFactory {
    /**
     * 创建并激活内联补全提供者
     */
    static createAndActivate(_context: vscode.ExtensionContext): vscode.Disposable | null {
        try {
            const config = this.loadConfig();

            if (!config.enabled) {
                Logger.info('内联补全功能未启用');
                return null;
            }

            // 根据提供商ID创建相应的补全提供者
            let completionProvider;

            switch (config.provider) {
                case 'zhipu':
                    completionProvider = new ZhipuCompletionProvider();
                    break;
                case 'baidu':
                    completionProvider = new BaiduCompletionProvider();
                    break;
                case 'dashscope':
                    completionProvider = new DashscopeCompletionProvider();
                    break;
                case 'deepseek':
                    completionProvider = new DeepSeekCompletionProvider();
                    break;
                default:
                    Logger.error(`不支持的内联补全提供商: ${config.provider}`);
                    return null;
            }

            // 创建通用内联补全提供者
            const genericProvider = new GenericInlineCompletionProvider(completionProvider, config);

            // 注册内联补全提供者
            const documentSelector: vscode.DocumentSelector = [
                { scheme: 'file' },
                { scheme: 'untitled' }
            ];

            const disposable = vscode.languages.registerInlineCompletionItemProvider(
                documentSelector,
                genericProvider,
                {
                    displayName: `AI 代码补全 (${config.provider})`,
                    debounceDelayMs: config.debounceDelay,
                    yieldTo: ['github.copilot']
                }
            );

            Logger.info(`内联补全提供者注册成功: ${config.provider}, 模型: ${config.model || completionProvider.getSupportedModels()[0]}`);

            return disposable;
        } catch (error) {
            Logger.error('创建内联补全提供者失败:', error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 加载配置
     */
    private static loadConfig(): InlineCompletionConfig {
        const config = vscode.workspace.getConfiguration('gcmp');

        return {
            enabled: config.get<boolean>('inlineCompletion.enabled', false),
            provider: config.get<string>('inlineCompletion.provider', 'zhipu'),
            model: config.get<string>('inlineCompletion.model', ''),
            maxCompletionLength: config.get<number>('inlineCompletion.maxCompletionLength', 500),
            contextLines: config.get<number>('inlineCompletion.contextLines', 50),
            debounceDelay: config.get<number>('inlineCompletion.debounceDelay', 500),
            temperature: config.get<number>('inlineCompletion.temperature', 0.1),
            minRequestInterval: config.get<number>('inlineCompletion.minRequestInterval', 200),
            enableSmartTrigger: config.get<boolean>('inlineCompletion.enableSmartTrigger', true),
            enableMultiFileContext: config.get<boolean>('inlineCompletion.enableMultiFileContext', false)
        };
    }
}
