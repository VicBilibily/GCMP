import assert from 'node:assert/strict';
import test from 'node:test';

import { intervalFromPerMinute, intervalFromPerSecond } from './gcra';

test('interval 换算', () => {
    assert.equal(intervalFromPerMinute(60), 1000);
    assert.equal(intervalFromPerSecond(2), 500);
});

test('非有限或非正速率不生成 interval', () => {
    assert.equal(intervalFromPerMinute(0), undefined);
    assert.equal(intervalFromPerMinute(-1), undefined);
    assert.equal(intervalFromPerMinute(Number.NaN), undefined);
    assert.equal(intervalFromPerMinute(Number.POSITIVE_INFINITY), undefined);
    assert.equal(intervalFromPerSecond(0), undefined);
    assert.equal(intervalFromPerSecond(Number.NaN), undefined);
});
