import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { AgentRole } from '../classification/requestClassification';
import type { StatefulMarkerContainer } from './statefulMarker';
import {
    decodeGCMPStatefulMarkerPayload,
    decodeStatefulMarkerPayload,
    describeStatefulMarkerPayload,
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

test('encrypted reasoning fields roundtrip without loss for both sdk modes', () => {
    // openai-responses：encryptedReasoning 数组（含特殊字符）
    const responsesMarker = {
        sessionId: 's-1',
        responseId: 'r-1',
        provider: 'codex',
        modelId: 'gpt-5.4',
        sdkMode: 'openai-responses' as const,
        encryptedReasoning: [
            { encryptedContent: 'gAAAAABcipher+/=with\\n special\t"chars"', reasoningId: 'rsn_123' },
            { encryptedContent: 'second-blob' }
        ]
    };
    const decodedResponses = decodeStatefulMarkerPayload<typeof responsesMarker>(
        encodeStatefulMarkerPayload('gpt-5.4', responsesMarker)
    );
    assert.deepEqual(decodedResponses?.marker.encryptedReasoning, responsesMarker.encryptedReasoning);

    // anthropic：encryptedThinkingData 多个加密 data（按原顺序保留）
    const anthropicMarker = {
        sessionId: 's-2',
        responseId: 'r-2',
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        sdkMode: 'anthropic' as const,
        encryptedThinkingData: ['redacted\\n cipher\\t data"with"quotes', 'second-redacted-data']
    };
    const decodedAnthropic = decodeStatefulMarkerPayload<typeof anthropicMarker>(
        encodeStatefulMarkerPayload('claude-sonnet-4-5', anthropicMarker)
    );
    assert.deepEqual(decodedAnthropic?.marker.encryptedThinkingData, anthropicMarker.encryptedThinkingData);
});

const domainMarker = {
    extension: 'vicanent.gcmp',
    provider: 'slot',
    modelId: 'wire-model',
    sdkMode: 'openai',
    sessionId: 'session',
    responseId: ''
} as const;

test('领域 marker 保留旧裸 JSON、新编码、未知附加字段及独立外层模型 ID', () => {
    const marker = { ...domainMarker, futureField: { enabled: true } };
    for (const data of [
        encodeStatefulMarkerPayload('gcmp.slot:::bridge-model', marker),
        new TextEncoder().encode(`gcmp.slot:::bridge-model\\${JSON.stringify(marker)}`)
    ]) {
        assert.deepEqual(decodeGCMPStatefulMarkerPayload(data), {
            modelId: 'gcmp.slot:::bridge-model',
            marker
        });
    }
});

for (const [name, value] of [
    ['null', null],
    ['array', []],
    ['string', 'marker'],
    ['number', 1],
    ['boolean', true],
    ['missing fields', {}],
    ['foreign extension', { ...domainMarker, extension: 'other.extension' }]
] as const) {
    test(`领域 marker 忽略 ${name}`, () => {
        assert.equal(decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('model', value)), undefined);
    });
}

for (const field of ['provider', 'modelId', 'sdkMode', 'sessionId', 'responseId'] as const) {
    test(`领域 marker 要求 ${field} 为字符串且存在`, () => {
        for (const value of [undefined, null, 1, [], {}]) {
            if (field === 'responseId' && value === null) {
                continue;
            }
            const data = encodeStatefulMarkerPayload('model', { ...domainMarker, [field]: value });
            assert.equal(decodeGCMPStatefulMarkerPayload(data), undefined);
        }
    });
}

test('领域 marker 兼容旧 reporter 的 null responseId 并保留本地会话', () => {
    const data = encodeStatefulMarkerPayload('model', { ...domainMarker, responseId: null });
    const decoded = decodeGCMPStatefulMarkerPayload(data);
    assert.equal(decoded?.marker.responseId, '');
    assert.equal(decoded?.marker.sessionId, domainMarker.sessionId);
});

