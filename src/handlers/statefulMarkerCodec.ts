export interface DecodedStatefulMarkerPayload<TMarker> {
    modelId: string;
    marker: TMarker;
}

// 分隔符选用单字符 '\'：modelId 是受控标识符（不含反斜杠），
// 而 marker 部分会经 JSON.stringify 处理，其中的反斜杠会被自动转义为 \\，
// 解析时用 indexOf 取第一个未转义的 '\' 即可安全切分。
const MARKER_SEPARATOR = '\\';

export function encodeStatefulMarkerPayload<TMarker>(modelId: string, marker: TMarker): Uint8Array {
    return new TextEncoder().encode(`${modelId}${MARKER_SEPARATOR}${JSON.stringify(marker)}`);
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
    const markerStr = decoded.slice(separatorIndex + 1);

    try {
        return {
            modelId,
            marker: JSON.parse(markerStr) as TMarker
        };
    } catch {
        return undefined;
    }
}

export function toOptionalStatefulMarkerField(value: string): string | undefined {
    return value === '' ? undefined : value;
}
