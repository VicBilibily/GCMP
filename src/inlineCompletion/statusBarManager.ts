import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { getInlineCompletionConfig, onConfigurationChanged, toggleEnabled } from './configuration';

/**
 * 状态栏管理器
 * 负责管理内联补全的状态栏显示和交互
 */
export class StatusBarManager {
    private static instance: StatusBarManager;
    private statusBarItem: vscode.StatusBarItem;
    private currentConfig = false;

    private constructor() {
        // 创建状态栏项目
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right
        );

        this.statusBarItem.name = 'GCMP 内联补全';
        this.statusBarItem.command = 'gcmp.toggleInlineCompletion';

        // 初始化显示
        this.updateDisplay();
        this.statusBarItem.show();

        Logger.debug('状态栏管理器初始化完成');
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): StatusBarManager {
        if (!StatusBarManager.instance) {
            StatusBarManager.instance = new StatusBarManager();
        }
        return StatusBarManager.instance;
    }

    /**
     * 更新状态栏显示
     */
    public updateDisplay(): void {
        const config = getInlineCompletionConfig();
        this.currentConfig = config.enabled;

        if (config.enabled) {
            this.statusBarItem.text = '$(check) GLM补全';
            this.statusBarItem.tooltip = '(GCMP) GLM-4.5-Air 内联代码补全已启用\n点击切换状态';
            // 启用时恢复默认颜色
            this.statusBarItem.color = undefined;
        } else {
            this.statusBarItem.text = '$(circle-slash) GLM补全';
            this.statusBarItem.tooltip = '(GCMP) GLM-4.5-Air 内联代码补全已禁用\n点击切换状态';
            // 禁用时变灰不高亮
            this.statusBarItem.color = new vscode.ThemeColor('descriptionForeground');
        }

        Logger.debug(`状态栏更新: ${config.enabled ? '启用' : '禁用'}`);
    }

    /**
     * 切换内联补全状态
     */
    public async toggleStatus(): Promise<void> {
        try {
            await toggleEnabled();
            this.updateDisplay();
        } catch (error) {
            Logger.error('切换内联补全状态时出错:', error);
            vscode.window.showErrorMessage('切换内联补全状态失败');
        }
    }

    /**
     * 注册配置变化监听器
     */
    public registerConfigChangeListener(): vscode.Disposable {
        return onConfigurationChanged((config) => {
            if (config.enabled !== this.currentConfig) {
                this.updateDisplay();
            }
        });
    }

    /**
     * 显示状态栏
     */
    public show(): void {
        this.statusBarItem.show();
    }

    /**
     * 隐藏状态栏
     */
    public hide(): void {
        this.statusBarItem.hide();
    }

    /**
     * 释放资源
     */
    public dispose(): void {
        this.statusBarItem.dispose();
        StatusBarManager.instance = null!;
        Logger.debug('状态栏管理器已销毁');
    }
}