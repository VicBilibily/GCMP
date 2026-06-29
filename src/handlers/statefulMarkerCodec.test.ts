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

test('encode + decode roundtrip with real-world GCMP modelId and all marker fields', () => {
    const marker = {
        sessionId: 'aeb324d9-1234-5678-9abc-def012345678',
        responseId: 'chatcmpl-test-id-1234567890abcdef',
        hasToolCalls: true,
        provider: 'stepfun',
        modelId: 'gcmp.stepfun:::step-3.7-flash-step-plan',
        sdkMode: 'anthropic' as const,
        completeThinking:
            'Let me analyze the request step by step:\n1. First, I need to check the file structure\n2. Then read the relevant files\n3. Finally propose a fix',
        completeSignature: 'signature_delta_accumulated_value_here'
    };

    const decoded = decodeStatefulMarkerPayload<typeof marker>(
        encodeStatefulMarkerPayload('gcmp.stepfun:::step-3.7-flash-step-plan', marker)
    );

    assert.ok(decoded, 'roundtrip should succeed');
    assert.equal(decoded.modelId, 'gcmp.stepfun:::step-3.7-flash-step-plan');
    assert.equal(decoded.marker.sessionId, marker.sessionId);
    assert.equal(decoded.marker.responseId, marker.responseId);
    assert.equal(decoded.marker.hasToolCalls, true);
    assert.equal(decoded.marker.completeThinking, marker.completeThinking);
    assert.equal(decoded.marker.completeSignature, marker.completeSignature);
});

test('backward compatibility: old raw JSON format can still be decoded', () => {
    const oldRawPayload = new TextEncoder().encode(
        'deepseek-v4-flash\\{"sessionId":"old-uuid-xxxx-yyyy","responseId":"resp-123"}'
    );

    const decoded = decodeStatefulMarkerPayload<{ sessionId: string; responseId: string }>(oldRawPayload);

    assert.ok(decoded, 'old raw JSON format should be decoded');
    assert.equal(decoded.modelId, 'deepseek-v4-flash');
    assert.equal(decoded.marker.sessionId, 'old-uuid-xxxx-yyyy');
    assert.equal(decoded.marker.responseId, 'resp-123');
});

test('roundtrip with large completeThinking content (multi-line code)', () => {
    // Simulate the real payload that was previously getting truncated
    const marker = {
        sessionId: 'test-large-thinking-12345678',
        responseId: 'resp-large',
        hasToolCalls: false,
        provider: 'stepfun',
        modelId: 'gcmp.stepfun:::step-3.7-flash-step-plan',
        sdkMode: 'anthropic' as const,
        completeThinking: [
            'I need to understand the problem first.',
            'Let me look at the codebase structure...',
            'The key file is src/handlers/statefulMarkerCodec.ts',
            'The separator is backslash, so paths like C:\\Users\\test\\file.txt need careful handling.',
            'Multi-line code blocks:\n```typescript\nfunction foo() {\n  return "hello world";\n}\n```',
            'Special chars: \'quotes\', "double quotes", {braces}, <tags>, &ampersands',
            'Unicode: 中文, 日本語, 한국어, español, français, порусский',
            'Long paths: /very/long/path/to/some/deeply/nested/directory/structure/file.txt',
            'JSON nested in thinking: {"key": "value", "nested": {"a": 1, "b": [1,2,3]}}',
            'Backslashes galore: \\\\\\\\server\\share\\path\\to\\file\\\\escaped\\\\'
        ].join('\n')
    };

    const encoded = encodeStatefulMarkerPayload('gcmp.stepfun:::step-3.7-flash-step-plan', marker);
    const decoded = decodeStatefulMarkerPayload<typeof marker>(encoded);

    assert.ok(decoded, 'large completeThinking roundtrip should succeed');
    assert.equal(decoded.marker.completeThinking, marker.completeThinking);
    // Verify payload isn't truncated: base64url has no special chars,
    // so the decoded length should match exactly
    assert.equal(decoded.marker.completeThinking.length, marker.completeThinking.length);
});

test('toOptionalStatefulMarkerField preserves surrounding whitespace and only omits empty strings', () => {
    assert.equal(toOptionalStatefulMarkerField(''), undefined);
    assert.equal(toOptionalStatefulMarkerField('   '), '   ');
    assert.equal(toOptionalStatefulMarkerField('  keep trailing\\n'), '  keep trailing\\n');
});
