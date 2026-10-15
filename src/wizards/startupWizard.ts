import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';

export async function runStartupWizardIfNeeded(): Promise<void> {
    await runStartupUtilityModelWizardIfNeeded();
    await runStartupLocalAgentWizardIfNeeded();
}

async function runStartupUtilityModelWizardIfNeeded(): Promise<void> {
    try {
        if (!isVsCodeVersionAtLeast(vscode.version, 1, 128, 0)) {
            return;
        }

        const config = vscode.workspace.getConfiguration();
        if (
            !config.inspect('chat.utilityModel') ||
            !config.inspect('chat.utilitySmallModel') ||
            !config.inspect('chat.byokUtilityModelDefault')
        ) {
            return;
        }
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
                '检测到 VS Code {0}，通用辅助模型（utility）未配置。使用非官方 Copilot 模型（BYOK/自定义提供商）时，缺少配置的辅助模型可能触发 "No utility model is configured" 报错。建议手动设置具体模型以获得更稳定的体验。',
                vscode.version
            ),
            manualSetBtn,
            autoSetBtn
        );

        if (choice === autoSetBtn) {
            await config.update('chat.byokUtilityModelDefault', 'mainAgent', vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage(
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

async function runStartupLocalAgentWizardIfNeeded(): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration();
        const settings = (
            [
                ['chat.editor.localAgent.enabled', true],
                ['chat.defaultToCopilotHarness', false],
                ['chat.editor.preferCopilotHarness', false]
            ] as const
        ).filter(([key]) => config.inspect<boolean>(key) !== undefined);
        const hasGlobalPreference = settings.some(([key]) => config.inspect<boolean>(key)?.globalValue !== undefined);
        if (settings.length === 0 || hasGlobalPreference) {
            return;
        }

        const fallbackBtn = t('Use Local Agent (Recommended)', '使用 Local Agent（推荐）');
        const manualSetBtn = t('Open Auxiliary Preferences', '打开辅助偏好');
        const choice = await vscode.window.showInformationMessage(
            t(
                'GCMP does not yet fully support Copilot Harness. We recommend switching to the default Local Agent.',
                'GCMP 暂时未能完整支持 Copilot Harness，建议切换到默认的 Local Agent。'
            ),
            fallbackBtn,
            manualSetBtn
        );

        if (choice === fallbackBtn) {
            const current = vscode.workspace.getConfiguration();
            if (settings.some(([key]) => current.inspect<boolean>(key)?.globalValue !== undefined)) {
                return;
            }
            for (const [key, expected] of settings) {
                const value = current.inspect<boolean>(key);
                if (value && value.globalValue === undefined) {
                    await current.update(key, expected, vscode.ConfigurationTarget.Global);
                }
            }
            void vscode.window.showInformationMessage(
                t(
                    'Local Agent preferences have been saved globally. Existing chats may still use Copilot Harness; start a new chat and select Local Agent if needed.',
                    '已保存 Local Agent 全局偏好。现有会话可能仍使用 Copilot Harness，必要时请新建会话并选择 Local Agent。'
                )
            );
            return;
        }

        if (choice === manualSetBtn) {
            await vscode.commands.executeCommand('gcmp.modelSettings.wizard');
        }
    } catch (error) {
        Logger.warn('[StartupLocalAgentGuide] Failed to configure Local Agent preferences:', error);
    }
}

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
