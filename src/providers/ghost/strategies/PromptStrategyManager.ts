/*---------------------------------------------------------------------------------------------
 *  Prompt Strategy Manager - 提示词策略管理器
 *  根据上下文选择最合适的策略
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';
import type { PromptStrategy } from './PromptStrategy';
import { ContextAnalyzer } from './ContextAnalyzer';
import { AutoTriggerStrategy } from './AutoTriggerStrategy';
import { NewLineStrategy } from './NewLineStrategy';
import { InlineCompletionStrategy } from './InlineCompletionStrategy';
import { CommentDrivenStrategy } from './CommentDrivenStrategy';

/**
 * 策略管理器
 * 负责选择和执行合适的提示词策略
 */
export class PromptStrategyManager {
    private strategies: PromptStrategy[];
    private contextAnalyzer: ContextAnalyzer;

    constructor() {
        this.contextAnalyzer = new ContextAnalyzer();

        // 注册所有策略（按优先级排序）
        this.strategies = [
            new CommentDrivenStrategy(),    // 优先级 8
            new NewLineStrategy(),          // 优先级 5
            new InlineCompletionStrategy(), // 优先级 4
            new AutoTriggerStrategy()       // 优先级 1（兜底）
        ];

        // 按优先级降序排序
        this.strategies.sort((a, b) => b.getPriority() - a.getPriority());
    }

    /**
     * 选择最合适的策略
     */
    public selectStrategy(context: GhostContext): PromptStrategy {
        // 分析上下文
        const analysis = this.contextAnalyzer.analyze(context);

        // 找到第一个能处理的策略
        for (const strategy of this.strategies) {
            if (strategy.canHandle(context, analysis)) {
                return strategy;
            }
        }

        // 兜底返回第一个策略（应该是 AutoTriggerStrategy）
        return this.strategies[this.strategies.length - 1];
    }

    /**
     * 构建提示词
     */
    public buildPrompts(context: GhostContext): {
        systemPrompt: string;
        userPrompt: string;
        strategy: PromptStrategy;
    } {
        const strategy = this.selectStrategy(context);
        const systemPrompt = strategy.getSystemPrompt();
        const userPrompt = strategy.getUserPrompt(context);

        return {
            systemPrompt,
            userPrompt,
            strategy
        };
    }

    /**
     * 获取所有策略（用于调试）
     */
    public getStrategies(): PromptStrategy[] {
        return this.strategies;
    }

    /**
     * 获取上下文分析器
     */
    public getContextAnalyzer(): ContextAnalyzer {
        return this.contextAnalyzer;
    }
}
