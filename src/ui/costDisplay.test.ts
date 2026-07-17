import assert from 'node:assert/strict';
import test from 'node:test';

import { getDisplayCostPresentation } from './costDisplay';

test('mixed currency falls back to USD when native split is zeroed', () => {
    const result = getDisplayCostPresentation({
        usd: 1.92,
        nativeUsd: 0,
        nativeRmb: 0,
        currency: 'MIXED',
        fixedDecimals: 2
    });

    assert.equal(result.text, '$1.92');
    assert.deepEqual(result.segments, [{ text: '$1.92', currency: 'USD' }]);
});

test('mixed currency keeps native RMB when present', () => {
    const result = getDisplayCostPresentation({
        usd: 0.01,
        rmb: 0.07,
        nativeUsd: 0,
        nativeRmb: 0.07,
        currency: 'MIXED',
        fixedDecimals: 2,
        exactRmb: true
    });

    assert.equal(result.text, '¥0.07');
    assert.deepEqual(result.segments, [{ text: '¥0.07', currency: 'RMB' }]);
});
