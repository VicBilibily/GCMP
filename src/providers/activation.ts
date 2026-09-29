import * as vscode from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ZhipuProvider } from './zhipuProvider';
import { MoonshotProvider } from './moonshotProvider';
import { CliBaseProvider } from '../cli/cliBaseProvider';
import { CodexProvider } from '../cli/codexProvider';
import { MiniMaxProvider } from './minimaxProvider';
import { DashscopeProvider } from './dashscopeProvider';
import { TencentProvider } from './tencentProvider';
import { XiaomimimoProvider } from './xiaomimimoProvider';
import { BaiduProvider } from './baiduProvider';
import { VolcengineProvider } from './volcengineProvider';
import { StepFunProvider } from './stepfunProvider';
import { XfyunProvider } from './xfyunProvider';
import { CompatibleProvider } from './compatibleProvider';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { TokenCounter } from '../utils/model/tokenCounter';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { registerProvider } from '../utils/config/providerRegistry';

export async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const startTime = Date.now();
    const configProvider = ConfigManager.getConfigProvider();

    if (!configProvider) {
        Logger.warn('Provider configuration not found. Skipping provider registration.');
        return;
    }

    TokenCounter.setExtensionPath(context.extensionPath);
    Logger.debug(`Starting parallel registration for ${Object.keys(configProvider).length} providers...`);

    const cliAuthProviders = CliAuthFactory.getSupportedCliTypes().map(cli => cli.id);
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`Registering provider: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

            let provider:
                | GenericModelProvider
                | ZhipuProvider
                | MoonshotProvider
                | CliBaseProvider
                | CodexProvider
                | MiniMaxProvider
                | DashscopeProvider
                | TencentProvider
                | XiaomimimoProvider
                | BaiduProvider
                | VolcengineProvider
                | XfyunProvider;
            let disposables: vscode.Disposable[];

            if (providerKey === 'zhipu') {
                const result = ZhipuProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'moonshot') {
                const result = MoonshotProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'minimax') {
                const result = MiniMaxProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'dashscope') {
                const result = DashscopeProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'tencent') {
                const result = TencentProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'xiaomimimo') {
                const result = XiaomimimoProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'baidu') {
                const result = BaiduProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'volcengine') {
                const result = VolcengineProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'stepfun') {
                const result = StepFunProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'xfyun') {
                const result = XfyunProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'codex') {
                const result = CodexProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (cliAuthProviders.includes(providerKey)) {
                const result = CliBaseProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else {
                const result = GenericModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            }

            Logger.debug(
                `Provider registered successfully: ${providerConfig.displayName} (${Date.now() - providerStartTime}ms)`
            );
            return { providerKey, provider, disposables };
        } catch (error) {
            Logger.error(`Failed to register provider ${providerKey}:`, error);
            return null;
        }
    });

    const results = await Promise.all(registrationPromises);
    for (const result of results) {
        if (result) {
            registerProvider(result.providerKey, result.provider);
        }
    }

    Logger.debug(
        `Provider registration completed: ${results.filter(Boolean).length}/${Object.keys(configProvider).length} succeeded (${Date.now() - startTime}ms)`
    );
}

export async function activateCompatibleProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('Registering compatible provider...');
        const providerStartTime = Date.now();
        const { provider } = CompatibleProvider.createAndActivate(context);
        registerProvider('compatible', provider);
        Logger.debug(`Compatible provider registered successfully (${Date.now() - providerStartTime}ms)`);
    } catch (error) {
        Logger.error('Failed to register compatible provider:', error);
    }
}
