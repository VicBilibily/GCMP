/*---------------------------------------------------------------------------------------------
 *  Prompt Strategy Types - 提示词策略类型定义
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';

/**
 * 使用场景类型枚举
 */
export enum UseCaseType {
    /** 自动触发（默认） */
    AUTO_TRIGGER = 'AUTO_TRIGGER',
    /** 新行补全 */
    NEW_LINE = 'NEW_LINE',
    /** 行内补全 */
    INLINE_COMPLETION = 'INLINE_COMPLETION',
    /** 注释驱动 */
    COMMENT_DRIVEN = 'COMMENT_DRIVEN',
    /** 错误修复 */
    ERROR_FIX = 'ERROR_FIX'
}

/**
 * 上下文分析结果
 */
export interface ContextAnalysis {
    /** 使用场景类型 */
    useCase: UseCaseType;
    /** 是否在注释中 */
    isInComment: boolean;
    /** 是否为新行 */
    isNewLine: boolean;
    /** 是否为行内编辑 */
    isInlineEdit: boolean;
    /** 当前行文本 */
    cursorLine: string;
    /** 光标位置 */
    cursorPosition: number;
    /** 是否有选中文本 */
    hasSelection: boolean;
}

/**
 * 提示词策略接口
 */
export interface PromptStrategy {
    /** 策略名称 */
    name: string;

    /** 策略类型 */
    type: UseCaseType;

    /** 判断是否能处理给定上下文 */
    canHandle(context: GhostContext, analysis: ContextAnalysis): boolean;

    /** 获取系统提示词 */
    getSystemPrompt(): string;

    /** 获取用户提示词 */
    getUserPrompt(context: GhostContext): string;

    /** 获取策略优先级（数字越大优先级越高） */
    getPriority(): number;
}
