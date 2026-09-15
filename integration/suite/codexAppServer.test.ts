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
import { RetryManager } from '../../src/utils/retry/retryManager';
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
    let running = true;
    Object.defineProperty(manager, 'isRunning', { get: () => running });
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
        emitExit: () => {
            running = false;
            exitHandlers.forEach(h => h());
        },
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
            capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: string[] };
        };
        assert.equal(params.capabilities?.experimentalApi, true);
        // 通知精简：未消费的通知 opt-out，消费中的不得 opt-out
        const optOut = params.capabilities?.optOutNotificationMethods ?? [];
        assert.ok(optOut.includes('turn/started') && optOut.includes('item/started'));
        assert.ok(!optOut.includes('turn/completed'), 'turn/completed 必须保留');
        assert.ok(!optOut.includes('item/agentMessage/delta'), 'agentMessage delta 必须保留');
        assert.ok(!optOut.includes('thread/tokenUsage/updated'), 'tokenUsage 必须保留');
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

    test('withTurnSlot：并发 active turn 上限排队等位', async () => {
        const server = createMockServer();
        await readyClient(server);
        const client = server.client;
        let running = 0;
        let maxRunning = 0;
        const releases: Array<() => void> = [];
        const occupy = () =>
            client.withTurnSlot(
                () =>
                    new Promise<void>(resolve => {
                        running++;
                        maxRunning = Math.max(maxRunning, running);
                        releases.push(() => {
                            running--;
                            resolve();
                        });
                    })
            );
        const first4 = [occupy(), occupy(), occupy(), occupy()];
        assert.equal(releases.length, 4, '前 4 个 turn 直接占槽');
        const fifth = occupy();
        // 微任务链冲刷辅助：等位唤醒需多轮 microtask drain
        const flush = async (rounds: number) => {
            for (let i = 0; i < rounds; i++) {
                await new Promise(resolve => setImmediate(resolve));
            }
        };
        await flush(3);
        assert.equal(releases.length, 4, '第 5 个 turn 排队等位');
        releases[0]();
        for (let i = 0; i < 20 && releases.length < 5; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(releases.length, 5, '释放一个槽位后第 5 个进入');
        releases.slice(1).forEach(fn => fn());
        await Promise.all([...first4, fifth]);
        assert.equal(maxRunning, 4, '并发峰值不超过上限');
    });

    test('withThreadLock：完成后清理锁条目', async () => {
        const server = createMockServer();
        await readyClient(server);
        await server.client.withThreadLock('t-cleanup', async () => {});
        const locks = (server.client as unknown as { threadLocks: Map<string, Promise<void>> }).threadLocks;
        assert.equal(locks.has('t-cleanup'), false, '锁释放后删除 threadId 条目');
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
        await assert.rejects(server.client.request('model/list'), /not running/);
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
            resolveTurnOverrides(options: unknown, modelConfig: unknown): { effort?: string; summary?: string };
            describeToolCallError(error: unknown): string;
            resolvePersistentStrategy(
                client: CodexAppServerClient,
                messages: readonly vscode.LanguageModelChatMessage[],
                markerModelId: string,
                wireModelId: string,
                sessionId: string,
                toolNames?: string[]
            ): Promise<{ resumeThreadId?: string; persistentNew: boolean; turnInput: Array<{ text?: string }> }>;
            toTurnFailureError(
                turnError: {
                    message: string;
                    codexErrorInfo: unknown;
                    additionalDetails: string | null;
                    misalignment: unknown;
                } | null,
                status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
            ): Error;
            waitTurnCompletion(
                client: CodexAppServerClient,
                threadId: string,
                turnId: string,
                reporter: {
                    reportText(delta: string): void;
                    bufferThinking(delta: string): void;
                    endThinkingChain(): void;
                    flushAll(reason: string | null): void;
                },
                token: vscode.CancellationToken
            ): Promise<{ prompt_tokens?: number } | undefined>;
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

        test('convertMessages：工具调用/结果注入为 function_call / function_call_output', () => {
            const messages = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q1')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    new vscode.LanguageModelTextPart('let me check'),
                    new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' })
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('file content')])
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    new vscode.LanguageModelTextPart('done')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q2')
                ])
            ];
            const result = probe.convertMessages(messages);
            assert.deepEqual(
                result.historyItems.map(i => (i as { type: string }).type),
                ['message', 'message', 'function_call', 'function_call_output', 'message'],
                '工具轨迹按 call_id 归属注入历史'
            );
            const call = result.historyItems[2] as { call_id: string; name: string; arguments: string };
            assert.equal(call.call_id, 'call-1');
            assert.equal(call.name, 'read_file');
            assert.deepEqual(JSON.parse(call.arguments), { path: 'a.ts' });
            const output = result.historyItems[3] as { call_id: string; output: string };
            assert.equal(output.call_id, 'call-1');
            assert.equal(output.output, 'file content');
            // 本轮输入不受历史工具结果影响
            assert.deepEqual(
                result.turnInput.map(i => i.text),
                ['q2']
            );
        });

        test('describeToolCallError：用户取消/拒绝确认与执行错误区分', () => {
            assert.equal(probe.describeToolCallError(new vscode.CancellationError()), 'cancelled or declined by user');
            assert.equal(probe.describeToolCallError(new Error('boom')), 'boom');
            assert.equal(probe.describeToolCallError('plain'), 'plain');
        });

        test('waitTurnCompletion：reasoning 完成只结束思维链，进程退出必须 reject', async () => {
            const idleToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} })
            } as vscode.CancellationToken;
            const fakeReporter = () => {
                let endChain = 0;
                let flushAll = 0;
                return {
                    endChain: () => endChain,
                    flushAll: () => flushAll,
                    reporter: {
                        reportText() {},
                        bufferThinking() {},
                        endThinkingChain() {
                            endChain++;
                        },
                        flushAll() {
                            flushAll++;
                        }
                    }
                };
            };

            const completeServer = createMockServer();
            await readyClient(completeServer);
            const completed = fakeReporter();
            const usagePromise = probe.waitTurnCompletion(
                completeServer.client,
                'th-1',
                'tu-1',
                completed.reporter,
                idleToken
            );
            completeServer.push({
                method: 'item/completed',
                params: { threadId: 'th-1', turnId: 'tu-1', item: { type: 'reasoning' } }
            });
            completeServer.push({
                method: 'thread/tokenUsage/updated',
                params: {
                    threadId: 'th-1',
                    turnId: 'tu-1',
                    tokenUsage: {
                        last: {
                            totalTokens: 10,
                            inputTokens: 4,
                            cachedInputTokens: 1,
                            cacheWriteInputTokens: 0,
                            outputTokens: 3,
                            reasoningOutputTokens: 2
                        }
                    }
                }
            });
            completeServer.push({
                method: 'turn/completed',
                params: { threadId: 'th-1', turn: { id: 'tu-1', status: 'completed' } }
            });
            await new Promise(resolve => setImmediate(resolve));
            const usage = await usagePromise;
            assert.equal(completed.endChain(), 1, 'reasoning 完成调用 endThinkingChain');
            assert.equal(completed.flushAll(), 0, '不得提前 flushAll');
            assert.equal(usage?.prompt_tokens, 5);

            const exitServer = createMockServer();
            await readyClient(exitServer);
            const exiting = fakeReporter();
            const hung = probe.waitTurnCompletion(exitServer.client, 'th-2', 'tu-2', exiting.reporter, idleToken);
            const assertion = assert.rejects(hung, /exited during turn/);
            exitServer.emitExit();
            await assertion;
        });

        test('resolvePersistentStrategy：工具集漂移放弃 resume 并 archive 旧 thread', async () => {
            const makeMessages = () => [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q1')
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                    new vscode.LanguageModelDataPart(
                        encodeStatefulMarker('gpt-x', {
                            provider: 'codex',
                            modelId: 'gpt-x',
                            sdkMode: 'codex-app-server',
                            sessionId: 'test-session',
                            responseId: 'turn-1',
                            codexThreadId: 't-old',
                            codexLastTurnId: 'turn-1'
                        }),
                        CustomDataPartMimeTypes.StatefulMarker
                    )
                ]),
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
                    new vscode.LanguageModelTextPart('q2')
                ])
            ];
            codexThreadSessionStore.set({
                sessionId: 'test-session',
                threadId: 't-old',
                lastTurnId: 'turn-1',
                modelId: 'gpt-x',
                toolNames: ['alpha', 'beta'],
                updatedAt: Date.now()
            });

            // 漂移：工具集变化 → 不 resume，archive 旧 thread，回退全新持久会话
            const driftServer = createMockServer({
                autoRespond: frame => (frame.method === 'thread/archive' ? { id: frame.id, result: {} } : undefined)
            });
            await readyClient(driftServer);
            const drift = await probe.resolvePersistentStrategy(
                driftServer.client,
                makeMessages(),
                'gpt-x',
                'gpt-x',
                'test-session',
                ['alpha', 'gamma']
            );
            assert.equal(drift.resumeThreadId, undefined, '漂移时不 resume');
            assert.equal(drift.persistentNew, true, '漂移后新建持久 thread 全量重放');
            // archive 为 fire-and-forget，等写入完成再断言
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(
                driftServer.received.some(
                    f => f.method === 'thread/archive' && (f.params as { threadId?: string }).threadId === 't-old'
                ),
                '漂移后归档旧 thread'
            );
            assert.ok(!driftServer.received.some(f => f.method === 'thread/resume'), '漂移后不发起 resume');
            assert.equal(codexThreadSessionStore.get('test-session'), undefined, '漂移后清除 store 条目');

            // 无漂移：正常 resume + 尾部对账
            codexThreadSessionStore.set({
                sessionId: 'test-session',
                threadId: 't-old',
                lastTurnId: 'turn-1',
                modelId: 'gpt-x',
                toolNames: ['alpha', 'beta'],
                updatedAt: Date.now()
            });
            const okServer = createMockServer({
                autoRespond: frame => {
                    if (frame.method === 'thread/resume') {
                        return { id: frame.id, result: { thread: { id: 't-old' } } };
                    }
                    if (frame.method === 'thread/turns/list') {
                        return {
                            id: frame.id,
                            result: { data: [{ id: 'turn-1' }], nextCursor: null, backwardsCursor: null }
                        };
                    }
                    return undefined;
                }
            });
            await readyClient(okServer);
            const resumed = await probe.resolvePersistentStrategy(
                okServer.client,
                makeMessages(),
                'gpt-x',
                'gpt-x',
                'test-session',
                ['alpha', 'beta']
            );
            assert.equal(resumed.resumeThreadId, 't-old', '工具集一致时正常 resume');
            assert.equal(resumed.turnInput[0]?.text, 'q2', '增量仅含 marker 后输入');

            // stored 缺 toolNames、当前有工具：按空集比较，视为漂移并 archive
            codexThreadSessionStore.set({
                sessionId: 'test-session',
                threadId: 't-old',
                lastTurnId: 'turn-1',
                modelId: 'gpt-x',
                updatedAt: Date.now()
            });
            const missingToolsServer = createMockServer({
                autoRespond: frame => (frame.method === 'thread/archive' ? { id: frame.id, result: {} } : undefined)
            });
            await readyClient(missingToolsServer);
            const missingTools = await probe.resolvePersistentStrategy(
                missingToolsServer.client,
                makeMessages(),
                'gpt-x',
                'gpt-x',
                'test-session',
                ['alpha']
            );
            assert.equal(missingTools.resumeThreadId, undefined, '缺 toolNames 视为漂移');
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(
                missingToolsServer.received.some(f => f.method === 'thread/archive'),
                '缺 toolNames 漂移后归档'
            );

            // 换模型：不 resume，archive 旧 thread
            codexThreadSessionStore.set({
                sessionId: 'test-session',
                threadId: 't-old',
                lastTurnId: 'turn-1',
                modelId: 'gpt-x',
                toolNames: ['alpha'],
                updatedAt: Date.now()
            });
            const modelServer = createMockServer({
                autoRespond: frame => (frame.method === 'thread/archive' ? { id: frame.id, result: {} } : undefined)
            });
            await readyClient(modelServer);
            const switched = await probe.resolvePersistentStrategy(
                modelServer.client,
                makeMessages(),
                'gpt-y',
                'gpt-y',
                'test-session',
                ['alpha']
            );
            assert.equal(switched.resumeThreadId, undefined, '换模型不 resume');
            assert.equal(switched.persistentNew, true);
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(
                modelServer.received.some(
                    f => f.method === 'thread/archive' && (f.params as { threadId?: string }).threadId === 't-old'
                ),
                '换模型归档旧 thread'
            );
            assert.ok(!modelServer.received.some(f => f.method === 'thread/resume'), '换模型不发起 resume');
            codexThreadSessionStore.delete('test-session');
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

        test('resolveTurnOverrides：子请求降档关 summary，主请求透传用户 effort', () => {
            // 子请求：effort 降至支持的最低档（none 优先）
            assert.deepEqual(
                probe.resolveTurnOverrides(
                    { modelOptions: { requestKind: 'chat-title' } },
                    { reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high'] }
                ),
                { effort: 'none', summary: 'none' }
            );
            // 模型不支持 none/minimal → 降至 low
            assert.deepEqual(
                probe.resolveTurnOverrides(
                    { modelOptions: { requestKind: 'summarization' } },
                    { reasoningEffort: ['low', 'medium', 'high'] }
                ),
                { effort: 'low', summary: 'none' }
            );
            // 不支持任何低档 → 不带 effort，仅关 summary
            assert.deepEqual(
                probe.resolveTurnOverrides(
                    { modelOptions: { requestKind: 'summarization' } },
                    { reasoningEffort: ['medium', 'high'] }
                ),
                { summary: 'none' }
            );
            // 主请求：透传支持列表内的用户选择
            assert.deepEqual(
                probe.resolveTurnOverrides(
                    { modelOptions: { requestKind: 'main-agent' }, modelConfiguration: { reasoningEffort: 'high' } },
                    { reasoningEffort: ['low', 'medium', 'high'] }
                ),
                { effort: 'high' }
            );
            // 主请求：非 codex 档位（max，模型不支持）不透传，防服务端 400
            assert.deepEqual(
                probe.resolveTurnOverrides(
                    { modelOptions: { requestKind: 'main-agent' }, modelConfiguration: { reasoningEffort: 'max' } },
                    { reasoningEffort: ['low', 'medium', 'high'] }
                ),
                {}
            );
        });

        test('toTurnFailureError：codexErrorInfo 结构化映射到 RetryManager 分类', () => {
            const makeError = (codexErrorInfo: unknown, message = 'turn failed') =>
                probe.toTurnFailureError(
                    { message, codexErrorInfo, additionalDetails: null, misalignment: null },
                    'failed'
                ) as Error & { code?: string; status?: number };

            // usageLimitExceeded → 永久配额耗尽：任何可重试分类均为 false
            // （消息 "try again later" 若无结构化 code 可能被误判为可重试过载）
            const usageLimit = makeError('usageLimitExceeded', "You've hit your usage limit. Try again later.");
            assert.equal(usageLimit.code, 'usage_limit_reached');
            assert.equal(RetryManager.isRateLimitError(usageLimit), false);
            assert.equal(RetryManager.isServerError(usageLimit), false);
            assert.equal(RetryManager.isNetworkError(usageLimit), false);

            // rateLimitExceeded → 可重试限流
            const rateLimited = makeError('rateLimitExceeded', 'rate limit exceeded: slow down');
            assert.equal(rateLimited.code, 'rate_limit_exceeded');
            assert.equal(RetryManager.isRateLimitError(rateLimited), true);

            // serverOverloaded → 529 可重试
            const overloaded = makeError('serverOverloaded', 'Selected model is at capacity.');
            assert.equal(overloaded.status, 529);
            assert.equal(RetryManager.isRateLimitError(overloaded), true);

            // responseTooManyFailedAttempts{429} → 透传上游状态码
            const tooMany = makeError({ responseTooManyFailedAttempts: { httpStatusCode: 429 } });
            assert.equal(tooMany.status, 429);
            assert.equal(RetryManager.isRateLimitError(tooMany), true);

            // contextWindowExceeded → 永久（重开 thread 才有意义，重试无效）
            const ctx = makeError('contextWindowExceeded', "Codex ran out of room in the model's context window.");
            assert.equal(ctx.code, 'context_window_exceeded');
            assert.equal(RetryManager.isRateLimitError(ctx), false);
            assert.equal(RetryManager.isServerError(ctx), false);

            // unauthorized → 401 不重试
            const unauthorized = makeError('unauthorized');
            assert.equal(unauthorized.status, 401);
            assert.equal(RetryManager.isRateLimitError(unauthorized), false);
            assert.equal(RetryManager.isServerError(unauthorized), false);

            const internal = makeError('internalServerError');
            assert.equal(internal.status, 500);
            assert.equal(RetryManager.isServerError(internal), false);

            const badRequest = makeError('badRequest');
            assert.equal(badRequest.status, 400);
            assert.equal(RetryManager.isServerError(badRequest), false);

            // 无结构化信息 → 纯消息兜底
            const fallback = probe.toTurnFailureError(null, 'failed');
            assert.match(fallback.message, /status failed/);
        });
    });
});
