import assert from 'node:assert/strict';
import test from 'node:test';
import {
    decodeStatefulMarkerPayload,
    encodeStatefulMarkerPayload,
    toOptionalStatefulMarkerField
} from './statefulMarkerCodec';

test('decodeStatefulMarkerPayload preserves JSON payloads containing backslashes', () => {
    const marker = {
        completeThinking: '  step 1\\nC:\\\\temp\\\\foo\\n  ',
        completeSignature: 'sig\\\\delta',
        nested: {
            sharePath: '\\\\\\\\server\\\\share'
        }
    };

    const decoded = decodeStatefulMarkerPayload<typeof marker>(
        encodeStatefulMarkerPayload('deepseek-v4-flash', marker)
    );

    assert.deepEqual(decoded, {
        modelId: 'deepseek-v4-flash',
        marker
    });
});

test('toOptionalStatefulMarkerField preserves surrounding whitespace and only omits empty strings', () => {
    assert.equal(toOptionalStatefulMarkerField(''), undefined);
    assert.equal(toOptionalStatefulMarkerField('   '), '   ');
    assert.equal(toOptionalStatefulMarkerField('  keep trailing\\n'), '  keep trailing\\n');
});
