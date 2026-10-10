/*---------------------------------------------------------------------------------------------
 *  CompletionCircuitBreaker - FIM/NES 请求熔断器
 *
 *  当 FIM 或 NES 请求连续失败达到阈值后，自动熔断停止请求，
 *  冷却一段时间后进入半开状态，允许一次探测请求验证服务是否恢复。
 *
 *  配置从 VS Code 设置中动态读取，支持运行时修改即时生效。
 *  通知回调可注入，便于单元测试。
 *  vscode / l10n 模块采用惰性导入，避免阻塞 node:test 环境。
 *--------------------------------------------------------------------------------------------*/

// ========================================================================
// 惰性加载（避免 node:test 环境模块解析失败）
// 仅在未注入 configProvider / notifyCallback 的生产路径中才会被调用
// ========================================================================

let _t: ((en: string, zh: string, ...args: unknown[]) => string) | undefined;
function getT(): (en: string, zh: string, ...args: unknown[]) => string {
    if (!_t) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _t = require('../utils/l10n').t;
    }
    return _t!;
}

function getVscode() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode') as typeof import('vscode');
}

// ========================================================================
// 类型定义
// ========================================================================

/** 熔断器状态 */
export enum CircuitState {
    /** 闭合 - 正常通行 */
    Closed = 'closed',
    /** 断开 - 阻止请求 */
    Open = 'open',
    /** 半开 - 允许一次探测 */
    HalfOpen = 'halfOpen'
}

/** 熔断器配置 */
export interface CircuitBreakerConfig {
    /** 是否启用熔断 */
    enabled: boolean;
    /** 连续失败次数阈值 */
    failureThreshold: number;
    /** 冷却时间（秒） */
    cooldownSeconds: number;
}

/** 熔断通知回调 */
export type CircuitBreakerNotifyCallback = (
    featureName: string,
    failureThreshold: number,
    cooldownSeconds: number
) => void;

/** 配置提供者回调（用于测试时注入，避免 vscode 依赖） */
export type CircuitBreakerConfigProvider = () => CircuitBreakerConfig;

// ========================================================================
// CompletionCircuitBreaker
// ========================================================================

/**
 * FIM / NES 请求熔断器
 *
 * 三态模型：
 * - Closed: 正常状态，请求通过，失败计数
 * - Open:   熔断状态，拒绝请求，等待冷却
 * - HalfOpen: 冷却后允许一次探测，成功则闭合，失败则重新熔断
 *
 * 配置从 VS Code 设置中动态读取，支持运行时修改即时生效。
 */
export class CompletionCircuitBreaker {
    private state: CircuitState = CircuitState.Closed;
    private failureCount = 0;
    private openedAt = 0;
    private halfOpenProbeSent = false;
    private lastNotificationTime = 0;
    private readonly notificationThrottleMs = 30000; // 通知节流间隔

    constructor(
        private readonly featureName: string, // 'FIM' | 'NES'
        private readonly configSection: string, // e.g. 'gcmp.fimCompletion.circuitBreaker'
        private readonly configProvider?: CircuitBreakerConfigProvider,
        private readonly notifyCallback?: CircuitBreakerNotifyCallback
    ) {}

    // ========================================================================
    // 配置读取
    // ========================================================================

    /** 从 VS Code 设置动态读取当前配置（支持注入 configProvider 用于测试） */
    private readConfig(): CircuitBreakerConfig {
        if (this.configProvider) {
            return this.configProvider();
        }
        const vscode = getVscode();
        const config = vscode.workspace.getConfiguration();

        // 按功能匹配 package.json 声明的默认值，避免兜底值与设置声明漂移
        const isFIM = this.configSection === 'gcmp.fimCompletion.circuitBreaker';
        const defaultEnabled = true;
        const defaultThreshold = isFIM ? 10 : 5;
        const maxThreshold = isFIM ? 60 : 20;
        const defaultCooldown = 30;
        const maxCooldown = 300;

        const rawEnabled = config.get<unknown>(`${this.configSection}.enabled`, defaultEnabled);
        const rawThreshold = config.get<unknown>(`${this.configSection}.failureThreshold`, defaultThreshold);
        const rawCooldown = config.get<unknown>(`${this.configSection}.cooldownSeconds`, defaultCooldown);

        return {
            enabled: typeof rawEnabled === 'boolean' ? rawEnabled : defaultEnabled,
            // 校验并夹取非法值，防御用户同步到非布尔/非数字/超范围等异常配置
            failureThreshold:
                (
                    typeof rawThreshold === 'number' &&
                    Number.isFinite(rawThreshold) &&
                    rawThreshold >= 2 &&
                    rawThreshold <= maxThreshold
                ) ?
                    Math.floor(rawThreshold)
                :   defaultThreshold,
            cooldownSeconds:
                (
                    typeof rawCooldown === 'number' &&
                    Number.isFinite(rawCooldown) &&
                    rawCooldown >= 10 &&
                    rawCooldown <= maxCooldown
                ) ?
                    Math.floor(rawCooldown)
                :   defaultCooldown
        };
    }

