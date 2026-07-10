/*---------------------------------------------------------------------------------------------
 *  CompletionCircuitBreaker 单元测试
 *
 *  通过注入 configProvider 和 notifyCallback 避免 vscode 依赖，
 *  使测试可在 node:test 环境运行。
 *--------------------------------------------------------------------------------------------*/

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    CompletionCircuitBreaker,
    CircuitState,
    CircuitBreakerConfig,
    CircuitBreakerNotifyCallback
} from './completionCircuitBreaker';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

// ========================================================================
// 测试辅助函数
// ========================================================================

/** 创建静态配置提供者 */
function staticConfig(overrides: Partial<CircuitBreakerConfig> = {}): () => CircuitBreakerConfig {
    return () => ({
        enabled: true,
        failureThreshold: 5,
        cooldownSeconds: 30,
        ...overrides
    });
}

/** 创建可动态切换的配置提供者 */
function mutableConfig(initial: Partial<CircuitBreakerConfig> = {}): {
    get: () => CircuitBreakerConfig;
    update: (overrides: Partial<CircuitBreakerConfig>) => void;
} {
    let current: CircuitBreakerConfig = {
        enabled: true,
        failureThreshold: 5,
        cooldownSeconds: 30,
        ...initial
    };
    return {
        get: () => current,
        update: overrides => {
            current = { ...current, ...overrides };
        }
    };
}

/** 创建带注入的熔断器（默认注入 no-op notifyCallback 避免 l10n→vscode 依赖） */
function createBreaker(
    featureName: string,
    configProvider: () => CircuitBreakerConfig,
    notifyCallback?: CircuitBreakerNotifyCallback
): CompletionCircuitBreaker {
    return new CompletionCircuitBreaker(featureName, 'test', configProvider, notifyCallback ?? (() => {}));
}

function withMockedWorkspaceConfig(
    featureName: 'FIM' | 'NES',
    configSection: string,
    values: {
        enabled?: unknown;
        failureThreshold?: unknown;
        cooldownSeconds?: unknown;
    },
    run: (cb: CompletionCircuitBreaker) => void
): void {
    const originalRequire = NodeModule.prototype.require;

    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                workspace: {
                    getConfiguration: () => ({
                        get: <T>(section: string, defaultValue: T): T => {
                            if (section === `${configSection}.enabled` && 'enabled' in values) {
                                return values.enabled as T;
                            }
                            if (section === `${configSection}.failureThreshold` && 'failureThreshold' in values) {
                                return values.failureThreshold as T;
                            }
                            if (section === `${configSection}.cooldownSeconds` && 'cooldownSeconds' in values) {
                                return values.cooldownSeconds as T;
                            }
                            return defaultValue;
                        }
                    })
                },
                window: {
                    showWarningMessage: () => Promise.resolve(undefined)
                },
                commands: {
                    executeCommand: () => Promise.resolve(undefined)
                }
            };
        }

        if (id === '../utils/l10n') {
            return {
                t: (en: string) => en
            };
        }

        return originalRequire.call(this, id);
    };

    try {
        run(new CompletionCircuitBreaker(featureName, configSection));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
}

// ========================================================================
// 测试用例
// ========================================================================

