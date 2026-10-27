import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSearchToolResult, getSearchQuery } from './searchToolResult';

test('formats a structured completed search result envelope', () => {
    const result = JSON.parse(
        formatSearchToolResult({
            provider: 'kimi',
            query: 'VS Code tools',
            results: [{ title: 'Result', url: 'https://example.com' }],
            requestId: 'request-1'
        })
    );

    assert.deepEqual(result, {
        type: 'search_results',
        status: 'completed',
        provider: 'kimi',
        query: 'VS Code tools',
        resultCount: 1,
        results: [{ title: 'Result', url: 'https://example.com' }],
        requestId: 'request-1'
    });
});

test('extracts search keywords from provider input fields', () => {
    assert.equal(getSearchQuery({ query: '  first  ', q: 'second' }, 'query', 'q'), 'first');
    assert.equal(getSearchQuery('  direct  ', 'query'), 'direct');
    assert.equal(getSearchQuery({ query: 42 }, 'query'), '');
});
