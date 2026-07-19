/*---------------------------------------------------------------------------------------------
 *  启动 Utility 模型引导
 *  VS Code 1.128+ 且 utility/utilitySmall 均未配置时，弹出提示引导用户设置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';

/**
 * 启动后引导：VS Code 1.128+ 且 utility 模型未配置时，提示用户快速完成设置。
 */
export async function runStartupUtilityModelWizardIfNeeded(): Promise<void> {
    try {
        if (!isVsCodeVersionAtLeast(vscode.version, 1, 128, 0)) {
            return;
        }

        const config = vscode.workspace.getConfiguration();
        const utilityModel = config.get<unknown>('chat.utilityModel');
        const utilitySmallModel = config.get<unknown>('chat.utilitySmallModel');
        const byokUtilityDefault = config.get<string>('chat.byokUtilityModelDefault');
        const hasBothUtilityModelsConfigured =
            hasConfiguredUtilityModel(utilityModel) && hasConfiguredUtilityModel(utilitySmallModel);

        if (hasBothUtilityModelsConfigured || byokUtilityDefault === 'mainAgent') {
            return;
        }

        const manualSetBtn = t('Configure Manually (Recommended)', '手动配置（推荐）');
        const autoSetBtn = t('Follow Main Agent', '跟随主模型');

        const choice = await vscode.window.showInformationMessage(
            t(
                'Detected VS Code {0}, utility models not configured. When using non-official Copilot models (BYOK/custom providers), unconfigured utility models may cause "No utility model is configured" errors. It is recommended to configure models manually.',
                '检测到 VS Code {0}，通用辅助模型（utility）未配置。使用非官方 Copilot 模型（BYOK/自定义提供商）时，缺少配置的辅助模型会触发 "No utility model is configured" 报错。建议手动设置具体模型以获得更稳定的体验。',
                vscode.version
            ),
            manualSetBtn,
            autoSetBtn
        );

        if (choice === autoSetBtn) {
            await config.update('chat.byokUtilityModelDefault', 'mainAgent', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                t(
                    'Utility models will now follow the main agent. Non-official Copilot model utility errors should be resolved.',
                    '已配置辅助模型自动跟随主模型，非官方 Copilot 模型辅助模型报错问题应已解决。'
                )
            );
            return;
        }

        if (choice === manualSetBtn) {
            await vscode.commands.executeCommand('gcmp.modelSettings.wizard');
        }
    } catch (error) {
        Logger.warn('[StartupUtilityGuide] Failed to show utility model setup guidance:', error);
    }
}

/**
 * 判断当前 VS Code 版本是否至少为指定版本。
 */
function isVsCodeVersionAtLeast(version: string, major: number, minor: number, patch: number): boolean {
    const [currentMajor, currentMinor, currentPatch] = parseVsCodeVersion(version);
    if (currentMajor !== major) {
        return currentMajor > major;
    }
    if (currentMinor !== minor) {
        return currentMinor > minor;
    }
    return currentPatch >= patch;
}

/**
 * 解析 VS Code 版本号（兼容 1.128.0-insider 这类后缀）。
 */
function parseVsCodeVersion(version: string): [number, number, number] {
    const raw = version.split('-')[0] || '';
    const parts = raw.split('.');
    const major = Number.parseInt(parts[0] || '0', 10) || 0;
    const minor = Number.parseInt(parts[1] || '0', 10) || 0;
    const patch = Number.parseInt(parts[2] || '0', 10) || 0;
    return [major, minor, patch];
}

function hasConfiguredUtilityModel(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}
