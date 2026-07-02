import assert from 'node:assert/strict';
import test from 'node:test';

import { isCancellationError } from './cancellationError';

test('detects cancellation error through deeply nested cause chain without recursion', () => {
    let root: Record<string, unknown> = { name: 'RootError' };
    let current = root;

    for (let index = 0; index < 2048; index++) {
        const next: Record<string, unknown> = { name: `NestedError-${index}` };
        current.cause = next;
        current = next;
    }

    current.error = { name: 'AbortError' };

    assert.equal(isCancellationError(root), true);
});

test('returns false for cyclic nested errors without hanging', () => {
    const root: Record<string, unknown> = { name: 'RootError' };
    const nested: Record<string, unknown> = { name: 'NestedError' };

    root.cause = nested;
    nested.error = root;

    assert.equal(isCancellationError(root), false);
});

test('detects cancellation error inside cyclic graph', () => {
    const root: Record<string, unknown> = { name: 'RootError' };
    const nested: Record<string, unknown> = { name: 'NestedError' };
    const abort: Record<string, unknown> = { name: 'AbortError' };

    root.cause = nested;
    nested.error = root;
    nested.cause = abort;

    assert.equal(isCancellationError(root), true);
});
