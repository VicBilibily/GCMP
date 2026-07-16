import assert from 'node:assert/strict';
import test from 'node:test';

import { meanWithoutOutliers } from './utils';

test('meanWithoutOutliers returns median when MAD collapses with extreme outlier', () => {
    assert.equal(meanWithoutOutliers([100, 100, 5000]), 100);
    assert.equal(meanWithoutOutliers([100, 100, 100, 5000]), 100);
});

test('meanWithoutOutliers still downweights outliers when MAD is non-zero', () => {
    const result = meanWithoutOutliers([100, 101, 102, 5000]);

    assert.notEqual(result, undefined);
    assert.ok(result! > 100);
    assert.ok(result! < 103);
});
