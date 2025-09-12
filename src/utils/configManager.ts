/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';

/**
 * GCMP配置接口
 */
export interface GCMPConfig {
    /** 温度参数，控制输出随机性 (0.0-2.0) */
    temperature: number;
    /** Top-p参数，控制输出多样性 (0.0-1.0) */
    topP: number;
    /** 最大输出token数量 */
    maxTokens: number;
}

/**
 * 配置管理器类
 * 负责读取和管理 VS Code 设置中的 GCMP 配置
 */
export class ConfigManager {
    private static readonly CONFIG_SECTION = 'gcmp';
    private static cache: GCMPConfig | null = null;
    private static configListener: vscode.Disposable | null = null;

    /**
     * 初始化配置管理器
     * 设置配置变更监听器
     */
    static initialize(): vscode.Disposable {
        // 清理之前的监听器
        if (this.configListener) {
            this.configListener.dispose();
        }

        // 设置配置变更监听器
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(this.CONFIG_SECTION)) {
                this.cache = null; // 清除缓存，强制重新读取
                Logger.info('GCMP配置已更新，缓存已清除');
            }
        });

        Logger.debug('配置管理器已初始化');
        return this.configListener;
    }

    /**
     * 获取当前配置
     * 使用缓存机制提高性能
     */
    static getConfig(): GCMPConfig {
        if (this.cache) {
            return this.cache;
        }

        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);

        this.cache = {
            temperature: this.validateTemperature(config.get<number>('temperature', 0.1)),
            topP: this.validateTopP(config.get<number>('topP', 1.0)),
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 8192))
        };

        Logger.debug('配置已加载', this.cache);
        return this.cache;
    }

    /**
     * 获取温度参数
     */
    static getTemperature(): number {
        return this.getConfig().temperature;
    }

    /**
     * 获取Top-p参数
     */
    static getTopP(): number {
        return this.getConfig().topP;
    }

    /**
     * 获取最大token数量
     */
    static getMaxTokens(): number {
        return this.getConfig().maxTokens;
    }

    /**
     * 获取适合模型的最大token数量
     * 考虑模型限制和用户配置
     */
    static getMaxTokensForModel(modelMaxTokens: number): number {
        const configMaxTokens = this.getMaxTokens();
        return Math.min(modelMaxTokens, configMaxTokens);
    }

    /**
     * 验证温度参数
     */
    private static validateTemperature(value: number): number {
        if (isNaN(value) || value < 0 || value > 2) {
            Logger.warn(`无效的temperature值: ${value}，使用默认值0.1`);
            return 0.1;
        }
        return value;
    }

    /**
     * 验证Top-p参数
     */
    private static validateTopP(value: number): number {
        if (isNaN(value) || value < 0 || value > 1) {
            Logger.warn(`无效的topP值: ${value}，使用默认值1.0`);
            return 1.0;
        }
        return value;
    }

    /**
     * 验证最大token数量
     */
    private static validateMaxTokens(value: number): number {
        if (isNaN(value) || value < 32 || value > 32768) {
            Logger.warn(`无效的maxTokens值: ${value}，使用默认值8192`);
            return 8192;
        }
        return Math.floor(value);
    }

    /**
     * 设置配置值
     * 用于程序化修改配置
     */
    static async setTemperature(value: number): Promise<void> {
        const validValue = this.validateTemperature(value);
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('temperature', validValue, vscode.ConfigurationTarget.Global);
        Logger.info(`Temperature已设置为: ${validValue}`);
    }

    static async setTopP(value: number): Promise<void> {
        const validValue = this.validateTopP(value);
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('topP', validValue, vscode.ConfigurationTarget.Global);
        Logger.info(`TopP已设置为: ${validValue}`);
    }

    static async setMaxTokens(value: number): Promise<void> {
        const validValue = this.validateMaxTokens(value);
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update('maxTokens', validValue, vscode.ConfigurationTarget.Global);
        Logger.info(`MaxTokens已设置为: ${validValue}`);
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this.cache = null;
        Logger.debug('配置管理器已清理');
    }
}
