/*---------------------------------------------------------------------------------------------
 *  Auxiliary Model Settings WebView
 *  辅助工具模型设置表单界面（作为独立 WebviewPanel 提供）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/logger';
import { t } from '../../utils/l10n';
import { ConfigManager } from '../../utils/configManager';
import { configProviders } from '../../providers/config';
import { CompatibleModelManager } from '../../utils/compatibleModelManager';
import type { ModelConfig } from '../../types/sharedTypes';
import type { AuxiliaryProviderData, FormValues, InitialValues, WebViewMessage } from './types';

interface AuxiliaryModelRef {
    providerKey: string;
    providerDisplayName: string;
    model: ModelConfig;
}

export class AuxiliaryModelSettingsPanel {
    /** Copilot Agent 相关设置键，统一写入 / 清除 */
    private static readonly COPILOT_AGENT_SETTING_KEYS = [
        'inlineChat.defaultModel',
        'chat.planAgent.defaultModel',
        'chat.exploreAgent.defaultModel',
        'github.copilot.chat.askAgent.model',
        'github.copilot.chat.implementAgent.model',
        'github.copilot.chat.exploreAgent.model'
    ];

    private panel: vscode.WebviewPanel | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    static createAndShow(context: vscode.ExtensionContext): void {
        const panel = new AuxiliaryModelSettingsPanel(context);
        panel.show();
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'gcmpAuxiliaryModelSettings',
            t('Auxiliary Model Settings', '辅助工具模型设置'),
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            this.context.subscriptions
        );

        this.panel.webview.html = this.getWebviewContent(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    private async handleMessage(message: WebViewMessage): Promise<void> {
        switch (message.command) {
            case 'getInitialData':
                await this.sendInitialData();
                return;
            case 'save':
                await this.saveSettings(message.values);
                return;
            case 'cancel':
                this.panel?.dispose();
                return;
        }
    }

    private async sendInitialData(): Promise<void> {
        const providers = this.getProviders();
        const initialValues: InitialValues = {
            commit: ConfigManager.getCommitConfig().model,
            vision: ConfigManager.getConfig().vision.model,
            utility: this.parseUtilityModelId('chat.utilityModel'),
            utilitySmall: this.parseUtilityModelId('chat.utilitySmallModel'),
            agent: this.parseAgentModelDisplayName()
        };

        const payload = {
            command: 'init' as const,
            providers,
            initialValues
        };
        Logger.debug('[AuxiliaryModelSettings] Sending initial data:', payload);
        this.panel?.webview.postMessage(payload);
    }

    private async saveSettings(values: FormValues): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration();

            await this.updateModelSetting(config, 'gcmp.commit.model', values.commit);
            await this.updateModelSetting(config, 'gcmp.vision.model', values.vision);
            await this.updateCopilotUtilitySetting(config, 'chat.utilityModel', values.utility);
            await this.updateCopilotUtilitySetting(config, 'chat.utilitySmallModel', values.utilitySmall);
            await this.updateCopilotAgentSetting(config, values.agent);

            this.panel?.webview.postMessage({ command: 'saved', success: true });
        } catch (err) {
            Logger.error('[AuxiliaryModelSettings] Failed to save:', err);
            this.panel?.webview.postMessage({
                command: 'saveError',
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    private async updateModelSetting(
        config: vscode.WorkspaceConfiguration,
        key: string,
        value: { provider: string; model: string } | null
    ): Promise<void> {
        if (this.isValidModelValue(value)) {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
        } else {
            await config.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
    }

    private async updateCopilotUtilitySetting(
        config: vscode.WorkspaceConfiguration,
        key: 'chat.utilityModel' | 'chat.utilitySmallModel',
        value: { provider: string; model: string } | null
    ): Promise<void> {
        const ref = this.isValidModelValue(value) ? this.toModelRef(value) : undefined;
        if (ref) {
            await config.update(key, buildUtilityModelId(ref), vscode.ConfigurationTarget.Global);
        } else {
            await config.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
    }

    private async updateCopilotAgentSetting(
        config: vscode.WorkspaceConfiguration,
        value: { provider: string; model: string } | null
    ): Promise<void> {
        const ref = this.isValidModelValue(value) ? this.toModelRef(value) : undefined;
        const updateValue = ref ? buildQualifiedDisplayName(ref) : undefined;
        for (const key of AuxiliaryModelSettingsPanel.COPILOT_AGENT_SETTING_KEYS) {
            await config.update(key, updateValue, vscode.ConfigurationTarget.Global);
        }
    }

    private isValidModelValue(
        value: { provider: string; model: string } | null
    ): value is { provider: string; model: string } {
        return Boolean(value && value.provider && value.model);
    }

    private toModelRef(value: { provider: string; model: string } | null): AuxiliaryModelRef | undefined {
        if (!value?.provider || !value?.model) {
            return undefined;
        }

        const cfg = configProviders[value.provider as keyof typeof configProviders];
        const effectiveCfg = cfg ? ConfigManager.applyProviderOverrides(value.provider, cfg) : undefined;
        const model =
            effectiveCfg?.models.find(m => m.id === value.model) ??
            (CompatibleModelManager.getModels().find(m => m.id === value.model) as ModelConfig | undefined);
        if (!model) {
            return undefined;
        }

        return {
            providerKey: value.provider,
            providerDisplayName: cfg?.displayName ?? 'Compatible',
            model
        };
    }

    private parseUtilityModelId(
        settingKey: 'chat.utilityModel' | 'chat.utilitySmallModel'
    ): { provider: string; model: string } | undefined {
        const config = vscode.workspace.getConfiguration();
        const value = config.get<string>(settingKey) ?? '';

        // 标准格式：gcmp.providerKey/gcmp.actualProvider:::modelId
        let match = value.match(/^gcmp\.([^/]+)\/gcmp\.[^:]+:::(.+)$/);
        if (!match) {
            // 兼容格式：providerKey/modelId 或 providerKey:::modelId
            match = value.match(/^gcmp\.([^/]+)(?:\/|:::)(.+)$/) ?? value.match(/^([^/]+)\/(.+)$/);
        }
        if (!match) {
            Logger.debug(`[AuxiliaryModelSettings] ${settingKey} value does not match expected formats:`, value);
            return undefined;
        }
        return { provider: match[1], model: match[2] };
    }

    private parseAgentModelDisplayName(): { provider: string; model: string } | undefined {
        const config = vscode.workspace.getConfiguration();
        const value = config.get<string>('chat.planAgent.defaultModel') ?? '';
        const match = value.match(/^(.+?)\s*\(gcmp\.([^)]+)\)$/);
        if (!match) {
            Logger.debug(
                '[AuxiliaryModelSettings] chat.planAgent.defaultModel value does not match expected format:',
                value
            );
            return undefined;
        }

        const providerKey = match[2];
        const modelName = match[1].trim();
        const cfg = configProviders[providerKey as keyof typeof configProviders];
        const effectiveCfg = cfg ? ConfigManager.applyProviderOverrides(providerKey, cfg) : undefined;

        // 先按显示名称匹配，再按模型 ID 匹配
        let model =
            effectiveCfg?.models.find(m => m.name === modelName) ??
            (CompatibleModelManager.getModels().find(m => m.name === modelName) as ModelConfig | undefined);
        if (!model) {
            model =
                effectiveCfg?.models.find(m => m.id === modelName) ??
                (CompatibleModelManager.getModels().find(m => m.id === modelName) as ModelConfig | undefined);
        }

        if (!model) {
            // 模型名称/ID 已无法匹配（可能被删除或改名），但提供商仍可识别
            Logger.warn(
                `[AuxiliaryModelSettings] Agent model "${modelName}" not found under provider "${providerKey}". Provider will be preselected.`
            );
            return { provider: providerKey, model: '' };
        }

        return { provider: providerKey, model: model.id };
    }

    private getProviders(): AuxiliaryProviderData[] {
        const result: AuxiliaryProviderData[] = [];

        for (const [providerKey, cfg] of Object.entries(configProviders)) {
            const effectiveCfg = ConfigManager.applyProviderOverrides(providerKey, cfg);
            const models = (effectiveCfg.models ?? [])
                .filter(m => Boolean(m.id))
                .map(m => ({
                    id: m.id,
                    name: m.name || m.id,
                    hasToolCalling: m.capabilities?.toolCalling === true,
                    hasImageInput: m.capabilities?.imageInput === true
                }));
            if (models.length > 0) {
                result.push({
                    key: providerKey,
                    displayName: cfg.displayName,
                    models
                });
            }
        }

        const compatibleModels = CompatibleModelManager.getModels()
            .filter(m => Boolean(m.id))
            .map(m => ({
                id: m.id,
                name: m.name || m.id,
                hasToolCalling: m.capabilities?.toolCalling === true,
                hasImageInput: m.capabilities?.imageInput === true
            }));
        if (compatibleModels.length > 0) {
            result.push({
                key: 'compatible',
                displayName: 'Compatible',
                models: compatibleModels
            });
        }

        return result;
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const cspSource = webview.cspSource;
        const jsPath = path.join(this.context.extensionPath, 'dist', 'ui', 'auxiliaryModelSettings.js');
        let js = '';
        try {
            js = fs.readFileSync(jsPath, 'utf8');
        } catch (error) {
            Logger.error('[AuxiliaryModelSettings] Failed to load auxiliaryModelSettings.js:', error);
            js = '/* Error loading */';
        }

        // 根据 VS Code 语言动态设置 <html lang>，使前端 t() 函数能正确选择语言
        const htmlLang = vscode.env.language || 'en';

        return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Auxiliary Model Settings', '辅助工具模型设置')}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
</head>
<body>
    <div id="app"></div>
    <script>
        const vscode = acquireVsCodeApi();
        window.vscode = vscode;
        ${js}
    </script>
</body>
</html>`;
    }
}

function buildQualifiedDisplayName(ref: AuxiliaryModelRef): string {
    return `${ref.model.name} (gcmp.${ref.providerKey})`;
}

function buildUtilityModelId(ref: AuxiliaryModelRef): string {
    const actualProvider = ref.model.provider || ref.providerKey;
    return `gcmp.${ref.providerKey}/gcmp.${actualProvider}:::${ref.model.id}`;
}
