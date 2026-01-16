/*---------------------------------------------------------------------------------------------
 *  提交模块类型定义
 *  提交消息生成功能的类型定义
 *--------------------------------------------------------------------------------------------*/

/**
 * 提交消息格式
 */
export type CommitFormat =
    | 'plain'
    | 'custom'
    | 'conventional'
    | 'angular'
    | 'karma'
    | 'semantic'
    | 'emoji'
    | 'emojiKarma'
    | 'google'
    | 'atom';

/**
 * 提交消息语言
 */
export type CommitLanguage = 'english' | 'chinese';

/**
 * 生成的提交消息结果
 */
export interface CommitMessage {
    /** 生成的提交消息 */
    message: string;
    /** 使用的模型 */
    model: string;
}

/**
 * 进度报告器接口
 */
export interface ProgressReporter {
    report(value: { message?: string; increment?: number }): void;
}

/**
 * 提交模块配置键
 */
/**
 * 提交消息生成使用的模型选择
 */
export interface CommitModelSelection {
    /** 语言模型提供商（providerKey，例如：zhipu / compatible） */
    provider: string;
    /** 模型 ID（对应 LanguageModelChatInformation.id） */
    model: string;
}

/**
 * 自定义错误类型
 */
export class UserCancelledError extends Error {
    constructor(message = 'User cancelled the operation') {
        super(message);
        this.name = 'UserCancelledError';
    }
}

export class NoChangesDetectedError extends Error {
    constructor(message = 'No changes detected') {
        super(message);
        this.name = 'NoChangesDetectedError';
    }
}

export class NoRepositoriesFoundError extends Error {
    constructor(message = 'No Git repositories found') {
        super(message);
        this.name = 'NoRepositoriesFoundError';
    }
}

export class NoRepositorySelectedError extends Error {
    constructor(message = 'No repository selected') {
        super(message);
        this.name = 'NoRepositorySelectedError';
    }
}

export class GitExtensionNotFoundError extends Error {
    constructor(message = 'Git extension not found') {
        super(message);
        this.name = 'GitExtensionNotFoundError';
    }
}

export class ModelNotFoundError extends Error {
    constructor(message = 'No language model available') {
        super(message);
        this.name = 'ModelNotFoundError';
    }
}

export class EmptyCommitMessageError extends Error {
    constructor(message = 'Generated commit message is empty') {
        super(message);
        this.name = 'EmptyCommitMessageError';
    }
}
