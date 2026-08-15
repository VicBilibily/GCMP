/*---------------------------------------------------------------------------------------------
 *  GCRA（通用信元速率算法）单维限流器
 *  burst=0 纯匀速 pacing：低 RPM 场景下消除冷启动突发
 *  纯逻辑模块，不依赖 vscode，可被 node:test 单元测试直接引用
 *--------------------------------------------------------------------------------------------*/

export interface GcraOptions {
    /** 每个请求/单位之间的最小间隔（毫秒） */
    emissionIntervalMs: number;
}

/**
 * 单维 GCRA 限流器
 * 状态仅一个 TAT（理论到达时间），O(1) 内存；burst=0 表示严格匀速放行
 */
export class Gcra {
    /** 下一次请求的理论允许时刻（毫秒） */
    private tat = 0;

    constructor(private readonly options: GcraOptions) {
        if (!(options.emissionIntervalMs > 0)) {
            throw new Error('emissionIntervalMs must be > 0');
        }
    }

    /**
     * 更新速率间隔（配置热更新时调用）。
     * 只改 interval，保留 tat 绝对值：已推进的配额不追溯，新间隔仅影响后续推进量。
     */
    setEmissionInterval(intervalMs: number): void {
        if (!(intervalMs > 0)) {
            throw new Error('emissionIntervalMs must be > 0');
        }
        this.options.emissionIntervalMs = intervalMs;
    }

    /**
     * 计算给定成本要等待多久，并立即推进 TAT（即扣费）
     * @param cost 请求成本（requests 维为 1，tokens 维为 token 数）
     * @param now 当前时间（毫秒）
     * @returns 需要等待的毫秒数（>= 0）
     */
    acquire(cost: number, now: number): number {
        if (cost <= 0) {
            return 0;
        }
        // start = max(tat, now)：tat 落后则立即放行，超前则按差值排队
        const start = Math.max(this.tat, now);
        this.tat = start + cost * this.options.emissionIntervalMs;
        return start - now;
    }

    /**
     * 返还未来容量（TAT 回拨），不回溯历史
     */
    refund(cost: number, now: number): void {
        if (cost <= 0) {
            return;
        }
        this.tat = Math.max(now, this.tat - cost * this.options.emissionIntervalMs);
    }

    /**
     * 当前状态（用于测试/观测）
     */
    peek(now: number): { waitMs: number } {
        return { waitMs: Math.max(0, this.tat - now) };
    }
}

/**
 * 从速率上限换算 GCRA 间隔（每分钟速率 → 毫秒间隔）
 */
export function intervalFromPerMinute(perMinute: number): number {
    return 60_000 / perMinute;
}

/**
 * 从速率上限换算 GCRA 间隔（每秒速率 → 毫秒间隔）
 */
export function intervalFromPerSecond(perSecond: number): number {
    return 1_000 / perSecond;
}
