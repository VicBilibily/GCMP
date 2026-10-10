import * as vscode from 'vscode';
import { completionLogger } from '../gcmpServices';
import type { FIMCompletionConfig, NESCompletionConfig } from '../types';

function validateNumber(value: number, minimum: number, maximum: number, fallback: number, label: string): number {
    if (isNaN(value) || value < minimum || value > maximum) {
        completionLogger.warn(`Invalid ${label} value: ${value}; using default ${fallback}`);
        return fallback;
    }
    return Math.floor(value);
}

function readCompletionConfig(section: 'fimCompletion' | 'nesCompletion'): FIMCompletionConfig {
    const settings = vscode.workspace.getConfiguration('gcmp');
    const config: FIMCompletionConfig = {
        enabled: settings.get<boolean>(`${section}.enabled`, false),
        debounceMs: validateNumber(settings.get<number>(`${section}.debounceMs`, 500), 50, 2000, 500, 'debounceMs'),
        timeoutMs: validateNumber(settings.get<number>(`${section}.timeoutMs`, 5000), 1000, 30000, 5000, 'timeoutMs'),
        modelConfig: {
            provider: settings.get<string>(`${section}.modelConfig.provider`, ''),
            baseUrl: settings.get<string>(`${section}.modelConfig.baseUrl`, ''),
            proxy: settings.get<string>(`${section}.modelConfig.proxy`),
            model: settings.get<string>(`${section}.modelConfig.model`, ''),
            maxTokens: validateNumber(
                settings.get<number>(`${section}.modelConfig.maxTokens`, 200),
                50,
                16000,
                200,
                'NES maxTokens'
            ),
            extraBody: settings.get<Record<string, unknown>>(`${section}.modelConfig.extraBody`)
        }
    };
    // VS Code 设置可能含 Proxy；JSON 深副本保留普通对象与嵌套隔离。
    return JSON.parse(JSON.stringify(config)) as FIMCompletionConfig;
}

export function getFIMConfig(): FIMCompletionConfig {
    return readCompletionConfig('fimCompletion');
}

export function getNESConfig(): NESCompletionConfig {
    return {
        ...readCompletionConfig('nesCompletion'),
        manualOnly: vscode.workspace.getConfiguration('gcmp').get<boolean>('nesCompletion.manualOnly', false)
    };
}
