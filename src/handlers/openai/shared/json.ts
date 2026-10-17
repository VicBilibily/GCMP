export function sortObjectKeysRecursively(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortObjectKeysRecursively);
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = sortObjectKeysRecursively((value as Record<string, unknown>)[key]);
    }
    return result;
}

export function canonicalizeJsonString(raw: string): string {
    try {
        return JSON.stringify(sortObjectKeysRecursively(JSON.parse(raw)));
    } catch {
        return raw;
    }
}
