/*---------------------------------------------------------------------------------------------
 *  配额状态栏注册表
 *  7 个 apiKey 类 provider 的状态栏全部由 config + adapter 声明式初始化；
 *  CLI 认证（ChatGPT/Grok）与多 provider 聚合（Compatible）保留独立实现。
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderQuotaStatusBar } from './providerQuotaStatusBar';
import { t } from '../utils/runtime/l10n';
import { humanizePlanId } from '../quota/providers/commandcode';
import {
    clinepassStatusAdapter,
    type ClinePassStatusData,
    commandcodeStatusAdapter,
    type CommandCodeStatusData,
    deepseekStatusAdapter,
    type DeepSeekStatusData,
    kimiStatusAdapter,
    type KimiStatusData,
    minimaxStatusAdapter,
    type MiniMaxStatusData,
    moonshotStatusAdapter,
    type MoonshotStatusData,
    opencodeStatusAdapter,
    type OpenCodeStatusData,
    zhipuStatusAdapter,
    type ZhipuStatusData
} from '../quota/statusAdapters';

export function createZhipuStatusBar(): ProviderQuotaStatusBar<ZhipuStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.zhipu',
            name: 'GCMP: GLM Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 99,
            refreshCommand: 'gcmp.refreshZhipuUsage',
            apiKeyProvider: 'zhipu',
            keyDisplayName: 'Zhipu AI',
            cacheKeyPrefix: 'zhipu',
            logPrefix: 'Zhipu AI Status Bar',
            icon: '$(gcmp-zhipu)'
        },
        adapter: zhipuStatusAdapter,
        title: () => t('GLM Coding Plan Usage', 'GLM Coding Plan 使用情况')
    });
}

export function createMiniMaxStatusBar(): ProviderQuotaStatusBar<MiniMaxStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.minimax',
            name: 'GCMP: MiniMax Token Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 98,
            refreshCommand: 'gcmp.refreshMiniMaxUsage',
            apiKeyProvider: 'minimax-token',
            keyDisplayName: 'MiniMax Token Plan',
            cacheKeyPrefix: 'minimax',
            logPrefix: 'MiniMax Status Bar',
            icon: '$(gcmp-minimax)'
        },
        adapter: minimaxStatusAdapter,
        title: () => t('MiniMax Token Plan Usage', 'MiniMax Token Plan 使用情况')
    });
}

export function createKimiStatusBar(): ProviderQuotaStatusBar<KimiStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.kimi',
            name: 'GCMP: Kimi For Coding',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 90,
            refreshCommand: 'gcmp.kimi.refreshUsage',
            apiKeyProvider: 'kimi',
            keyDisplayName: 'Kimi For Coding',
            cacheKeyPrefix: 'kimi',
            logPrefix: 'Kimi Status Bar',
            icon: '$(gcmp-kimi)'
        },
        adapter: kimiStatusAdapter,
        title: () => t('Kimi For Coding Usage', 'Kimi For Coding 使用情况')
    });
}

export function createMoonshotStatusBar(): ProviderQuotaStatusBar<MoonshotStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.moonshot',
            name: 'GCMP: Moonshot Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 89,
            refreshCommand: 'gcmp.moonshot.refreshBalance',
            apiKeyProvider: 'moonshot',
            keyDisplayName: 'Moonshot',
            cacheKeyPrefix: 'moonshot',
            logPrefix: 'Moonshot Status Bar',
            icon: '$(gcmp-moonshot)'
        },
        adapter: moonshotStatusAdapter,
        title: () => t('Moonshot Account Balance', 'Moonshot 用户账户余额'),
        lastUpdatedOf: data => data.lastUpdated
    });
}

export function createDeepSeekStatusBar(): ProviderQuotaStatusBar<DeepSeekStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.deepseek',
            name: 'GCMP: DeepSeek Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 80,
            refreshCommand: 'gcmp.deepseek.refreshBalance',
            apiKeyProvider: 'deepseek',
            keyDisplayName: 'DeepSeek',
            cacheKeyPrefix: 'deepseek',
            logPrefix: 'DeepSeek Status Bar',
            icon: '$(gcmp-deepseek)'
        },
        adapter: deepseekStatusAdapter,
        title: () => t('DeepSeek Account Balance', 'DeepSeek 用户余额详情'),
        lastUpdatedOf: data => data.lastUpdated
    });
}

export function createOpenCodeStatusBar(): ProviderQuotaStatusBar<OpenCodeStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.opencode',
            name: 'GCMP: OpenCode Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 28,
            refreshCommand: 'gcmp.opencode.refreshUsage',
            apiKeyProvider: 'opencode',
            keyDisplayName: 'OpenCode',
            cacheKeyPrefix: 'opencode',
            logPrefix: 'OpenCode Status Bar',
            icon: '$(gcmp-opencode)'
        },
        adapter: opencodeStatusAdapter,
        title: () => t('OpenCode Usage', 'OpenCode 使用情况'),
        lastUpdatedOf: data => data.lastUpdated
    });
}

export function createClinePassStatusBar(): ProviderQuotaStatusBar<ClinePassStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.clinepass',
            name: 'GCMP: ClinePass Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 26,
            refreshCommand: 'gcmp.clinepass.refreshUsage',
            apiKeyProvider: 'clinepass',
            keyDisplayName: 'ClinePass',
            cacheKeyPrefix: 'clinepass',
            logPrefix: 'ClinePass Status Bar',
            icon: '$(gcmp-cline)'
        },
        adapter: clinepassStatusAdapter,
        title: () => t('ClinePass Usage', 'ClinePass 使用情况'),
        lastUpdatedOf: data => data.lastUpdated
    });
}

export function createCommandCodeStatusBar(): ProviderQuotaStatusBar<CommandCodeStatusData> {
    return new ProviderQuotaStatusBar({
        config: {
            id: 'gcmp.statusBar.commandcode',
            name: 'GCMP: CommandCode Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 25,
            refreshCommand: 'gcmp.commandcode.refreshUsage',
            apiKeyProvider: 'commandcode',
            keyDisplayName: 'CommandCode',
            cacheKeyPrefix: 'commandcode',
            logPrefix: 'CommandCode Status Bar',
            icon: '$(gcmp-commandcode)'
        },
        adapter: commandcodeStatusAdapter,
        title: () => t('CommandCode Usage', 'CommandCode 使用情况'),
        titleOf: data => (data.planId ? humanizePlanId(data.planId) : undefined),
        lastUpdatedOf: data => data.lastUpdated
    });
}
