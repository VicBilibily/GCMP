/*---------------------------------------------------------------------------------------------
 *  状态栏管理器
 *  全局静态管理器，统一管理所有状态栏项的生命周期和操作
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { MiniMaxStatusBar } from './minimaxStatusBar';
import { KimiStatusBar } from './kimiStatusBar';
import { DeepSeekStatusBar } from './deepseekStatusBar';
import { MoonshotStatusBar } from './moonshotStatusBar';
import { CompatibleStatusBar } from './compatibleStatusBar';

/**
 * 状态栏项接口
 */
interface IStatusBar {
    initialize(context: vscode.ExtensionContext): Promise<void>;
    checkAndShowStatus(): Promise<void>;
    delayedUpdate(delayMs?: number): void;
    dispose(): void;
}
interface ICompatibleStatusBar extends IStatusBar {
    /** @deprecated Use delayedUpdate with providerId instead */
    delayedUpdate(delayMs?: number): void;
    delayedUpdate(providerId: string, delayMs?: number): void;
}

/**
 * 状态栏管理器
 * 全局静态类，统一管理所有状态栏项的生命周期和操作
 * 所有状态栏实例都作为公共成员提供访问
 */
export class StatusBarManager {
    // ==================== 公共状态栏实例 ====================
    /** MiniMax Coding Plan 状态栏 */
    static minimax: IStatusBar | undefined;
    /** Kimi For Coding 状态栏 */
    static kimi: IStatusBar | undefined;
    /** DeepSeek 余额查询状态栏 */
    static deepseek: IStatusBar | undefined;
    /** Moonshot 余额查询状态栏 */
    static moonshot: IStatusBar | undefined;
    /** Compatible 提供商状态栏 */
    static compatible: ICompatibleStatusBar | undefined;

    // ==================== 私有成员 ====================
    private static statusBars: Map<string, IStatusBar> = new Map<string, IStatusBar>();
    private static initialized = false;

    /**
     * 注册所有内置状态栏
     * 在初始化时自动创建和注册所有状态栏实例
     */
    private static registerBuiltInStatusBars(): void {
        // 创建并注册 MiniMax 状态栏
        const miniMaxStatusBar = new MiniMaxStatusBar();
        this.registerStatusBar('minimax', miniMaxStatusBar);

        // 创建并注册 Kimi 状态栏
        const kimiStatusBar = new KimiStatusBar();
        this.registerStatusBar('kimi', kimiStatusBar);

        // 创建并注册 DeepSeek 状态栏
        const deepseekStatusBar = new DeepSeekStatusBar();
        this.registerStatusBar('deepseek', deepseekStatusBar);

        // 创建并注册 Moonshot 状态栏
        const moonshotStatusBar = new MoonshotStatusBar();
        this.registerStatusBar('moonshot', moonshotStatusBar);

        // 创建并注册 Compatible 提供商状态栏
        const compatibleStatusBar = new CompatibleStatusBar();
        this.registerStatusBar('compatible', compatibleStatusBar);
    }

    /**
     * 注册状态栏项
     * 用于初始化时注册所有状态栏
     * @param key 状态栏项的唯一标识
     * @param statusBar 状态栏项实例
     */
    static registerStatusBar(key: string, statusBar: IStatusBar): void {
        if (this.statusBars.has(key)) {
            StatusLogger.warn(`[StatusBarManager] 状态栏项 ${key} 已存在，覆盖注册`);
        }
        this.statusBars.set(key, statusBar);

        // 将状态栏实例关联到公共成员
        switch (key) {
            case 'minimax':
                this.minimax = statusBar;
                break;
            case 'kimi':
                this.kimi = statusBar;
                break;
            case 'deepseek':
                this.deepseek = statusBar;
                break;
            case 'moonshot':
                this.moonshot = statusBar;
                break;
            case 'compatible':
                this.compatible = statusBar as ICompatibleStatusBar;
                break;
            default:
                break;
        }
    }

    /**
     * 获取指定的状态栏项
     * @param key 状态栏项的唯一标识
     */
    static getStatusBar(key: 'compatible'): ICompatibleStatusBar | undefined;
    static getStatusBar(key: string): IStatusBar | undefined;
    static getStatusBar(key: string): IStatusBar | undefined {
        return this.statusBars.get(key);
    }

    /**
     * 初始化所有已注册的状态栏项
     * 批量加载并初始化所有状态栏
     * @param context 扩展上下文
     */
    static async initializeAll(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.warn('[StatusBarManager] 状态栏管理器已初始化，跳过重复初始化');
            return;
        }

        // 第一步：注册所有内置状态栏
        this.registerBuiltInStatusBars();

        StatusLogger.info(`[StatusBarManager] 开始初始化 ${this.statusBars.size} 个状态栏项`);

        // 并行初始化所有状态栏
        const initPromises = Array.from(this.statusBars.entries()).map(async ([key, statusBar]) => {
            try {
                await statusBar.initialize(context);
                StatusLogger.debug(`[StatusBarManager] 状态栏项 ${key} 初始化成功`);
            } catch (error) {
                StatusLogger.error(`[StatusBarManager] 状态栏项 ${key} 初始化失败`, error);
            }
        });

        await Promise.all(initPromises);

        this.initialized = true;
        StatusLogger.info('[StatusBarManager] 所有状态栏项初始化完成');
    }

    /**
     * 检查并显示指定的状态栏项
     * @param key 状态栏项的唯一标识
     */
    static async checkAndShowStatus(key: string): Promise<void> {
        const statusBar = this.getStatusBar(key);
        if (statusBar) {
            try {
                await statusBar.checkAndShowStatus();
            } catch (error) {
                StatusLogger.error(`[StatusBarManager] 检查并显示状态栏 ${key} 失败`, error);
            }
        } else {
            StatusLogger.warn(`[StatusBarManager] 未找到状态栏项 ${key}`);
        }
    }

    /**
     * 延时更新指定的状态栏项
     * @param key 状态栏项的唯一标识
     * @param delayMs 延时时间（毫秒）
     */
    static delayedUpdate(key: string, delayMs?: number): void {
        const statusBar = this.getStatusBar(key);
        if (statusBar) {
            statusBar.delayedUpdate(delayMs);
        } else {
            StatusLogger.warn(`[StatusBarManager] 未找到状态栏项 ${key}`);
        }
    }

    /**
     * 销毁所有状态栏项
     */
    static disposeAll(): void {
        for (const [key, statusBar] of this.statusBars) {
            try {
                statusBar.dispose();
                StatusLogger.debug(`[StatusBarManager] 状态栏项 ${key} 已销毁`);
            } catch (error) {
                StatusLogger.error(`[StatusBarManager] 销毁状态栏项 ${key} 失败`, error);
            }
        }
        this.statusBars.clear();
        this.initialized = false;

        // 清除公共实例引用
        this.minimax = undefined;
        this.kimi = undefined;
        this.deepseek = undefined;
        this.moonshot = undefined;
        this.compatible = undefined;
    }

    /**
     * 获取所有已注册的状态栏项列表
     */
    static getRegisteredKeys(): string[] {
        return Array.from(this.statusBars.keys());
    }

    /**
     * 获取初始化状态
     */
    static isInitialized(): boolean {
        return this.initialized;
    }
}
