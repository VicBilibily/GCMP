import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type * as vscode from 'vscode';
import type { StatefulMarkerContainer } from './statefulMarker';
import { decodeGCMPStatefulMarkerPayload, encodeStatefulMarkerPayload } from './statefulMarkerCodec';
import { CustomDataPartMimeTypes } from '../types';

type ReplayIdentity = Parameters<typeof import('./statefulReplay').filterStatefulReplay>[1];
type ReplayModules = typeof import('./statefulReplay') & typeof import('../openai/openaiResponsesMessageConverter');
type Marker = Omit<StatefulMarkerContainer, 'extension'>;

class MockDataPart {
    constructor(
        public data: Uint8Array,
        public mimeType: string
    ) {}
}

interface MockThinkingMetadata {
    signature?: string;
    redactedData?: string;
    data?: string;
    reasoningId?: string;
    provider?: string;
    modelId?: string;
    sdkMode?: string;
    statefulCredentialId?: string;
}

class MockThinkingPart {
    constructor(
        public value: string | string[],
        public id?: string,
        public metadata?: MockThinkingMetadata
    ) {}
}

class MockTextPart {
    constructor(public value: string) {}
}

class MockToolCallPart {
    constructor(
        public callId: string,
        public name: string,
        public input: { value: string }
    ) {}
}

class MockToolResultPart {
    constructor(
        public callId: string,
        public content: MockTextPart[]
    ) {}
}

type MockInputPart = MockDataPart | MockThinkingPart | MockTextPart | MockToolCallPart | MockToolResultPart;

const roles = { System: 0, User: 1, Assistant: 2 } as const;
const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
let replayModulePromise: Promise<ReplayModules> | undefined;

function getReplayModule(): Promise<ReplayModules> {
    if (!replayModulePromise) {
        const originalRequire = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return {
                    LanguageModelChatMessageRole: roles,
                    LanguageModelDataPart: MockDataPart,
                    LanguageModelThinkingPart: MockThinkingPart,
                    LanguageModelTextPart: MockTextPart,
                    LanguageModelToolCallPart: MockToolCallPart,
                    LanguageModelToolResultPart: MockToolResultPart
                };
            }
            if (id === '../../utils/runtime/logger') {
                return { Logger: { warn() {} } };
            }
            return originalRequire.call(this, id);
        };
        replayModulePromise = Promise.all([
            import('./statefulReplay'),
            import('../openai/openaiResponsesMessageConverter')
        ])
            .then(([replay, responses]) => ({ ...replay, ...responses }))
            .finally(() => {
                NodeModule.prototype.require = originalRequire;
            });
    }
    return replayModulePromise;
}

const expected: ReplayIdentity = {
    provider: 'slot',
    modelId: 'wire-model',
    sdkMode: 'openai-responses',
    credentialId: 'credential-1',
    sessionId: 'session-1',
    subSessionId: 'sub-1'
};

const thinkingMetadata: MockThinkingMetadata = {
    provider: expected.provider,
    modelId: expected.modelId,
    sdkMode: expected.sdkMode,
    statefulCredentialId: expected.credentialId
};

const baseMarker: Marker = {
    provider: expected.provider,
    modelId: expected.modelId,
    sdkMode: 'openai-responses',
    statefulCredentialId: expected.credentialId,
    sessionId: expected.sessionId,
    subSessionId: expected.subSessionId,
    continuity: { version: 1, scope: 'subagent', agentRole: 'subagent' },
    balanceAffinity: { slot: 'slot-1', balanceKey: 'balance-1', credentialId: 'credential-1' },
    responseId: 'response-1',
    completeThinking: '保留明文思考\\路径\n下一步',
    completeSignature: 'signature-1',
    encryptedReasoning: [{ encryptedContent: 'cipher-1', reasoningId: 'rs_1' }],
    encryptedThinkingData: ['redacted-1', 'redacted-2'],
    geminiContents: [{ role: 'model', parts: [{ text: 'raw-state', thoughtSignature: 'gemini-signature' }] }],
    geminiThoughtSignatures: [{ signature: 'gemini-signature', callId: 'call-1' }],
    geminiRequestIdentity: 'gemini-identity',
    geminiToolCalls: [{ localCallId: 'call-1', upstreamCallId: 'upstream-1', name: 'tool' }],
    hasToolCalls: true,
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
};

