import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import * as vscode from 'vscode';

import { CodexAppServerClient, isVersionBelow } from '../../src/cli/appServer/client';
import { CodexAppServerProcessManager } from '../../src/cli/appServer/processManager';
import { codexThreadSessionStore, CodexThreadSessionStore } from '../../src/cli/appServer/threadSessionStore';
import { CodexAppServerHandler } from '../../src/handlers/codexAppServerHandler';
import { encodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes, GCMP_SYSTEM_MESSAGE_NAME } from '../../src/handlers/types';
import { getCodexTuiCliHeader } from '../../src/utils/metadata/metadataResolver';
import { parseAppServerModelList } from '../../src/utils/model/codexModels';
import type { ModelConfig } from '../../src/types/sharedTypes';
import type { AppServerModel } from '../../src/cli/appServer/protocolTypes';

// ===== mock app-server：内存 stdio 双向流 + JSONL 行协议 =====

interface MockServer {
    client: CodexAppServerClient;
    /** 已收到的请求帧（服务端视角） */
    received: Array<{ id?: number; method?: string; params?: unknown }>;
    /** 主动向客户端写一行 JSON（通知/反向请求） */
    push(message: object): void;
    /** 触发进程退出 */
    emitExit(): void;
    /** shutdown 调用计数 */
    shutdownCalls: () => number;
}

function createMockServer(options?: {
    userAgent?: string;
    autoRespond?: (frame: { id?: number; method?: string; params?: unknown }) => object | undefined;
}): MockServer {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const received: MockServer['received'] = [];
    const exitHandlers: Array<() => void> = [];
    let shutdowns = 0;

    const fakeProc = { stdin, stdout, stderr: new PassThrough() };
    const manager = Object.create(CodexAppServerProcessManager.prototype) as CodexAppServerProcessManager;
    (manager as unknown as { ensureRunning(): unknown }).ensureRunning = () => ({ proc: fakeProc });
    Object.defineProperty(manager, 'isRunning', { get: () => true });
    (manager as unknown as { onExit(h: () => void): void }).onExit = h => exitHandlers.push(h);
    (manager as unknown as { shutdown(): void }).shutdown = () => {
        shutdowns++;
    };

    const rl = createInterface({ input: stdin, crlfDelay: Infinity });
    rl.on('line', line => {
        const frame = JSON.parse(line);
        received.push(frame);
        const response = options?.autoRespond?.(frame);
        if (response) {
            stdout.write(JSON.stringify(response) + '\n');
        }
    });

    const client = new CodexAppServerClient(manager);

    return {
        client,
        received,
        push: message => stdout.write(JSON.stringify(message) + '\n'),
        emitExit: () => exitHandlers.forEach(h => h()),
        shutdownCalls: () => shutdowns
    };
}

/** 完成握手（默认自动响应 initialize） */
async function readyClient(server: MockServer): Promise<void> {
    const initPromise = server.client.ensureReady();
    // 等待 initialize 帧到达后响应
    await new Promise(resolve => setImmediate(resolve));
    const initFrame = server.received.find(f => f.method === 'initialize');
    assert.ok(initFrame, 'initialize frame should be sent');
    server.push({
        id: initFrame.id,
        result: {
            userAgent: 'codex-cli/0.153.4 (Windows; x86_64)',
            codexHome: 'C:\\mock',
            platformFamily: 'windows',
            platformOs: 'windows'
        }
    });
    await initPromise;
}

// ===== 套件 =====

