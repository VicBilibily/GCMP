export interface SearchToolResultOptions {
    provider: string;
    query: string;
    results: readonly unknown[];
    requestId?: string;
}

export interface SearchToolResultEnvelope {
    type: 'search_results';
    status: 'completed';
    provider: string;
    query: string;
    resultCount: number;
    results: readonly unknown[];
    requestId?: string;
}

export function formatSearchToolResult(options: SearchToolResultOptions): string {
    const envelope: SearchToolResultEnvelope = {
        type: 'search_results',
        status: 'completed',
        provider: options.provider,
        query: options.query,
        resultCount: options.results.length,
        results: options.results
    };

    if (options.requestId) {
        envelope.requestId = options.requestId;
    }

    return JSON.stringify(envelope);
}

export function getSearchQuery(input: unknown, ...keys: string[]): string {
    if (typeof input === 'string') {
        return input.trim();
    }

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return '';
    }

    const record = input as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}