function markerPart(overrides: Partial<Marker> = {}, envelopeModelId = 'gcmp.slot:::bridge-model'): MockDataPart {
    return new MockDataPart(
        encodeStatefulMarkerPayload(envelopeModelId, { ...baseMarker, ...overrides, extension: 'vicanent.gcmp' }),
        CustomDataPartMimeTypes.StatefulMarker
    );
}

function message(content: MockInputPart[], role: number = roles.Assistant): vscode.LanguageModelChatMessage {
    const history = { role, content, name: 'replay-test' };
    return history as unknown as vscode.LanguageModelChatMessage;
}

function thinkingParts(metadata?: MockThinkingMetadata): (MockThinkingPart | MockDataPart)[] {
    return [
        new MockThinkingPart('可见思考', undefined, metadata),
        new MockThinkingPart(['第一段', '第二段'], 'thinking-1', { ...metadata, signature: 'thinking-signature' }),
        new MockThinkingPart('', undefined, { ...metadata, redactedData: 'thinking-cipher', reasoningId: 'rs_1' }),
        new MockThinkingPart('', undefined, { ...metadata, data: 'anthropic-cipher' }),
        new MockDataPart(
            new TextEncoder().encode('{"signature":"data-signature"}'),
            CustomDataPartMimeTypes.ThinkingData
        )
    ];
}

function readMarker(part: vscode.LanguageModelChatMessage['content'][number]): StatefulMarkerContainer {
    assert.ok(part instanceof MockDataPart);
    const decoded = decodeGCMPStatefulMarkerPayload(part.data);
    assert.ok(decoded);
    return decoded.marker;
}

const strippedFields = [
    'completeSignature',
    'encryptedReasoning',
    'encryptedThinkingData',
    'geminiContents',
    'geminiThoughtSignatures',
    'geminiRequestIdentity',
    'geminiToolCalls'
] as const;

function assertStrippedMarker(marker: StatefulMarkerContainer): void {
    assert.equal(marker.responseId, '');
    for (const field of strippedFields) {
        assert.equal(marker[field], undefined, field);
        assert.ok(!Object.hasOwn(marker, field), field);
    }
}

function assertRejected(result: vscode.LanguageModelChatMessage): void {
    let markerCount = 0;
    for (const part of result.content) {
        assert.ok(!(part instanceof MockThinkingPart));
        if (!(part instanceof MockDataPart)) {
            continue;
        }
        assert.notEqual(part.mimeType, CustomDataPartMimeTypes.ThinkingData);
        if (part.mimeType !== CustomDataPartMimeTypes.StatefulMarker) {
            continue;
        }
        const marker = decodeGCMPStatefulMarkerPayload(part.data)?.marker;
        if (!marker) {
            continue;
        }
        markerCount++;
        assertStrippedMarker(marker);
    }
    assert.ok(markerCount > 0);
}

for (const sdkMode of ['openai', 'openai-responses', 'anthropic', 'gemini'] as const) {
    test(`${sdkMode} 同身份保留所有 part 与 marker 原始字节，仅返回新数组`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const part = markerPart({ sdkMode });
        const bytes = Uint8Array.from(part.data);
        const source = message([...thinkingParts(), part, new MockTextPart('answer')]);
        const messages = [source];
        const result = filterStatefulReplay(messages, { ...expected, sdkMode });
        assert.notEqual(result, messages);
        assert.equal(result[0], source);
        assert.equal(result[0].content, source.content);
        assert.deepEqual(part.data, bytes);
    });
}

for (const [field, value] of [
    ['provider', 'other-provider'],
    ['provider', 'Slot'],
    ['modelId', 'other-model'],
    ['modelId', 'wire-model '],
    ['sdkMode', 'anthropic'],
    ['sessionId', 'other-session'],
    ['subSessionId', 'other-subsession'],
    ['credentialId', 'other-credential']
] satisfies [keyof ReplayIdentity, string][]) {
    test(`${field} 严格不匹配 ${JSON.stringify(value)} 时拒绝回放`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const source = message([...thinkingParts(), markerPart()]);
        const result = filterStatefulReplay([source], { ...expected, [field]: value });
        assertRejected(result[0]);
        assert.equal(readMarker(result[0].content[0]).completeThinking, baseMarker.completeThinking);
    });
}

for (const [markerSubSessionId, expectedSubSessionId] of [
    [undefined, 'sub-1'],
    ['sub-1', undefined],
    ['', undefined],
    [undefined, '']
] as const) {
    test(`subSessionId 严格区分 ${JSON.stringify(markerSubSessionId)} 与 ${JSON.stringify(expectedSubSessionId)}`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        assertRejected(
            filterStatefulReplay([message([markerPart({ subSessionId: markerSubSessionId })])], {
                ...expected,
                subSessionId: expectedSubSessionId
            })[0]
        );
    });
}

