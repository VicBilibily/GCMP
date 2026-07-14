import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeNativeToolConfigs } from './nativeToolUtils';

test('mergeNativeToolConfigs lets later nativeTools override earlier duplicate types', () => {
    const merged = mergeNativeToolConfigs([
        { type: 'web_search', allowedDomains: ['a.com'] },
        { type: 'code_interpreter' },
        { type: 'web_search', allowedDomains: ['b.com'], blockedDomains: ['c.com'] }
    ]);

    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0], {
        type: 'web_search',
        allowedDomains: ['b.com'],
        blockedDomains: ['c.com']
    });
    assert.deepEqual(merged[1], { type: 'code_interpreter' });
});

test('mergeNativeToolConfigs skips legacy webSearchTool when nativeTools already contains web_search', () => {
    const merged = mergeNativeToolConfigs([{ type: 'web_search', allowedDomains: ['native.com'] }], {
        allowedDomains: ['legacy.com']
    });

    assert.deepEqual(merged, [{ type: 'web_search', allowedDomains: ['native.com'] }]);
});

test('mergeNativeToolConfigs appends legacy webSearchTool when nativeTools has no web_search', () => {
    const merged = mergeNativeToolConfigs([{ type: 'code_interpreter' }], {
        allowedDomains: ['legacy.com'],
        userLocation: { country: 'CN' }
    });

    assert.deepEqual(merged, [
        { type: 'code_interpreter' },
        {
            type: 'web_search',
            allowedDomains: ['legacy.com'],
            userLocation: { country: 'CN' }
        }
    ]);
});