suite('Codex App Server', () => {
    suiteTeardown(() => {
        codexThreadSessionStore.delete('test-session');
    });

    test('isVersionBelow 版本比较', () => {
        assert.equal(isVersionBelow('0.153.4', '0.153.4'), false);
        assert.equal(isVersionBelow('0.153.3', '0.153.4'), true);
        assert.equal(isVersionBelow('0.154.0', '0.153.4'), false);
        assert.equal(isVersionBelow('1.0.0', '0.153.4'), false);
        assert.equal(isVersionBelow('0.9.9', '0.153.4'), true);
    });

    test('握手 + 请求/响应 + initialized 通知', async () => {
        const server = createMockServer();
        await readyClient(server);
        assert.ok(
            server.received.some(f => f.method === 'initialized' && f.id === undefined),
            'initialized 通知'
        );
        const initFrame = server.received.find(f => f.method === 'initialize');
        const params = initFrame?.params as {
            clientInfo?: { name: string; version: string };
            capabilities?: { experimentalApi?: boolean };
        };
        assert.equal(params.capabilities?.experimentalApi, true);
        // 以 codex-tui 身份握手，不声明 gcmp
        const tuiHeader = getCodexTuiCliHeader();
        assert.equal(params.clientInfo?.name, tuiHeader.originator);
        assert.equal(params.clientInfo?.version, tuiHeader.version);

        // 普通请求往返
        const responsePromise = server.client.request('thread/start', { model: 'gpt-x' });
        await new Promise(resolve => setImmediate(resolve));
        const startFrame = server.received.find(f => f.method === 'thread/start');
        assert.deepEqual(startFrame?.params, { model: 'gpt-x' });
        server.push({ id: startFrame!.id, result: { thread: { id: 't-1' } } });
        assert.deepEqual(await responsePromise, { thread: { id: 't-1' } });
    });

    test('无参方法 params 处理：null-params 省略键，其余补 {}', async () => {
        const server = createMockServer();
        await readyClient(server);
        const before = server.received.length;

        // null-params 方法：params 键必须省略（传 {} 会被服务端静默丢弃的协议陷阱）
        const rlPromise = server.client.request('account/rateLimits/read');
        await new Promise(resolve => setImmediate(resolve));
        const rlFrame = server.received.slice(before).find(f => f.method === 'account/rateLimits/read');
        assert.ok(rlFrame, 'rateLimits frame sent');
        assert.equal(Object.prototype.hasOwnProperty.call(rlFrame, 'params'), false, 'null-params 方法省略 params 键');
        server.push({ id: rlFrame!.id, result: {} });
        await rlPromise;

        // 结构体 params 方法（如 model/list、account/read）：键必须存在，缺省补 {}
        // （服务端对缺失 params 报 missing field `params`，0.153.4 实测）
        const listPromise = server.client.request('model/list');
        await new Promise(resolve => setImmediate(resolve));
        const listFrame = server.received.slice(before).find(f => f.method === 'model/list');
        assert.ok(listFrame, 'model/list frame sent');
        assert.deepEqual(listFrame?.params, {}, '非 null-params 方法缺省时补 {}');
        server.push({ id: listFrame!.id, result: { data: [], nextCursor: null } });
        await listPromise;
    });

    test('请求超时 reject', async () => {
        const server = createMockServer();
        await readyClient(server);
        await assert.rejects(server.client.request('model/list', undefined, 30), /timed out/);
    });

    test('版本门禁：低于固定基线（0.153.4）拒绝并 shutdown', async () => {
        const server = createMockServer();
        const initPromise = server.client.ensureReady();
        await new Promise(resolve => setImmediate(resolve));
        const initFrame = server.received.find(f => f.method === 'initialize');
        server.push({
            id: initFrame!.id,
            result: { userAgent: 'codex-cli/0.100.0', codexHome: '', platformFamily: '', platformOs: '' }
        });
        await assert.rejects(initPromise, /below the required baseline 0\.153\.4/);
        assert.equal(server.shutdownCalls(), 1);
    });

    test('通知按 threadId 过滤扇出', async () => {
        const server = createMockServer();
        await readyClient(server);
        const hitsA: string[] = [];
        const hitsB: string[] = [];
        const global: string[] = [];
        server.client.onNotification(m => hitsA.push(m.method), 'thread-a');
        server.client.onNotification(m => hitsB.push(m.method), 'thread-b');
        server.client.onNotification(m => global.push(m.method));
        server.push({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'x' } } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(hitsA, ['turn/completed']);
        assert.deepEqual(hitsB, []);
        assert.deepEqual(global, ['turn/completed']);
    });

    test('服务端反向请求按 threadId 路由 + 默认兜底', async () => {
        const server = createMockServer();
        await readyClient(server);
        const routed: string[] = [];
        const fallback: string[] = [];
        const reg = server.client.registerServerRequestHandler('thread-t', msg => {
            routed.push(String(msg.method));
            server.client.respond(msg.id, { contentItems: [], success: true });
        });
        server.client.onServerRequest(msg => {
            fallback.push(String(msg.method));
            server.client.respond(msg.id, { decision: 'decline' });
        });
        server.push({ id: 900, method: 'item/tool/call', params: { threadId: 'thread-t', callId: 'c1' } });
        server.push({ id: 901, method: 'item/tool/call', params: { threadId: 'other', callId: 'c2' } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(routed, ['item/tool/call']);
        assert.deepEqual(fallback, ['item/tool/call']);
        // 响应帧写回 stdin
        const responses = server.received.filter(f => f.id === 900 || f.id === 901);
        assert.equal(responses.length, 2);
        reg.dispose();
    });

    test('进程退出清空 pending 并拒绝', async () => {
        const server = createMockServer();
        await readyClient(server);
        const pending = server.client.request('model/list');
        const assertion = assert.rejects(pending, /exited while waiting/);
        server.emitExit();
        await assertion;
    });

    test('withThreadLock 同 thread 串行', async () => {
        const server = createMockServer();
        await readyClient(server);
        const order: string[] = [];
        const first = server.client.withThreadLock('t', async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            order.push('first');
        });
        const second = server.client.withThreadLock('t', async () => {
            order.push('second');
        });
        await Promise.all([first, second]);
        assert.deepEqual(order, ['first', 'second']);
    });

    test('CodexThreadSessionStore LRU 淘汰', () => {
        const store = new CodexThreadSessionStore();
        for (let i = 0; i < 105; i++) {
            store.set({ sessionId: `s-${i}`, threadId: `t-${i}`, modelId: 'm', updatedAt: i });
        }
        // 容量 100：最早 5 条被淘汰
        assert.equal(store.get('s-0'), undefined);
        assert.equal(store.get('s-4'), undefined);
        assert.ok(store.get('s-5'));
        // 上面的 get('s-5') 触发 LRU 触碰，下一个被淘汰的是 s-6
        const evicted = store.set({ sessionId: 's-new', threadId: 't-new', modelId: 'm', updatedAt: 200 });
        assert.equal(evicted.length, 1);
        assert.equal(evicted[0].sessionId, 's-6');
    });

    test('parseAppServerModelList：hidden 过滤 / isDefault 优先 / 预置合并', () => {
        const staticModels: ModelConfig[] = [
            {
                id: 'gpt-local',
                name: 'Local Preset',
                tooltip: 'preset',
                sdkMode: 'openai-responses',
                maxInputTokens: 1000,
                maxOutputTokens: 500
            } as ModelConfig
        ];
        const remote: AppServerModel[] = [
            {
                id: 'gpt-remote-b',
                model: 'gpt-remote-b',
                displayName: 'Remote B',
                description: 'second',
                modelSpecialty: null,
                hidden: false,
                supportedReasoningEfforts: [
                    { reasoningEffort: 'low', description: '' },
                    { reasoningEffort: 'medium', description: '' }
                ],
                defaultReasoningEffort: 'low',
                inputModalities: ['text', 'image'],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false
            },
            {
                id: 'gpt-hidden',
                model: 'gpt-hidden',
                displayName: 'Hidden',
                description: '',
                modelSpecialty: null,
                hidden: true,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: 'medium',
                inputModalities: ['text'],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false
            },
            {
                id: 'gpt-local',
                model: 'gpt-local',
                displayName: 'Remote Name Should Not Override',
                description: 'preset remote',
                modelSpecialty: null,
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: 'medium',
                inputModalities: ['text'],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false
            },
            {
                id: 'gpt-remote-a',
                model: 'gpt-remote-a',
                displayName: 'Remote A',
                description: 'first (default)',
                modelSpecialty: null,
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
                defaultReasoningEffort: 'high',
                inputModalities: ['text'],
                serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
                defaultServiceTier: 'fast',
                isDefault: true
            }
        ];
        const result = parseAppServerModelList(remote, staticModels);
        // hidden 被过滤；isDefault 排最前
        assert.deepEqual(
            result.map(m => m.id),
            ['gpt-remote-a', 'gpt-remote-b', 'gpt-local']
        );
        // 本地预置保持完整配置（不被远端覆盖）
        const preset = result.find(m => m.id === 'gpt-local');
        assert.equal(preset?.name, 'Local Preset');
        // 远端独有模型自动建默认配置：reasoning 与图像能力映射
        const remoteA = result.find(m => m.id === 'gpt-remote-a');
        assert.equal(remoteA?.sdkMode, 'openai-responses');
        assert.equal(remoteA?.reasoningDefault, 'high');
        assert.deepEqual(remoteA?.reasoningEffort, ['high']);
        assert.deepEqual(remoteA?.serviceTier, ['fast']);
        const remoteB = result.find(m => m.id === 'gpt-remote-b');
        assert.equal(remoteB?.capabilities?.imageInput, true);
        assert.equal(remoteB?.reasoningDefault, 'low');
    });

    suite('CodexAppServerHandler 纯逻辑', () => {
        interface HandlerProbe {
            convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): {
                developerInstructions?: string;
                historyItems: unknown[];
                turnInput: Array<{ type: string; text?: string }>;
            };
            mapUsage(last: {
                totalTokens: number;
                inputTokens: number;
                cachedInputTokens: number;
                outputTokens: number;
                reasoningOutputTokens: number;
            }): Record<string, unknown>;
            extractCodexMarker(
                messages: readonly vscode.LanguageModelChatMessage[]
            ): { marker: { codexThreadId?: string }; index: number } | undefined;
        }
        const probe = Object.create(CodexAppServerHandler.prototype) as HandlerProbe;

        test('convertMessages：系统消息 / 历史 / 本轮输入切分', () => {
            const messages = [
                new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.User,
                    [new vscode.LanguageModelTextPart('sys prompt')],
                    GCMP_SYSTEM_MESSAGE_NAME
                ),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('first question')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    new vscode.LanguageModelTextPart('first answer')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('second question')
                ])
            ];
            const result = probe.convertMessages(messages);
            assert.equal(result.developerInstructions, 'sys prompt');
            assert.deepEqual(
                result.turnInput.map(i => i.text),
                ['second question']
            );
            // 历史 = 第一条 user + assistant（Responses ResponseItem 格式）
            assert.equal(result.historyItems.length, 2);
            const [histUser, histAssistant] = result.historyItems as Array<{
                type: string;
                role: string;
                content: Array<{ type: string; text: string }>;
            }>;
            assert.equal(histUser.role, 'user');
            assert.equal(histUser.content[0].type, 'input_text');
            assert.equal(histUser.content[0].text, 'first question');
            assert.equal(histAssistant.role, 'assistant');
            assert.equal(histAssistant.content[0].type, 'output_text');
        });

        test('convertMessages：无 user 消息时 turnInput 为空', () => {
            const result = probe.convertMessages([
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    new vscode.LanguageModelTextPart('only assistant')
                ])
            ]);
            assert.equal(result.turnInput.length, 0);
            assert.equal(result.historyItems.length, 1);
        });

        test('mapUsage：Codex TokenUsageBreakdown → OpenAI 风格', () => {
            const usage = probe.mapUsage({
                totalTokens: 14078,
                inputTokens: 10000,
                cachedInputTokens: 960,
                outputTokens: 2000,
                reasoningOutputTokens: 1118
            });
            assert.equal(usage.prompt_tokens, 10960);
            assert.equal(usage.completion_tokens, 3118);
            assert.equal(usage.total_tokens, 14078);
            assert.equal(usage.cached_tokens, 960);
        });

        test('extractCodexMarker：倒序命中最近的 codex marker', () => {
            const encodeMarker = (threadId: string, turnId: string) =>
                new vscode.LanguageModelDataPart(
                    encodeStatefulMarker('gpt-x', {
                        provider: 'codex',
                        modelId: 'gpt-x',
                        sdkMode: 'codex-app-server',
                        sessionId: 'sess-1',
                        responseId: turnId,
                        codexThreadId: threadId,
                        codexLastTurnId: turnId
                    }),
                    CustomDataPartMimeTypes.StatefulMarker
                );
            const messages = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q1')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    encodeMarker('thread-old', 'turn-1')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    encodeMarker('thread-new', 'turn-2')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q2')
                ])
            ];
            const hit = probe.extractCodexMarker(messages);
            assert.equal(hit?.marker.codexThreadId, 'thread-new');
            assert.equal(hit?.index, 2);
            // 无 marker 时 undefined
            assert.equal(
                probe.extractCodexMarker([
                    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                        new vscode.LanguageModelTextPart('q')
                    ])
                ]),
                undefined
            );
        });
    });
});