test('双方均无 subSessionId 时允许回放', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const source = message([markerPart({ subSessionId: undefined }), ...thinkingParts()]);
    assert.equal(filterStatefulReplay([source], { ...expected, subSessionId: undefined })[0], source);
});

for (const [evidence, overrides] of [
    ['statefulCredentialId', { balanceAffinity: undefined }],
    ['balanceAffinity', { statefulCredentialId: undefined }],
    ['both', {}]
] satisfies [string, Partial<Marker>][]) {
    test(`匹配的凭据证据 ${evidence} 允许 continuity 回放`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const source = message([markerPart(overrides), ...thinkingParts()]);
        assert.equal(filterStatefulReplay([source], expected)[0], source);
    });
}

for (const overrides of [
    { statefulCredentialId: 'other-credential' },
    { balanceAffinity: { slot: 'slot-1', balanceKey: 'balance-1', credentialId: 'other-credential' } }
] satisfies Partial<Marker>[]) {
    test(`两种凭据证据任一冲突均拒绝 ${JSON.stringify(overrides)}`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        assertRejected(filterStatefulReplay([message([markerPart(overrides), ...thinkingParts()])], expected)[0]);
    });
}

for (const credentialId of [undefined, ''] as const) {
    test(`当前请求凭据 ${JSON.stringify(credentialId)} 不匹配已知凭据时拒绝`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        assertRejected(
            filterStatefulReplay([message([markerPart(), ...thinkingParts()])], { ...expected, credentialId })[0]
        );
    });
}

for (const continuity of [
    { version: 1, scope: 'chain', agentRole: 'main' },
    { version: 1, scope: 'subagent', agentRole: 'subagent' }
] satisfies NonNullable<Marker['continuity']>[]) {
    for (const credentialId of ['credential-1', undefined]) {
        test(`${continuity.scope} continuity 无凭据证据时安全拒绝，expected=${credentialId}`, async () => {
            const { filterStatefulReplay } = await getReplayModule();
            const source = message([
                markerPart({ continuity, statefulCredentialId: undefined, balanceAffinity: undefined }),
                ...thinkingParts()
            ]);
            assertRejected(filterStatefulReplay([source], { ...expected, credentialId })[0]);
        });
    }
}

for (const credentialId of ['credential-1', undefined]) {
    test(`无 continuity/凭据的 legacy marker 兼容，expected=${credentialId}`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const source = message([
            markerPart({ continuity: undefined, statefulCredentialId: undefined, balanceAffinity: undefined }),
            ...thinkingParts()
        ]);
        assert.equal(filterStatefulReplay([source], { ...expected, credentialId })[0], source);
    });
}

for (const overrides of [
    { statefulCredentialId: 'other-credential', balanceAffinity: undefined },
    {
        statefulCredentialId: undefined,
        balanceAffinity: { slot: 'slot-1', balanceKey: 'balance-1', credentialId: 'other-credential' }
    }
] satisfies Partial<Marker>[]) {
    test(`无 continuity 但有凭据证据时仍严格检查 ${JSON.stringify(overrides)}`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        assertRejected(
            filterStatefulReplay([message([markerPart({ ...overrides, continuity: undefined })])], expected)[0]
        );
    });
}

test('legacy 裸 JSON marker 同样兼容且允许时不重新编码', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const legacy = {
        ...baseMarker,
        extension: 'vicanent.gcmp',
        continuity: undefined,
        statefulCredentialId: undefined,
        balanceAffinity: undefined
    };
    const part = new MockDataPart(
        new TextEncoder().encode(`bridge-model\\${JSON.stringify(legacy)}`),
        CustomDataPartMimeTypes.StatefulMarker
    );
    const source = message([part, ...thinkingParts()]);
    assert.equal(filterStatefulReplay([source], expected)[0], source);
});

test('最新有效 marker 匹配时，不采用更早 marker 的身份', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const older = markerPart({ provider: 'old-provider' });
    const latest = markerPart();
    const thinking = thinkingParts();
    const source = message([older, ...thinking, latest]);
    const result = filterStatefulReplay([source], expected)[0];
    assertStrippedMarker(readMarker(result.content[0]));
    assert.deepEqual(result.content.slice(1), [...thinking, latest]);
    assert.equal(result.content.at(-1), latest);
    assert.equal(readMarker(older).responseId, baseMarker.responseId);
});

