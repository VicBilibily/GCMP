/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置和供应商配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './logger';
import { ConfigProvider, KiloCodeHeaders } from '../types/sharedTypes';

/**
 * 上下文缩减选项
 */
export type ContextReduction = '1x' | '1/2' | '1/4' | '1/8';

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
    /** 模型上下文缩减比例 */
    contextReduction: ContextReduction;
}

/**
 * 配置管理器类
 * 负责读取和管理 VS Code 设置中的 GCMP 配置以及package.json中的供应商配置
 */
export class ConfigManager {
    private static readonly CONFIG_SECTION = 'gcmp';
    private static cache: GCMPConfig | null = null;
    private static configListener: vscode.Disposable | null = null;
    private static packageJsonCache: { configProvider?: ConfigProvider; kiloCodeHeaders?: KiloCodeHeaders } | null = null;

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
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 8192)),
            contextReduction: this.validateContextReduction(config.get<string>('contextReduction', '1x'))
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
     * 获取上下文缩减参数
     */
    static getContextReduction(): ContextReduction {
        return this.getConfig().contextReduction;
    }

    /**
     * 获取上下文缩减比例数值
     */
    static getContextReductionRatio(): number {
        const reduction = this.getContextReduction();
        switch (reduction) {
            case '1x': return 1;
            case '1/2': return 0.5;
            case '1/4': return 0.25;
            case '1/8': return 0.125;
            default: return 1;
        }
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
     * 获取上下文缩减后的输入限制
     * 根据用户设置缩减模型的输入上下文长度
     */
    static getReducedInputTokenLimit(modelMaxInputTokens: number): number {
        const reductionRatio = this.getContextReductionRatio();
        return Math.floor(modelMaxInputTokens * reductionRatio);
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
     * 验证上下文缩减参数
     */
    private static validateContextReduction(value: string): ContextReduction {
        const validValues: ContextReduction[] = ['1x', '1/2', '1/4', '1/8'];
        if (!validValues.includes(value as ContextReduction)) {
            Logger.warn(`无效的contextReduction值: ${value}，使用默认值1x`);
            return '1x';
        }
        return value as ContextReduction;
    }

    /**
     * 读取package.json中的供应商配置
     */
    private static readPackageJson(): { configProvider?: ConfigProvider; kiloCodeHeaders?: KiloCodeHeaders } {
        if (this.packageJsonCache) {
            return this.packageJsonCache;
        }

        try {
            // 获取扩展的package.json路径
            const extension = vscode.extensions.getExtension('vicanent.gcmp');
            if (!extension) {
                Logger.warn('无法找到GCMP扩展，使用空的配置');
                return {};
            }

            const packageJsonPath = path.join(extension.extensionPath, 'package.json');
            const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(packageJsonContent);

            this.packageJsonCache = {
                configProvider: packageJson.configProvider,
                kiloCodeHeaders: packageJson.kiloCodeHeaders
            };

            Logger.trace('Package.json配置已加载', this.packageJsonCache);
            return this.packageJsonCache;
        } catch (error) {
            Logger.error('读取package.json配置失败', error);
            return {};
        }
    }

    /**
     * 获取供应商配置
     */
    static getConfigProvider(): ConfigProvider | undefined {
        const packageConfig = this.readPackageJson();
        return packageConfig.configProvider;
    }

    /**
     * 获取kiloCode头部配置
     */
    static getKiloCodeHeaders(): KiloCodeHeaders | undefined {
        const packageConfig = this.readPackageJson();
        return packageConfig.kiloCodeHeaders;
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
        this.packageJsonCache = null;
        Logger.trace('配置管理器已清理');
    }
}
