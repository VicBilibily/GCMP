/*---------------------------------------------------------------------------------------------
 *  Copilot Auth - 认证服务实现
 *  实现 IAuthenticationService 和 ICopilotTokenManager 接口
 *  参考: getInlineCompletions.spec.ts 中的 TestAuthService
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { IAuthenticationService } from '@vscode/chat-lib';
import { ICopilotTokenManager } from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotTokenManager';
import { CopilotToken } from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotToken';
import { Emitter, Event } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/event';
import { Disposable } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/lifecycle';

/**
 * 简单的认证服务实现，无实际验证逻辑
 * 实际项目不使用，仅传递给 chat-lib 以符合官方接口要求
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
    readonly onDidAuthenticationChange = this._onDidAuthenticationChange.event;

    private readonly _onDidAccessTokenChange = this._register(new Emitter<void>());
    readonly onDidAccessTokenChange = this._onDidAccessTokenChange.event;

    private readonly _onDidAdoAuthenticationChange = this._register(new Emitter<void>());
    readonly onDidAdoAuthenticationChange = this._onDidAdoAuthenticationChange.event;

    async getAnyGitHubSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getPermissiveGitHubSession(
        _options: AuthenticationGetSessionOptions
    ): Promise<AuthenticationSession | undefined> {
        return undefined;
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