for (const sdkMode of ['openai', 'openai-responses', 'anthropic', 'gemini'] as const) {
    for (const credentialId of ['credential-A', 'credential-B']) {
        test(`${sdkMode} 最新凭据 B 对比 ${credentialId}，所有早期有效 marker 均无协议状态`, async () => {
            const { filterStatefulReplay } = await getReplayModule();
            const olderA = markerPart({
                sdkMode,
                statefulCredentialId: 'credential-A',
                balanceAffinity: { slot: 'slot-A', balanceKey: 'balance-A', credentialId: 'credential-A' },
                sessionId: 'session-A',
                responseId: 'response-A',
                usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
            });
            const olderB = markerPart({
                sdkMode,
                statefulCredentialId: 'credential-B',
                balanceAffinity: { slot: 'slot-B', balanceKey: 'balance-B', credentialId: 'credential-B' },
                responseId: 'older-response-B'
            });
            const latest = markerPart({
                sdkMode,
                statefulCredentialId: 'credential-B',
                balanceAffinity: { slot: 'slot-B', balanceKey: 'balance-B', credentialId: 'credential-B' },
                responseId: 'latest-response-B'
            });
            const thinking = thinkingParts();
            const text = new MockTextPart('answer');
            const source = message([olderA, olderB, ...thinking, latest, text]);
            const snapshot = structuredClone(source);
            const result = filterStatefulReplay([source], { ...expected, sdkMode, credentialId })[0];
            assertStrippedMarker(readMarker(result.content[0]));
            assertStrippedMarker(readMarker(result.content[1]));
            for (const [index, original] of [olderA, olderB].entries()) {
                const cleaned = { ...readMarker(original), responseId: '' };
                for (const field of strippedFields) {
                    delete cleaned[field];
                }
                assert.deepEqual(readMarker(result.content[index]), cleaned);
            }
            if (credentialId === 'credential-B') {
                assert.deepEqual(result.content.slice(2), [...thinking, latest, text]);
                assert.equal(result.content.at(-2), latest);
            } else {
                assertRejected(result);
                assert.equal(result.content.length, 4);
            }
            assert.equal(result.content.at(-1), text);
            assert.deepEqual(structuredClone(source), snapshot);
        });
    }
}

test('同一 marker part 重复出现时仅最后位置保留协议状态', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const part = markerPart();
    const source = message([part, part]);
    const result = filterStatefulReplay([source], expected)[0];
    assertStrippedMarker(readMarker(result.content[0]));
    assert.equal(result.content[1], part);
    assert.equal(readMarker(part).responseId, baseMarker.responseId);
});

for (const credentialId of ['credential-A', 'credential-B']) {
    for (const withThinking of [false, true]) {
        test(`Responses 请求不回放旧凭据 A 密文，当前凭据=${credentialId}，ThinkingPart=${withThinking}`, async () => {
            const { filterStatefulReplay, OpenAIResponsesMessageConverter } = await getReplayModule();
            const older = markerPart({
                statefulCredentialId: 'credential-A',
                balanceAffinity: { slot: 'slot-A', balanceKey: 'balance-A', credentialId: 'credential-A' },
                encryptedReasoning: [{ encryptedContent: 'cipher-A', reasoningId: 'rs_A' }]
            });
            const latest = markerPart({
                statefulCredentialId: 'credential-B',
                balanceAffinity: { slot: 'slot-B', balanceKey: 'balance-B', credentialId: 'credential-B' },
                encryptedReasoning: [{ encryptedContent: 'cipher-B', reasoningId: 'rs_B' }]
            });
            const source = message([
                older,
                ...(withThinking ?
                    [new MockThinkingPart('', undefined, { redactedData: 'cipher-B', reasoningId: 'rs_B' })]
                :   []),
                latest,
                new MockTextPart('answer')
            ]);
            const filtered = filterStatefulReplay([source], { ...expected, credentialId });
            const handler = {
                isImageMimeType: () => false,
                createDataUrl: () => ''
            } as unknown as ConstructorParameters<typeof OpenAIResponsesMessageConverter>[0];
            const converter = new OpenAIResponsesMessageConverter(handler, 'Replay Test');
            const converted = converter.convertMessagesToOpenAIResponses(filtered, undefined, expected);
            assert.deepEqual(
                converted.messages.filter(item => 'encrypted_content' in item),
                credentialId === 'credential-B' ?
                    [{ type: 'reasoning', summary: [], encrypted_content: 'cipher-B', id: 'rs_B' }]
                :   []
            );
            assert.deepEqual(converted.messages.at(-1), {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'answer' }]
            });
        });
    }
}

