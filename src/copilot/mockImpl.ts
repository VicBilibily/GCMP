/*---------------------------------------------------------------------------------------------
 *  此文件包含为创建 FIM / NES 必要的参数而实现的类，但只是空实现，没有实际使用。
 *  这些类仅用于满足 VS Code chat-lib 库的接口要求，使扩展能够正常初始化。
 *
 *  包含的空实现：
 *  - AuthenticationService: 认证服务实现，无实际验证逻辑
 *  - TelemetrySender: 遥测发送器实现，不发送任何数据
 *  - EndpointProvider：官方的示例传参，目前没具体作用，先留着
 *
 *  参考: getInlineCompletions.spec.ts 和 nesProvider.spec.ts 的测试示例
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession, ChatRequest, LanguageModelChat } from 'vscode';
import { IAuthenticationService, IEndpointProvider, ITelemetrySender } from '@vscode/chat-lib';
import { ICopilotTokenManager } from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotTokenManager';
import { CopilotToken } from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotToken';
import { Emitter, Event } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/event';
import { Disposable } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/lifecycle';
import {
    ChatEndpointFamily,
    EmbeddingsEndpointFamily,
    ICompletionModelInformation
} from '@vscode/chat-lib/dist/src/_internal/platform/endpoint/common/endpointProvider';
import {
    IChatEndpoint,
    IEmbeddingsEndpoint
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';

/**
 * 简单的认证服务实现，无实际验证逻辑
 *
 * 这是一个空实现，仅用于满足 NES 的接口要求。
 * 实际项目不使用，仅传递给 chat-lib 以符合官方接口要求。
 * 所有方法都返回默认值或空值，不执行任何实际的认证操作。
 */
export class AuthenticationService extends Disposable implements IAuthenticationService, ICopilotTokenManager {
    readonly _serviceBrand: undefined;
    readonly isMinimalMode = true; // 标识非官方模式，不请求 GHToken
    readonly anyGitHubSession = undefined;
    readonly permissiveGitHubSession = undefined;
    readonly copilotToken = new CopilotToken({
        token: `gcmp-token-${Math.ceil(Math.random() * 100)}`,
        refresh_in: 0,
        expires_at: 0,
        username: 'gcmpuser',
        isVscodeTeamMember: false,
        copilot_plan: 'individual'
    });
    speculativeDecodingEndpointToken: string | undefined;

    private readonly _onDidCopilotTokenRefresh = this._register(new Emitter<void>());
    readonly onDidCopilotTokenRefresh: Event<void> = this._onDidCopilotTokenRefresh.event;

    private readonly _onDidAuthenticationChange = this._register(new Emitter<void>());
    readonly onDidAuthenticationChange: Event<void> = this._onDidAuthenticationChange.event;

    private readonly _onDidAccessTokenChange = this._register(new Emitter<void>());
    readonly onDidAccessTokenChange: Event<void> = this._onDidAccessTokenChange.event;

    private readonly _onDidAdoAuthenticationChange = this._register(new Emitter<void>());
    readonly onDidAdoAuthenticationChange: Event<void> = this._onDidAdoAuthenticationChange.event;

    async getAnyGitHubSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getPermissiveGitHubSession(
        _options: AuthenticationGetSessionOptions
    ): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getGitHubSession(
        _kind: 'permissive' | 'any',
        _options?: AuthenticationGetSessionOptions
    ): Promise<AuthenticationSession> {
        throw new Error('Method not implemented.');
    }

    async getCopilotToken(_force?: boolean): Promise<CopilotToken> {
        return this.copilotToken;
    }

    resetCopilotToken(_httpError?: number): void {
        this._onDidCopilotTokenRefresh.fire();
    }

    async getAdoAccessTokenBase64(_options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
        return undefined;
    }
}

/**
 * 遥测发送器实现
 *
 * 这是一个空实现，仅用于满足 NES 的接口要求。
 * 所有遥测事件都被忽略，不发送任何数据到外部服务。
 * 这确保了用户隐私和数据安全，同时满足 VS Code 扩展的接口要求。
 */
export class TelemetrySender implements ITelemetrySender {
    sendTelemetryEvent(
        _eventName: string,
        _properties?: Record<string, string | undefined>,
        _measurements?: Record<string, number | undefined>
    ): void {
        return;
    }
}

/**
 * 端点提供者实现
 */
export class EndpointProvider implements IEndpointProvider {
    readonly _serviceBrand: undefined;

    async getAllCompletionModels(_forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
        return [];
    }

    async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
        return [];
    }

    async getChatEndpoint(
        _requestOrFamily: LanguageModelChat | ChatRequest | ChatEndpointFamily
    ): Promise<IChatEndpoint> {
        throw new Error('Method not implemented.');
    }

    async getEmbeddingsEndpoint(_family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
        throw new Error('Method not implemented.');
    }
}
