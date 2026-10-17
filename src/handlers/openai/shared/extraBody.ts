export function filterExtraBodyParams(
    extraBody: Record<string, unknown>,
    coreParams: ReadonlySet<string>
): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(extraBody)) {
        if (!coreParams.has(key)) {
            filtered[key] = value;
            if (value == null) {
                filtered[key] = undefined;
            }
        }
    }

    return filtered;
}
