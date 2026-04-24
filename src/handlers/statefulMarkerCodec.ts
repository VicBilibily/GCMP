export interface DecodedStatefulMarkerPayload<TMarker> {
    modelId: string;
    marker: TMarker;
}

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