test('最新有效 marker 不匹配时，清理同消息所有有效 marker 防止旧状态回漏', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const source = message([
        markerPart({ responseId: 'older-response' }),
        ...thinkingParts(),
        markerPart({ provider: 'other-provider', responseId: 'newer-response' })
    ]);
    const result = filterStatefulReplay([source], expected);
    assertRejected(result[0]);
    assert.equal(result[0].content.length, 2);
    assert.equal(readMarker(result[0].content[0]).provider, expected.provider);
    assert.equal(readMarker(result[0].content[1]).provider, 'other-provider');
});

test('尾部损坏和非 GCMP marker 不覆盖最后有效 marker', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const invalid = new MockDataPart(
        new TextEncoder().encode('model\\json:broken'),
        CustomDataPartMimeTypes.StatefulMarker
    );
    const foreign = new MockDataPart(
        encodeStatefulMarkerPayload('model', { ...baseMarker, extension: 'other.extension' }),
        CustomDataPartMimeTypes.StatefulMarker
    );
    for (const provider of [expected.provider, 'other-provider']) {
        const source = message([markerPart({ provider }), ...thinkingParts(), invalid, foreign]);
        const result = filterStatefulReplay([source], expected)[0];
        if (provider === expected.provider) {
            assert.equal(result, source);
        } else {
            assertRejected(result);
            assert.equal(result.content[1], invalid);
            assert.equal(result.content[2], foreign);
        }
    }
});

test('每条 Assistant 独立决策，不使用全局最新消息身份', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const matching = message([markerPart(), ...thinkingParts()]);
    const rejected = message([markerPart({ sessionId: 'other-session' }), ...thinkingParts()]);
    const matchingAgain = message([markerPart(), ...thinkingParts()]);
    const result = filterStatefulReplay([matching, rejected, matchingAgain], expected);
    assert.equal(result.length, 3);
    assert.equal(result[0], matching);
    assertRejected(result[1]);
    assert.equal(result[2], matchingAgain);
});

test('拒绝时只清回放状态，保留本地统计、明文、身份、未知字段与所有其他 part 顺序', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const text = new MockTextPart('answer');
    const call = new MockToolCallPart('call-1', 'tool', { value: 'input' });
    const toolResult = new MockToolResultPart('call-1', [new MockTextPart('result')]);
    const image = new MockDataPart(Uint8Array.of(1, 2, 3), 'image/png');
    const usage = new MockDataPart(new TextEncoder().encode('{"total_tokens":15}'), CustomDataPartMimeTypes.Usage);
    const cache = new MockDataPart(Uint8Array.of(4), CustomDataPartMimeTypes.CacheControl);
    const context = new MockDataPart(Uint8Array.of(5), CustomDataPartMimeTypes.ContextManagement);
    const localMarker = { ...baseMarker, extension: 'vicanent.gcmp', futureField: { local: true } };
    const originalMarker = new MockDataPart(
        encodeStatefulMarkerPayload('independent-envelope-model', localMarker),
        CustomDataPartMimeTypes.StatefulMarker
    );
    const source = message([text, ...thinkingParts(), call, originalMarker, toolResult, image, usage, cache, context]);
    const result = filterStatefulReplay([source], { ...expected, credentialId: 'other-credential' })[0];
    assertRejected(result);
    assert.deepEqual(result.content, [text, call, result.content[2], toolResult, image, usage, cache, context]);
    for (const [index, part] of [
        [0, text],
        [1, call],
        [3, toolResult],
        [4, image],
        [5, usage],
        [6, cache],
        [7, context]
    ] as const) {
        assert.equal(result.content[index], part);
    }
    assert.equal(result.role, source.role);
    assert.equal(result.name, source.name);
    const cleaned = { ...localMarker, responseId: '' };
    for (const field of strippedFields) {
        delete cleaned[field];
    }
    const rewritten = result.content[2];
    assert.ok(rewritten instanceof MockDataPart);
    assert.notEqual(rewritten, originalMarker);
    assert.deepEqual(decodeGCMPStatefulMarkerPayload(rewritten.data), {
        modelId: 'independent-envelope-model',
        marker: cleaned
    });
});