describe('CompletionCircuitBreaker', () => {
    // --------------------------------------------------------------------
    // 基本状态机
    // --------------------------------------------------------------------

    it('初始状态为 Closed，请求允许通过', () => {
        const cb = createBreaker('FIM', staticConfig());
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
        assert.strictEqual(cb.getStatus().failureCount, 0);
        assert.strictEqual(cb.allowRequest(), true);
    });

    it('连续失败达到阈值后熔断', () => {
        const cb = createBreaker('FIM', staticConfig({ failureThreshold: 3 }));

        cb.recordFailure();
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
        assert.strictEqual(cb.allowRequest(), true);

        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.allowRequest(), false);
    });

    it('熔断后请求被阻止', () => {
        const cb = createBreaker('FIM', staticConfig({ failureThreshold: 1 }));
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.allowRequest(), false);
    });

    it('成功请求重置失败计数', () => {
        const cb = createBreaker('FIM', staticConfig({ failureThreshold: 5 }));
        cb.recordFailure();
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().failureCount, 2);

        cb.recordSuccess();
        assert.strictEqual(cb.getStatus().failureCount, 0);
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
    });

    it('成功请求在 Closed 状态保持 Closed', () => {
        const cb = createBreaker('FIM', staticConfig());
        cb.recordSuccess();
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
    });

    // --------------------------------------------------------------------
    // 半开状态 (HalfOpen)
    // --------------------------------------------------------------------

    it('冷却时间过后进入 HalfOpen 并允许一次探测', () => {
        const cb = createBreaker(
            'FIM',
            staticConfig({
                failureThreshold: 1,
                cooldownSeconds: 0
            })
        );

        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);

        assert.strictEqual(cb.allowRequest(), true);
        assert.strictEqual(cb.getStatus().state, CircuitState.HalfOpen);

        // HalfOpen 只允许一次探测，后续请求被阻止
        assert.strictEqual(cb.allowRequest(), false);
        assert.strictEqual(cb.allowRequest(), false);
    });

    it('HalfOpen 探测成功 → 回到 Closed', () => {
        const cb = createBreaker(
            'FIM',
            staticConfig({
                failureThreshold: 1,
                cooldownSeconds: 0
            })
        );

        cb.recordFailure();
        assert.strictEqual(cb.allowRequest(), true);
        cb.recordSuccess();
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
        assert.strictEqual(cb.getStatus().failureCount, 0);
    });

    it('HalfOpen 探测失败 → 重新熔断', () => {
        const cb = createBreaker(
            'FIM',
            staticConfig({
                failureThreshold: 1,
                cooldownSeconds: 0
            })
        );

        cb.recordFailure();
        assert.strictEqual(cb.allowRequest(), true);
        cb.recordFailure();

        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.allowRequest(), true);
        assert.strictEqual(cb.getStatus().state, CircuitState.HalfOpen);
    });

    it('HalfOpen 探测失败后 failureCount 锁定为阈值，不无限累加', () => {
        const cb = createBreaker(
            'FIM',
            staticConfig({
                failureThreshold: 3,
                cooldownSeconds: 0
            })
        );

        // 达到阈值熔断
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.getStatus().failureCount, 3);

        // 冷却后探测，连续失败
        cb.allowRequest(); // → HalfOpen
        cb.recordFailure(); // → Open, failureCount 应锁定为阈值 3
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.getStatus().failureCount, 3);

        cb.allowRequest(); // → HalfOpen
        cb.recordFailure(); // → Open, 仍应为 3
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.getStatus().failureCount, 3);
    });

    it('HalfOpen 探测被取消后仍可重新探测（不卡死）', () => {
        const cb = createBreaker(
            'FIM',
            staticConfig({
                failureThreshold: 1,
                cooldownSeconds: 0
            })
        );

        cb.recordFailure();
        // 第一次探测被发放
        assert.strictEqual(cb.allowRequest(), true);
        assert.strictEqual(cb.getStatus().state, CircuitState.HalfOpen);
        // 取消不应消耗探测名额
        cb.recordCancellation();
        // 仍可再次探测
        assert.strictEqual(cb.allowRequest(), true);
        assert.strictEqual(cb.getStatus().state, CircuitState.HalfOpen);
    });

    it('recordCancellation 在 Closed/Open 状态为 no-op，不影响状态与计数', () => {
        const cb = createBreaker('FIM', staticConfig({ failureThreshold: 2 }));

        // Closed 状态：取消不改任何字段
        cb.recordCancellation();
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
        assert.strictEqual(cb.getStatus().failureCount, 0);

        // Open 状态：取消不重置冷却、不恢复通行
        cb.recordFailure();
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        cb.recordCancellation();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);
        assert.strictEqual(cb.allowRequest(), false);
    });

    // --------------------------------------------------------------------
    // 手动重置
    // --------------------------------------------------------------------

    it('reset() 恢复到 Closed 状态', () => {
        const cb = createBreaker('FIM', staticConfig({ failureThreshold: 1 }));
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);

        cb.reset();
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
        assert.strictEqual(cb.getStatus().failureCount, 0);
        assert.strictEqual(cb.allowRequest(), true);
    });

    // --------------------------------------------------------------------
    // 禁用熔断
    // --------------------------------------------------------------------

    it('disabled 时始终允许请求', () => {
        const cb = createBreaker('FIM', staticConfig({ enabled: false }));
        for (let i = 0; i < 10; i++) {
            cb.recordFailure();
        }
        assert.strictEqual(cb.allowRequest(), true);
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
    });

    it('disabled 时 recordFailure 不计数', () => {
        const cb = createBreaker('FIM', staticConfig({ enabled: false }));
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().failureCount, 0);
    });

    it('生产配置读取时，非法 enabled 会回退到默认 true', () => {
        withMockedWorkspaceConfig(
            'FIM',
            'gcmp.fimCompletion.circuitBreaker',
            {
                enabled: 0,
                failureThreshold: 2
            },
            cb => {
                cb.recordFailure();
                assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
                cb.recordFailure();
                assert.strictEqual(cb.getStatus().state, CircuitState.Open);
                assert.strictEqual(cb.getStatus().failureCount, 2);
            }
        );
    });

    it('生产配置读取时，超出上限的 FIM failureThreshold 会回退到默认值 10', () => {
        withMockedWorkspaceConfig(
            'FIM',
            'gcmp.fimCompletion.circuitBreaker',
            {
                failureThreshold: 999
            },
            cb => {
                for (let i = 0; i < 9; i++) {
                    cb.recordFailure();
                }

                assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
                cb.recordFailure();
                assert.strictEqual(cb.getStatus().state, CircuitState.Open);
            }
        );
    });

    it('生产配置读取时，超出上限的 NES failureThreshold 会回退到默认值 5', () => {
        withMockedWorkspaceConfig(
            'NES',
            'gcmp.nesCompletion.circuitBreaker',
            {
                failureThreshold: 999
            },
            cb => {
                for (let i = 0; i < 4; i++) {
                    cb.recordFailure();
                }

                assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
                cb.recordFailure();
                assert.strictEqual(cb.getStatus().state, CircuitState.Open);
            }
        );
    });

    it('生产配置读取时，超出上限的 cooldownSeconds 会回退到默认值 30', () => {
        withMockedWorkspaceConfig(
            'FIM',
            'gcmp.fimCompletion.circuitBreaker',
            {
                failureThreshold: 2,
                cooldownSeconds: 999999
            },
            cb => {
                cb.recordFailure();
                cb.recordFailure();
                assert.strictEqual(cb.getStatus().state, CircuitState.Open);

                const originalNow = Date.now;
                const baseNow = originalNow();
                Date.now = () => baseNow + 30000;

                try {
                    assert.strictEqual(cb.allowRequest(), true);
                    assert.strictEqual(cb.getStatus().state, CircuitState.HalfOpen);
                } finally {
                    Date.now = originalNow;
                }
            }
        );
    });

    // --------------------------------------------------------------------
    // 动态配置
    // --------------------------------------------------------------------

    it('配置变更后即时生效', () => {
        const config = mutableConfig({ failureThreshold: 2 });
        const cb = createBreaker('FIM', config.get);

        cb.recordFailure();
        cb.recordFailure();
        assert.strictEqual(cb.getStatus().state, CircuitState.Open);

        cb.reset();
        config.update({ failureThreshold: 10 });
        for (let i = 0; i < 5; i++) {
            cb.recordFailure();
        }
        assert.strictEqual(cb.getStatus().state, CircuitState.Closed);
    });

    // --------------------------------------------------------------------
    // 通知回调
    // --------------------------------------------------------------------

    it('熔断时触发通知回调', () => {
        let notified = false;
        let notifiedFeature = '';
        const cb = createBreaker(
            'FIM',
            staticConfig({ failureThreshold: 1 }),
            (feature: string, _threshold: number, _cooldown: number) => {
                notified = true;
                notifiedFeature = feature;
            }
        );

        cb.recordFailure();
        assert.strictEqual(notified, true);
        assert.strictEqual(notifiedFeature, 'FIM');
    });

    it('HalfOpen 探测失败时再次触发通知回调', () => {
        let notificationCount = 0;
        const cb = createBreaker('NES', staticConfig({ failureThreshold: 1, cooldownSeconds: 0 }), () => {
            notificationCount++;
        });

        cb.recordFailure();
        assert.strictEqual(notificationCount, 1);

        cb.allowRequest();
        cb.recordFailure();
        assert.strictEqual(notificationCount, 2);
    });
});
