/*---------------------------------------------------------------------------------------------
 *  加密思考项（reasoning.encrypted_content）请求/回放判定
 *  纯逻辑模块：不依赖 vscode，供请求构建与消息转换两侧共用
 *--------------------------------------------------------------------------------------------*/

/** Responses API include 中用于请求加密思考内容的条目名 */
export const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content';

export interface EncryptedReasoningOrigin {
    provider?: string;
    modelId?: string;
}

/**
 * Responses API 只接受自己签发的 reasoning id（以 `rs` 开头）。
 * 外源 id（如 Anthropic 的 `thinking_0`）原样回传会 400。
 */
export function isResponsesReasoningId(id: string | undefined): boolean {
    return typeof id === 'string' && id.startsWith('rs');
}

/**
 * 判定是否请求/回放加密思考项（reasoning.encrypted_content）。
 *
 * 规则：
 * - extraBody 显式定义 include（含 null/[]）时视为用户接管：
 *   仅当 include 数组中包含 'reasoning.encrypted_content' 时启用；
 * - 未接管时按内置规则：请求模型名包含 gpt 且配置了 extraBody.reasoning。
 *
 * 请求侧（include 自动注入）与回放侧（input 携带密文 reasoning 项）共用本判定，
 * 保证两端一致：不要求下发密文时也不把历史密文回传，反之亦然。
 *
 * 典型用途：多资源 Azure 中转场景配置 { include: null } 后，
 * 既不要求服务端下发密文，也不回传会话历史中残留的旧密文（跨资源无法校验会 400）。
 */
export function isEncryptedReasoningEnabled(params: {
    requestModel: string;
    extraBody?: Record<string, unknown>;
}): boolean {
    const { requestModel, extraBody } = params;
    if (isIncludeOverridden(extraBody)) {
        const include = extraBody!.include;
        return Array.isArray(include) && include.includes(ENCRYPTED_REASONING_INCLUDE);
    }
    return requestModel.toLowerCase().includes('gpt') && !!extraBody?.reasoning;
}

/** include 一旦显式接管，未启用密文回放时也应禁用明文回放。 */
/** include 被显式接管时，历史思维链的明文/密文回放策略也一并由用户接管。 */
export function isIncludeOverridden(extraBody?: Record<string, unknown>): boolean {
    return extraBody != null && 'include' in extraBody;
}

/** GPT 端点会在服务端拒绝带明文 reasoning 历史回放的输入。 */
export function shouldReplayPlainThinking(params: {
    requestModel: string;
    extraBody?: Record<string, unknown>;
}): boolean {
    const { requestModel, extraBody } = params;
    if (requestModel.toLowerCase().includes('gpt')) {
        return false;
    }
    if (isIncludeOverridden(extraBody)) {
        return false;
    }
    return true;
}

/** 同 provider 即可跨模型复用密文推理。 */
export function isEncryptedReasoningOriginMatch(
    origin: EncryptedReasoningOrigin | undefined,
    currentOrigin: Required<EncryptedReasoningOrigin>
): boolean {
    return Boolean(origin?.provider && currentOrigin.provider && origin.provider === currentOrigin.provider);
}