test('判断内层实际 modelId 而不是独立外层展示模型 ID', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const source = message([markerPart({ modelId: 'other-model' }, expected.modelId), ...thinkingParts()]);
    assertRejected(filterStatefulReplay([source], expected)[0]);
});

test('无有效 marker 时保留现有行为，损坏载荷不阻断请求', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const revoked = Proxy.revocable(new Uint8Array(), {});
    revoked.revoke();
    const invalidParts = [
        new MockDataPart(new TextEncoder().encode('no separator'), CustomDataPartMimeTypes.StatefulMarker),
        new MockDataPart(new TextEncoder().encode('model\\{'), CustomDataPartMimeTypes.StatefulMarker),
        new MockDataPart(encodeStatefulMarkerPayload('model', null), CustomDataPartMimeTypes.StatefulMarker),
        new MockDataPart(
            encodeStatefulMarkerPayload('model', { ...baseMarker, extension: 'other.extension' }),
            CustomDataPartMimeTypes.StatefulMarker
        ),
        new MockDataPart(revoked.proxy, CustomDataPartMimeTypes.StatefulMarker),
        new MockDataPart(markerPart().data, 'application/octet-stream')
    ];
    for (const content of [thinkingParts(), [...invalidParts, ...thinkingParts()]]) {
        const source = message(content);
        assert.equal(filterStatefulReplay([source], { ...expected, provider: 'other-provider' })[0], source);
    }
});

for (const role of [roles.System, roles.User]) {
    test(`非 Assistant role=${role} 不过滤 marker 或 thinking`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const source = message([markerPart({ provider: 'other-provider' }), ...thinkingParts()], role);
        assert.equal(filterStatefulReplay([source], expected)[0], source);
    });
}

test('拒绝只修改本地副本，冻结输入与原 marker 字节保持，后续 attempt 仍可同身份回放', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const originalMarker = markerPart();
    const bytes = Uint8Array.from(originalMarker.data);
    const source = message([originalMarker, ...thinkingParts(), new MockTextPart('answer')]);
    const messages = [source];
    const snapshot = structuredClone(messages);
    source.content.forEach(Object.freeze);
    Object.freeze(source.content);
    Object.freeze(source);
    Object.freeze(messages);
    const expectedSnapshot = { ...expected, credentialId: 'other-credential' };
    Object.freeze(expectedSnapshot);
    const rejected = filterStatefulReplay(messages, expectedSnapshot);
    assertRejected(rejected[0]);
    assert.notEqual(rejected, messages);
    assert.notEqual(rejected[0], source);
    assert.notEqual(rejected[0].content, source.content);
    assert.deepEqual(structuredClone(messages), snapshot);
    assert.deepEqual(originalMarker.data, bytes);
    assert.equal(filterStatefulReplay(messages, expected)[0], source);
    assert.deepEqual(originalMarker.data, bytes);
});

for (const [label, overrides] of [
    ['同身份', {}],
    ['异凭据', { credentialId: 'credential-B' }],
    ['异提供商', { provider: 'other-provider' }],
    ['异模型', { modelId: 'other-model' }],
    ['异协议', { sdkMode: 'anthropic' }],
    ['异会话', { sessionId: 'other-session' }],
    ['异子会话', { subSessionId: 'other-subsession' }]
] satisfies [string, Partial<ReplayIdentity>][]) {
    test(`bridge [marker, System, User, Assistant] ${label}，只在不兼容时剥离后续思考`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const identity = { ...expected, ...overrides };
        const leading = message([markerPart()]);
        const system = message([new MockTextPart('system')], roles.System);
        const user = message([new MockTextPart('question')], roles.User);
        const text = new MockTextPart('answer');
        const call = new MockToolCallPart('call-1', 'tool', { value: 'input' });
        const toolResult = new MockToolResultPart('call-1', [new MockTextPart('result')]);
        const usage = new MockDataPart(new TextEncoder().encode('{"total_tokens":15}'), CustomDataPartMimeTypes.Usage);
        const currentThinking = new MockThinkingPart('当前身份思考', undefined, {
            provider: identity.provider,
            modelId: identity.modelId,
            sdkMode: identity.sdkMode,
            statefulCredentialId: identity.credentialId
        });
        const source = message([...thinkingParts(), currentThinking, text, call, toolResult, usage]);
        const messages = [leading, system, user, source];
        const snapshot = structuredClone(messages);
        messages.forEach(item => {
            item.content.forEach(Object.freeze);
            Object.freeze(item.content);
            Object.freeze(item);
        });
        Object.freeze(messages);
        const result = filterStatefulReplay(messages, identity);
        assert.equal(result[1], system);
        assert.equal(result[2], user);
        if (label === '同身份') {
            result.forEach((item, index) => assert.equal(item, messages[index]));
        } else {
            assertRejected(result[0]);
            assert.deepEqual(result[3].content, [text, call, toolResult, usage]);
            assert.deepEqual(readMarker(result[0].content[0]).usage, baseMarker.usage);
        }
        assert.deepEqual(structuredClone(messages), snapshot);
    });
}

