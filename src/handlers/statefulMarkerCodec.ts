export interface DecodedStatefulMarkerPayload<TMarker> {
    modelId: string;
    marker: TMarker;
}

// 分隔符选用单字符 '\'：modelId 是受控标识符（不含反斜杠），
// 而 marker 部分会经 JSON.stringify 处理，其中的反斜杠会被自动转义为 \\，
// 解析时用 indexOf 取第一个未转义的 '\' 即可安全切分。
const MARKER_SEPARATOR = '\\';

/**
 * JSON payload 使用 base64url 编码的前缀标记。
 * 采用 base64url 而非明文 JSON 的原因：
 *
 * 1. VS Code 聊天历史序列化管道对原始 JSON 中的特殊字符（\n、\t、\"、\\ 等）
 *    处理不稳定，可能在未预期的位置截断 payload。
 * 2. base64url 只含 [A-Za-z0-9_-]，无任何特殊字符，可安全通过序列化。
 * 3. 体积比原始 JSON 略微缩小（约 33% 的 base64 膨胀 vs 原始 JSON 的
 *    转义膨胀，对代码片段而言 base64 通常更紧凑）。
 *
 * 参考实现：deepseek-v4-for-copilot 的 replay marker 编码策略。
 */
const JSON_PAYLOAD_PREFIX = 'json:';

export function encodeStatefulMarkerPayload<TMarker>(modelId: string, marker: TMarker): Uint8Array {
    const jsonStr = JSON.stringify(marker);
    return new TextEncoder().encode(
        `${modelId}${MARKER_SEPARATOR}${JSON_PAYLOAD_PREFIX}${Buffer.from(jsonStr, 'utf-8').toString('base64url')}`
    );
}

export function decodeStatefulMarkerPayload<TMarker>(
    data: Uint8Array
): DecodedStatefulMarkerPayload<TMarker> | undefined {
    const decoded = new TextDecoder().decode(data);
    const separatorIndex = decoded.indexOf(MARKER_SEPARATOR);

    if (separatorIndex < 0) {
        return undefined;
    }

    const modelId = decoded.slice(0, separatorIndex);
    const markerEncoded = decoded.slice(separatorIndex + 1);

    let markerStr: string;

    // 支持两种格式：
    // 1. 新格式：json:<base64url> — 首选的 base64url 编码 JSON
    // 2. 旧格式（向后兼容）：裸 JSON 字符串 — JSON.parse 直接解析
    if (markerEncoded.startsWith(JSON_PAYLOAD_PREFIX)) {
        const base64Payload = markerEncoded.slice(JSON_PAYLOAD_PREFIX.length);
        try {
            markerStr = Buffer.from(base64Payload, 'base64url').toString('utf-8');
        } catch {
            return undefined;
        }
    } else {
        // 向后兼容旧格式
        markerStr = markerEncoded;
    }

    try {
        const parsed = JSON.parse(markerStr) as TMarker;
        return {
            modelId,
            marker: parsed
        };
    } catch {
        return undefined;
    }
}

export function toOptionalStatefulMarkerField(value: string): string | undefined {
    return value === '' ? undefined : value;
}
