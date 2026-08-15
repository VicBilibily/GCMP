import assert from 'node:assert/strict';
import test from 'node:test';

import { intervalFromPerMinute, intervalFromPerSecond } from './gcra';

test('interval 换算', () => {
    assert.equal(intervalFromPerMinute(60), 1000);
    assert.equal(intervalFromPerSecond(2), 500);
});