for (const context of ['none', 'own', 'leading'] as const) {
    for (const [field, value] of [
        ['provider', 'other-provider'],
        ['provider', 'Slot'],
        ['provider', undefined],
        ['modelId', 'other-model'],
        ['modelId', 'wire-model '],
        ['modelId', undefined],
        ['sdkMode', 'anthropic'],
        ['sdkMode', undefined],
        ['statefulCredentialId', 'credential-A'],
        ['statefulCredentialId', ''],
        ['statefulCredentialId', undefined]
    ] satisfies [keyof MockThinkingMetadata, string | undefined][]) {
        test(`${context} marker 下 ThinkingPart metadata 独立严格拒绝 ${field}=${JSON.stringify(value)}`, async () => {
            const { filterStatefulReplay } = await getReplayModule();
            const parts = thinkingParts({ ...thinkingMetadata, [field]: value });
            const matching = new MockThinkingPart('同身份', undefined, thinkingMetadata);
            const legacy = new MockThinkingPart('无凭据 metadata', undefined, {
                signature: 'legacy-signature',
                provider: 'other-provider',
                modelId: 'other-model',
                sdkMode: 'anthropic'
            });
            const text = new MockTextPart('answer');
            const ownMarker = context === 'own' ? [markerPart()] : [];
            const source = message([...ownMarker, ...parts, matching, legacy, text]);
            const messages = context === 'leading' ? [message([markerPart()]), source] : [source];
            const snapshot = structuredClone(messages);
            const result = filterStatefulReplay(messages, expected);
            assert.deepEqual(result.at(-1)?.content, [
                ...ownMarker,
                ...parts.filter(part => part instanceof MockDataPart),
                matching,
                legacy,
                text
            ]);
            assert.deepEqual(structuredClone(messages), snapshot);
        });
    }

    test(`${context} marker 下同身份 metadata 与输入对象原样保留`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const source = message([
            ...(context === 'own' ? [markerPart()] : []),
            ...thinkingParts(Object.freeze({ ...thinkingMetadata })),
            new MockTextPart('answer')
        ]);
        const messages = context === 'leading' ? [message([markerPart()]), source] : [source];
        messages.forEach(item => {
            item.content.forEach(Object.freeze);
            Object.freeze(item.content);
            Object.freeze(item);
        });
        Object.freeze(messages);
        const result = filterStatefulReplay(messages, expected);
        assert.notEqual(result, messages);
        result.forEach((item, index) => assert.equal(item, messages[index]));
    });

    test(`${context} marker 下当前凭据 B 不回放旧 Thinking metadata A，转换请求不携带 metadata`, async () => {
        const { filterStatefulReplay, OpenAIResponsesMessageConverter } = await getReplayModule();
        const identity = { ...expected, credentialId: 'credential-B' };
        const currentMarker = markerPart({
            statefulCredentialId: identity.credentialId,
            balanceAffinity: undefined,
            encryptedReasoning: undefined,
            completeThinking: undefined
        });
        const oldThinking = new MockThinkingPart('', undefined, {
            ...thinkingMetadata,
            statefulCredentialId: 'credential-A',
            redactedData: 'cipher-A',
            reasoningId: 'rs_A'
        });
        const currentThinking = new MockThinkingPart('', undefined, {
            ...thinkingMetadata,
            statefulCredentialId: identity.credentialId,
            redactedData: 'cipher-B',
            reasoningId: 'rs_B'
        });
        const text = new MockTextPart('answer');
        const ownMarker = context === 'own' ? [currentMarker] : [];
        const source = message([...ownMarker, oldThinking, currentThinking, text]);
        const messages = [
            ...(context === 'leading' ? [message([currentMarker])] : []),
            message([new MockTextPart('system')], roles.System),
            message([new MockTextPart('question')], roles.User),
            source
        ];
        const snapshot = structuredClone(messages);
        const filtered = filterStatefulReplay(messages, identity);
        assert.deepEqual(filtered.at(-1)?.content, [...ownMarker, currentThinking, text]);
        const handler = {
            isImageMimeType: () => false,
            createDataUrl: () => ''
        } as unknown as ConstructorParameters<typeof OpenAIResponsesMessageConverter>[0];
        const converter = new OpenAIResponsesMessageConverter(handler, 'Replay Test');
        const converted = converter.convertMessagesToOpenAIResponses(filtered, undefined, identity);
        assert.deepEqual(converted, {
            systemMessage: 'system',
            messages: [
                {
                    type: 'message',
                    role: 'user',
                    status: 'completed',
                    content: [{ type: 'input_text', text: 'question' }]
                },
                { type: 'reasoning', summary: [], encrypted_content: 'cipher-B', id: 'rs_B' },
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'answer' }]
                }
            ]
        });
        assert.ok(!JSON.stringify(converted).includes('credential-'));
        assert.deepEqual(structuredClone(messages), snapshot);
    });
}