for (const sdkMode of ['openai', 'openai-responses', 'anthropic', 'gemini'] as const) {
    test(`领域 marker 保留已支持的 ${sdkMode}`, () => {
        const marker = { ...domainMarker, sdkMode };
        assert.deepEqual(decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('model', marker))?.marker, marker);
    });
}

test('领域 marker 不接受未知 SDK、空外层模型 ID 或非字符串子会话', () => {
    for (const marker of [
        { ...domainMarker, sdkMode: 'future-sdk' },
        { ...domainMarker, subSessionId: 1 },
        { ...domainMarker, subSessionId: null }
    ]) {
        assert.equal(decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('model', marker)), undefined);
    }
    assert.equal(decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('', domainMarker)), undefined);
});

for (const scope of ['chain', 'subagent'] as const) {
    test(`领域 marker 接受 v1 ${scope} 连续性及现有 AgentRole`, () => {
        for (const agentRole of ['main', 'subagent', 'undetermined', 'not-applicable'] satisfies AgentRole[]) {
            const marker: StatefulMarkerContainer = {
                ...domainMarker,
                continuity: { version: 1, scope, agentRole }
            };
            assert.deepEqual(
                decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('model', marker))?.marker,
                marker
            );
        }
    });
}

test('领域 marker 忽略损坏或未来连续性，不要求旧 marker 补 continuity', () => {
    for (const continuity of [
        null,
        [],
        'chain',
        {},
        { version: 2, scope: 'chain', agentRole: 'main' },
        { version: '1', scope: 'chain', agentRole: 'main' },
        { version: 1, scope: 'parent', agentRole: 'main' },
        { version: 1, scope: 'chain', agentRole: 'future-role' },
        { version: 1, scope: 'chain' }
    ]) {
        const data = encodeStatefulMarkerPayload('model', { ...domainMarker, continuity });
        assert.equal(decodeGCMPStatefulMarkerPayload(data), undefined);
    }
    assert.ok(decodeGCMPStatefulMarkerPayload(encodeStatefulMarkerPayload('model', domainMarker)));
});

test('领域校验允许多 MiB thinking、加密内容及 Gemini history 原样往返', () => {
    const marker = {
        ...domainMarker,
        sdkMode: 'gemini',
        completeThinking: '思考\\\n'.repeat(300_000),
        encryptedReasoning: [{ encryptedContent: 'cipher'.repeat(100_000), reasoningId: 'reasoning' }],
        geminiContents: Array.from({ length: 32 }, () => ({
            role: 'model',
            parts: [{ text: 'history'.repeat(32_768), thoughtSignature: 'signature' }]
        }))
    };
    const encoded = encodeStatefulMarkerPayload('model', marker);
    assert.ok(encoded.byteLength > 8 * 1024 * 1024);
    assert.deepEqual(decodeGCMPStatefulMarkerPayload(encoded)?.marker, marker);
});

test('领域解码在解析前拒绝超过 64 MiB 的载荷', () => {
    const data = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x20);
    data.set(new TextEncoder().encode(`model\\${JSON.stringify(domainMarker)}`));
    assert.equal(decodeGCMPStatefulMarkerPayload(data), undefined);
});

test('领域解码安全忽略错误输入和损坏 payload，不抛异常', () => {
    const proxy = Proxy.revocable(new Uint8Array(), {});
    proxy.revoke();
    for (const input of [
        undefined,
        null,
        {},
        'model\\{}',
        proxy.proxy,
        new TextEncoder().encode('missing separator'),
        new TextEncoder().encode('model\\{'),
        new TextEncoder().encode('model\\json:not-json')
    ]) {
        assert.equal(decodeGCMPStatefulMarkerPayload(input as Uint8Array), undefined);
    }
});

