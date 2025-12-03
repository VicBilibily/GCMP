/*---------------------------------------------------------------------------------------------
 *  Copilot Endpoint - 端点提供者实现
 *  实现 IEndpointProvider 接口
 *  参考: getInlineCompletions.spec.ts 中的 TestEndpointProvider
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import { IEndpointProvider } from '@vscode/chat-lib';
import {
    ChatEndpointFamily,
    EmbeddingsEndpointFamily,
    ICompletionModelInformation
} from '@vscode/chat-lib/dist/src/_internal/platform/endpoint/common/endpointProvider';
import {
    IChatEndpoint,
    IEmbeddingsEndpoint
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
import type { ChatRequest } from '@vscode/chat-lib/dist/src/_internal/vscodeTypes';

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