for (const leadingMatches of [false, true]) {
    test(`leading marker 匹配=${leadingMatches} 时，自身有效 marker 仍独立判断且不替换 leading 上下文`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const leading = message([markerPart({ provider: leadingMatches ? expected.provider : 'other-provider' })]);
        const matching = message([markerPart(), ...thinkingParts()]);
        const rejected = message([markerPart({ provider: 'other-provider' }), ...thinkingParts()]);
        const text = new MockTextPart('answer');
        const invalid = new MockDataPart(new TextEncoder().encode('broken'), CustomDataPartMimeTypes.StatefulMarker);
        const foreign = new MockDataPart(
            encodeStatefulMarkerPayload('model', { ...baseMarker, extension: 'other.extension' }),
            CustomDataPartMimeTypes.StatefulMarker
        );
        const markerless = message([...thinkingParts(), invalid, foreign, text]);
        const result = filterStatefulReplay([leading, matching, rejected, markerless], expected);
        assert.equal(result[1], matching);
        assertRejected(result[2]);
        if (leadingMatches) {
            assert.equal(result[0], leading);
            assert.equal(result[3], markerless);
        } else {
            assertRejected(result[0]);
            assert.deepEqual(result[3].content, [invalid, foreign, text]);
        }
    });
}

test('只有首条 marker-only Assistant 建立 bridge 上下文，不根据 marker 推断角色', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const incompatible = markerPart({ provider: 'other-provider' });
    const text = new MockTextPart('answer');
    const invalid = new MockDataPart(new TextEncoder().encode('broken'), CustomDataPartMimeTypes.StatefulMarker);
    const foreign = new MockDataPart(
        encodeStatefulMarkerPayload('model', { ...baseMarker, extension: 'other.extension' }),
        CustomDataPartMimeTypes.StatefulMarker
    );
    for (const prefix of [
        [message([incompatible], roles.System)],
        [message([incompatible], roles.User)],
        [message([incompatible, text])],
        [message([incompatible, incompatible])],
        [message([text], roles.System), message([incompatible])],
        [message([invalid])],
        [message([foreign])]
    ]) {
        const source = message(thinkingParts());
        assert.equal(filterStatefulReplay([...prefix, source], expected).at(-1), source);
    }
});

for (const role of [roles.System, roles.User]) {
    test(`role=${role} 的 ThinkingPart metadata 也独立校验，不依赖 marker 推断角色`, async () => {
        const { filterStatefulReplay } = await getReplayModule();
        const marker = markerPart({ provider: 'other-provider' });
        const legacy = new MockThinkingPart('legacy');
        const matching = new MockThinkingPart('matching', undefined, thinkingMetadata);
        const rejected = new MockThinkingPart('', undefined, {
            ...thinkingMetadata,
            statefulCredentialId: 'credential-A',
            redactedData: 'cipher-A'
        });
        const text = new MockTextPart('text');
        const source = message([marker, legacy, matching, rejected, text], role);
        const result = filterStatefulReplay([source], expected)[0];
        assert.equal(result.role, role);
        assert.deepEqual(result.content, [marker, legacy, matching, text]);
        assert.equal(readMarker(marker).responseId, baseMarker.responseId);
    });
}

test('空输入返回独立空数组', async () => {
    const { filterStatefulReplay } = await getReplayModule();
    const messages: readonly vscode.LanguageModelChatMessage[] = Object.freeze([]);
    const result = filterStatefulReplay(messages, expected);
    assert.deepEqual(result, []);
    assert.notEqual(result, messages);
});
