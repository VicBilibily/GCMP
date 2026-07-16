import assert from 'node:assert/strict';
import test from 'node:test';

import { WritePermissionGate } from './writePermissionGate';

test('gate follows external evaluator by default', () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    assert.equal(gate.canWrite(), false);
});

test('runWithForcedWrites temporarily bypasses external evaluator', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    let observedInside = false;
    await gate.runWithForcedWrites(async () => {
        observedInside = gate.canWrite();
    });

    assert.equal(observedInside, true);
    assert.equal(gate.canWrite(), false);
});

test('nested forced-write scopes restore previous state correctly', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    let outer = false;
    let inner = false;
    await gate.runWithForcedWrites(async () => {
        outer = gate.canWrite();
        await gate.runWithForcedWrites(async () => {
            inner = gate.canWrite();
        });
        assert.equal(gate.canWrite(), true);
    });

    assert.equal(outer, true);
    assert.equal(inner, true);
    assert.equal(gate.canWrite(), false);
});