test('marker 诊断仅返回白名单与 payload 哈希，不暴露消息、签名或凭据', () => {
    const marker = {
        ...domainMarker,
        completeThinking: 'private-prompt-sentinel',
        completeSignature: 'private-signature-sentinel',
        encryptedReasoning: [{ encryptedContent: 'private-cipher-sentinel' }],
        futureCredential: 'private-key-sentinel'
    };
    const data = encodeStatefulMarkerPayload('gcmp.slot:::model', marker);
    const before = data.slice();
    const payload = data.subarray(data.indexOf(0x5c) + 1);
    const diagnostic = describeStatefulMarkerPayload(data, 'gcmp.slot:::model');
    assert.deepEqual(diagnostic, {
        byteLength: data.byteLength,
        decodeStatus: 'valid',
        payloadHash: createHash('sha256').update(payload).digest('hex'),
        outerModelMatches: true,
        sessionHash: createHash('sha256').update(domainMarker.sessionId).digest('hex')
    });
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-|completeThinking|completeSignature|encrypted|Credential/);
    assert.deepEqual(data, before);
    const otherModel = describeStatefulMarkerPayload(
        encodeStatefulMarkerPayload('other-model', marker),
        'gcmp.slot:::model'
    );
    assert.equal(otherModel.payloadHash, diagnostic.payloadHash);
    assert.equal(otherModel.outerModelMatches, false);
});

test('marker 诊断区分无分隔符、损坏与非 GCMP 载荷，不放宽生产解码', () => {
    for (const data of [
        new TextEncoder().encode('missing-separator'),
        new TextEncoder().encode('model\\json:not-json'),
        encodeStatefulMarkerPayload('model', { ...domainMarker, extension: 'other.extension' })
    ]) {
        const diagnostic = describeStatefulMarkerPayload(data, 'model');
        assert.equal(diagnostic.decodeStatus, 'invalid');
        assert.equal(diagnostic.sessionHash, undefined);
        assert.equal(decodeGCMPStatefulMarkerPayload(data), undefined);
    }
});

test('marker 诊断对大载荷只记录大小，不重复解析或计算哈希', () => {
    const data = new Uint8Array(1024 * 1024 + 1).fill(0x20);
    assert.deepEqual(describeStatefulMarkerPayload(data, 'model'), {
        byteLength: data.byteLength,
        decodeStatus: 'not-inspected'
    });
});

test('marker 诊断错误输入与 revoked Proxy 不抛异常', () => {
    const revoked = Proxy.revocable(new Uint8Array(), {});
    revoked.revoke();
    for (const data of [undefined, null, {}, revoked.proxy]) {
        assert.deepEqual(describeStatefulMarkerPayload(data as Uint8Array, 'model'), { decodeStatus: 'invalid' });
    }
});

class MockDataPart {
    constructor(
        public data: Uint8Array,
        public mimeType = 'stateful_marker'
    ) {}
}

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
let markerModulePromise: Promise<typeof import('./statefulMarker')> | undefined;

function getMarkerModule(): Promise<typeof import('./statefulMarker')> {
    if (!markerModulePromise) {
        const originalRequire = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    LanguageModelChatMessageRole: { System: 0, User: 1, Assistant: 2 },
                    LanguageModelDataPart: MockDataPart
                };
            }
            return originalRequire.call(this, id);
        };
        markerModulePromise = import('./statefulMarker').finally(() => {
            NodeModule.prototype.require = originalRequire;
        });
    }
    return markerModulePromise;
}

test('公开 marker 解码使用领域校验，编码忠实保留外层模型 ID', async () => {
    const { encodeStatefulMarker, decodeStatefulMarker } = await getMarkerModule();
    const data = encodeStatefulMarker('gcmp.slot:::bridge-model', domainMarker);
    assert.deepEqual(decodeStatefulMarker(data), { modelId: 'gcmp.slot:::bridge-model', marker: domainMarker });
    assert.equal(decodeStatefulMarker(encodeStatefulMarkerPayload('model', null)), undefined);
});