    // ========================================================================
    // 公共 API
    // ========================================================================

    /** 检查请求是否允许通过 */
    allowRequest(): boolean {
        const config = this.readConfig();
        if (!config.enabled) {
            return true;
        }

        switch (this.state) {
            case CircuitState.Closed:
                return true;

            case CircuitState.Open: {
                const cooldownMs = config.cooldownSeconds * 1000;
                if (Date.now() - this.openedAt >= cooldownMs) {
                    this.state = CircuitState.HalfOpen;
                    this.halfOpenProbeSent = true;
                    return true;
                }
                return false;
            }

            case CircuitState.HalfOpen:
                // 半开状态只允许一次探测请求
                if (!this.halfOpenProbeSent) {
                    this.halfOpenProbeSent = true;
                    return true;
                }
                return false;

            default:
                return true;
        }
    }

    /** 记录请求成功 */
    recordSuccess(): void {
        const config = this.readConfig();
        if (!config.enabled) {
            return;
        }

        this.failureCount = 0;

        if (this.state === CircuitState.HalfOpen) {
            this.state = CircuitState.Closed;
            this.halfOpenProbeSent = false;
        }
    }

    /**
     * 记录请求被取消（用户侧取消，既非成功也非失败）
     * 在 HalfOpen 状态下，取消不消耗探测名额，允许后续重新探测。
     */
    recordCancellation(): void {
        if (this.state === CircuitState.HalfOpen) {
            this.halfOpenProbeSent = false;
        }
    }

    /** 记录请求失败 */
    recordFailure(): void {
        const config = this.readConfig();
        if (!config.enabled) {
            return;
        }

        this.failureCount++;

        if (this.state === CircuitState.HalfOpen) {
            // 半开状态探测失败，重新熔断；重置失败计数为阈值，避免无限累加导致语义模糊
            this.state = CircuitState.Open;
            this.openedAt = Date.now();
            this.halfOpenProbeSent = false;
            this.failureCount = config.failureThreshold;
            this.showNotification(config);
            return;
        }

        if (this.state === CircuitState.Closed && this.failureCount >= config.failureThreshold) {
            this.state = CircuitState.Open;
            this.openedAt = Date.now();
            this.showNotification(config);
        }
    }

    /** 手动重置熔断器 */
    reset(): void {
        this.state = CircuitState.Closed;
        this.failureCount = 0;
        this.openedAt = 0;
        this.halfOpenProbeSent = false;
        this.lastNotificationTime = 0;
    }

    /** 获取当前状态信息 */
    getStatus(): { state: CircuitState; failureCount: number } {
        return { state: this.state, failureCount: this.failureCount };
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    /**
     * 显示熔断通知
     * 有节流机制，30s 内不重复弹出
     */
    private showNotification(config: CircuitBreakerConfig): void {
        // 如果注入了自定义回调，使用它（用于测试）
        if (this.notifyCallback) {
            this.notifyCallback(this.featureName, config.failureThreshold, config.cooldownSeconds);
            return;
        }

        const now = Date.now();
        if (now - this.lastNotificationTime < this.notificationThrottleMs) {
            return;
        }
        this.lastNotificationTime = now;

        // 集中获取依赖（惰性 require 避免 node:test 环境解析失败）
        const t = getT();
        const vscode = getVscode();
        const retryLabel = t('Retry Now', '立即重试');
        const settingsLabel = t('View Settings', '查看设置');

        const message = t(
            '{0} completion requests have failed {1} times consecutively. Service has been temporarily paused for {2}s. You can manually retry or check the model configuration.',
            '{0} 补全请求已连续失败 {1} 次，已暂时停止请求（{2}秒冷却）。可手动重试或检查模型配置。',
            this.featureName,
            String(config.failureThreshold),
            String(config.cooldownSeconds)
        );

        vscode.window.showWarningMessage(message, retryLabel, settingsLabel).then(
            choice => {
                if (choice === retryLabel) {
                    this.reset();
                } else if (choice === settingsLabel) {
                    vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        this.configSection.replace(/\.circuitBreaker$/, '')
                    );
                }
            },
            () => {
                // 通知系统异常时静默，避免未处理的 Promise 拒绝
            }
        );
    }
}