test('扫描支持 System 前 Assistant bridge、同消息多个 part 最新优先且不修改原数据', async () => {
    const { getAllStatefulMarkersAndIndicies } = await getMarkerModule();
    const part = (responseId: string) =>
        new MockDataPart(encodeStatefulMarkerPayload('bridge-model', { ...domainMarker, responseId }));
    const messages = [
        { role: 2, content: [part('bridge')] },
        { role: 0, content: [part('not-system')] },
        { role: 1, content: [part('not-user')] },
        {
            role: 2,
            content: [
                part('older'),
                new MockDataPart(encodeStatefulMarkerPayload('model', null)),
                part('newest'),
                new MockDataPart(encodeStatefulMarkerPayload('model', domainMarker), 'other_mime')
            ]
        }
    ];
    const snapshot = structuredClone(messages);
    messages.forEach(message => {
        message.content.forEach(Object.freeze);
        Object.freeze(message.content);
        Object.freeze(message);
    });
    Object.freeze(messages);
    const results = [...getAllStatefulMarkersAndIndicies(messages as unknown as vscode.LanguageModelChatMessage[])];
    assert.deepEqual(
        results.map(({ statefulMarker, index }) => [statefulMarker.marker.responseId, index]),
        [
            ['newest', 3],
            ['older', 3],
            ['bridge', 0]
        ]
    );
    assert.deepEqual(structuredClone(messages), snapshot);
});

test('输入诊断识别前置 bridge、损坏 marker、错误角色与非原生 DataPart，不修改消息', async () => {
    const { getStatefulMarkerDiagnostics } = await getMarkerModule();
    const valid = encodeStatefulMarkerPayload('model', domainMarker);
    const messages = [
        { role: 2, content: [new MockDataPart(valid)] },
        { role: 0, content: [new MockDataPart(valid)] },
        { role: 1, content: [{ mimeType: 'stateful_marker', data: valid }] },
        { role: 2, content: [new MockDataPart(new TextEncoder().encode('model\\{'))] },
        { role: 1, content: [{ value: 'private-user-sentinel' }, new MockDataPart(valid, 'image/png')] }
    ];
    const before = structuredClone(messages);
    const diagnostic = getStatefulMarkerDiagnostics(messages as unknown as vscode.LanguageModelChatMessage[], 'model');
    assert.equal(diagnostic.dataPartCount, 5);
    assert.equal(diagnostic.otherDataPartCount, 1);
    assert.equal(diagnostic.markerCount, 4);
    assert.equal(diagnostic.assistantMarkerCount, 2);
    assert.equal(diagnostic.validMarkerCount, 3);
    assert.equal(diagnostic.scanTruncated, false);
    assert.equal(diagnostic.scanFailed, false);
    assert.deepEqual(
        diagnostic.markers.map(marker => [marker.messageIndex, marker.role, marker.nativeDataPart]),
        [
            [3, 'assistant', true],
            [2, 'user', false],
            [1, 'system', true],
            [0, 'assistant', true]
        ]
    );
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-user-sentinel|futureCredential|completeThinking/);
    assert.deepEqual(structuredClone(messages), before);
});

test('输入诊断限制 marker 数量和扫描长度，超限明确标记', async () => {
    const { getStatefulMarkerDiagnostics } = await getMarkerModule();
    const data = encodeStatefulMarkerPayload('model', domainMarker);
    const manyMarkers = [{ role: 2, content: Array.from({ length: 17 }, () => new MockDataPart(data)) }];
    const diagnostic = getStatefulMarkerDiagnostics(
        manyMarkers as unknown as vscode.LanguageModelChatMessage[],
        'model'
    );
    assert.equal(diagnostic.markerCount, 16);
    assert.equal(diagnostic.scanTruncated, true);
    const manyMessages = Array.from({ length: 4097 }, () => ({ role: 1, content: [] }));
    assert.equal(
        getStatefulMarkerDiagnostics(manyMessages as unknown as vscode.LanguageModelChatMessage[], 'model')
            .scanTruncated,
        true
    );
    const manyParts = [{ role: 1, content: Array.from({ length: 16385 }, () => ({ value: '' })) }];
    assert.equal(
        getStatefulMarkerDiagnostics(manyParts as unknown as vscode.LanguageModelChatMessage[], 'model').scanTruncated,
        true
    );
});
