import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import { ConfigManager, type GCMPConfig } from '../../src/utils/config/configManager';
import { JsonSchemaProvider } from '../../src/utils/config/jsonSchemaProvider';
import { closeProxyAgents, createProxiedFetch, sanitizeConfigForLogging } from '../../src/utils/net/proxyAgent';

interface ProxyValueSchema {
    anyOf?: Array<{ const?: string; format?: string; pattern?: string }>;
    type?: string;
}

interface ConfigurationSettingSchema extends ProxyValueSchema {
    additionalProperties?: ConfigurationSettingSchema;
    items?: ConfigurationSettingSchema;
    properties?: Record<string, ConfigurationSettingSchema>;
    propertyNames?: { enum?: string[] };
    scope?: string;
}

interface ConfigurationContribution {
    properties?: Record<string, ConfigurationSettingSchema>;
}

interface ProviderOverrideEntrySchema {
    properties?: {
        models?: {
            items?: {
                properties?: {
                    proxy?: ProxyValueSchema;
                };
            };
        };
        proxy?: ProxyValueSchema;
    };
}

interface ProviderOverrideSettingsSchema {
    patternProperties?: Record<string, ProviderOverrideEntrySchema>;
}

interface DiscoveredTestConfiguration {
    config: {
        workspaceFolder: string;
        launchArgs: string[];
    };
    env: { GCMP_TEST_ROOT: string };
}

function acceptsProxyValue(schema: ProxyValueSchema | undefined, value: string): boolean {
    assert.ok(schema?.anyOf);
    for (const branch of schema.anyOf) {
        assert.equal(branch.format, undefined, 'Proxy Schema must not contain a permissive format-only branch');
        assert.ok(branch.const !== undefined || branch.pattern !== undefined, 'Unsupported proxy Schema branch');
    }
    return schema.anyOf.some(
        branch => branch.const === value || (branch.pattern !== undefined && new RegExp(branch.pattern).test(value))
    );
}

function assertProxyValueSchema(schema: ProxyValueSchema | undefined, allowEmpty: boolean): void {
    assert.equal(schema?.type, 'string');
    assert.equal(acceptsProxyValue(schema, ''), allowEmpty);
    assert.equal(acceptsProxyValue(schema, 'noproxy'), true);
    assert.equal(acceptsProxyValue(schema, 'proxy.example:65535'), true);
    assert.equal(acceptsProxyValue(schema, '127.0.0.1:08080'), true);
    assert.equal(acceptsProxyValue(schema, 'http://127.0.0.1:08080'), true);
    assert.equal(acceptsProxyValue(schema, 'http://user:secret@[::1]:65535/path?mode=tunnel'), true);
    assert.equal(acceptsProxyValue(schema, 'proxy.example:65536'), false);
    assert.equal(acceptsProxyValue(schema, 'proxy.example:99999'), false);
    assert.equal(acceptsProxyValue(schema, 'http://proxy.example:99999'), false);
    for (const authority of [':secret@proxy.example', ':p%40ss@[::1]']) {
        for (const scheme of ['', 'http://', 'https://']) {
            assert.equal(acceptsProxyValue(schema, `${scheme}${authority}:08080`), true);
            assert.equal(acceptsProxyValue(schema, `${scheme}${authority}:65535`), true);
            assert.equal(acceptsProxyValue(schema, `${scheme}${authority}:0`), false);
            assert.equal(acceptsProxyValue(schema, `${scheme}${authority}:65536`), false);
            assert.equal(acceptsProxyValue(schema, `${scheme}${authority}:99999`), false);
        }
    }
}

function withConfig(config: GCMPConfig, run: () => void): void {
    const mutableConfigManager = ConfigManager as unknown as {
        getConfig: () => GCMPConfig;
    };
    const originalGetConfig = mutableConfigManager.getConfig;
    mutableConfigManager.getConfig = () => config;

    try {
        run();
    } finally {
        mutableConfigManager.getConfig = originalGetConfig;
    }
}

async function withAsyncConfig<T>(config: GCMPConfig, run: () => Promise<T>): Promise<T> {
    const mutableConfigManager = ConfigManager as unknown as {
        getConfig: () => GCMPConfig;
    };
    const originalGetConfig = mutableConfigManager.getConfig;
    mutableConfigManager.getConfig = () => config;

    try {
        return await run();
    } finally {
        mutableConfigManager.getConfig = originalGetConfig;
    }
}

const serverSockets = new WeakMap<http.Server, Set<net.Socket>>();

function trackSocket(server: http.Server, socket: net.Socket): void {
    const sockets = serverSockets.get(server)!;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
}

async function listenOnLoopback(server: http.Server): Promise<number> {
    serverSockets.set(server, new Set());
    server.on('connection', socket => trackSocket(server, socket));
    await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => reject(error);
        server.once('error', handleError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', handleError);
            resolve();
        });
    });
    return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
    const closing =
        server.listening ?
            new Promise<void>((resolve, reject) => {
                server.close(error => (error ? reject(error) : resolve()));
            })
        :   Promise.resolve();
    server.closeAllConnections();
    for (const socket of serverSockets.get(server) ?? []) {
        socket.destroy();
    }
    await closing;
}

function createConfig(
    machineOverrides: GCMPConfig['machineOverrides'],
    providerOverrides: GCMPConfig['providerOverrides'] = {}
): GCMPConfig {
    return {
        machineOverrides,
        providerOverrides,
        proxy: 'http://global-proxy.example:8080'
    } as GCMPConfig;
}

function getIsolatedWorkspace(): { root: string; folder: vscode.WorkspaceFolder } {
    const root = process.env.GCMP_TEST_ROOT;
    assert.ok(root, 'Settings tests require the isolated VS Code test configuration');
    assert.equal(vscode.workspace.workspaceFile?.fsPath, vscode.Uri.file(join(root, 'scope.code-workspace')).fsPath);
    assert.equal(vscode.workspace.workspaceFolders?.length, 2);
    const folder = vscode.workspace.workspaceFolders[0];
    assert.equal(folder.uri.fsPath, vscode.Uri.file(join(root, 'first')).fsPath);
    return { root, folder };
}

async function updateGlobalSetting<K extends 'machineOverrides' | 'providerOverrides'>(
    key: K,
    value: GCMPConfig[K] | undefined
): Promise<void> {
    let listener: vscode.Disposable | undefined;
    let timer: NodeJS.Timeout | undefined;
    const changed = new Promise<void>((resolve, reject) => {
        listener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(`gcmp.${key}`)) {
                resolve();
            }
        });
        timer = setTimeout(() => reject(new Error(`No configuration change event for gcmp.${key}`)), 3_000);
    });
    try {
        await Promise.all([
            changed,
            vscode.workspace.getConfiguration('gcmp').update(key, value, vscode.ConfigurationTarget.Global)
        ]);
    } finally {
        listener?.dispose();
        clearTimeout(timer);
    }
}

suite('machine overrides', () => {
    test('contributes a machine-scoped nested provider and model setting', async () => {
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        assert.ok(extension);

        const configuration = extension.packageJSON.contributes?.configuration as ConfigurationContribution | undefined;
        const setting = configuration?.properties?.['gcmp.machineOverrides'];
        const providerSetting = configuration?.properties?.['gcmp.providerOverrides'];

        assert.equal(setting?.type, 'object');
        assert.equal(setting?.scope, 'machine');
        assert.equal(setting?.additionalProperties?.type, 'object');
        assert.equal(setting?.additionalProperties?.properties?.proxy?.type, 'string');
        assert.equal(setting?.additionalProperties?.properties?.models?.type, 'array');
        assert.equal(providerSetting?.scope, 'application');

        assertProxyValueSchema(configuration?.properties?.['gcmp.proxy'], true);
        // FIM/NES 配置声明已拆分至独立扩展 gcmp-fim-nes，从其 manifest 读取（开发宿主中位于仓库子目录）
        const fimNesManifestPath = join(extension.extensionPath, 'extensions', 'gcmp-fim-nes', 'package.json');
        const fimNesConfiguration = JSON.parse(await readFile(fimNesManifestPath, 'utf8')).contributes
            ?.configuration as ConfigurationContribution | undefined;
        assertProxyValueSchema(
            fimNesConfiguration?.properties?.['gcmp.fimCompletion.modelConfig']?.properties?.proxy,
            true
        );
        assertProxyValueSchema(
            fimNesConfiguration?.properties?.['gcmp.nesCompletion.modelConfig']?.properties?.proxy,
            true
        );
        assertProxyValueSchema(setting?.additionalProperties?.properties?.proxy, true);
        assertProxyValueSchema(setting?.additionalProperties?.properties?.models?.items?.properties?.proxy, false);
    });

    test('enables chatProvider during configuration discovery without overwriting workspace settings', async () => {
        const { root, folder } = getIsolatedWorkspace();
        const workspaceFile = vscode.workspace.workspaceFile!;
        const editor = vscode.workspace.getConfiguration('editor', folder.uri);
        const originalTabSize = editor.inspect<number>('tabSize')?.workspaceValue;
        const extension = vscode.extensions.getExtension('vicanent.gcmp');
        assert.ok(extension);
        const discover = promisify(execFile);

        try {
            await editor.update('tabSize', 3, vscode.ConfigurationTarget.Workspace);
            const originalWorkspace = await readFile(workspaceFile.fsPath, 'utf8');

            for (let attempt = 0; attempt < 2; attempt++) {
                const { stdout } = await discover(
                    process.execPath,
                    [
                        join(extension.extensionPath, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs'),
                        '--config',
                        join(extension.extensionPath, '.vscode-test.mjs'),
                        '--list-configuration'
                    ],
                    {
                        cwd: tmpdir(),
                        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                        timeout: 5_000
                    }
                );
                const [discovered] = JSON.parse(stdout) as DiscoveredTestConfiguration[];
                assert.ok(discovered);
                assert.ok((await stat(discovered.config.workspaceFolder)).isFile());
                assert.ok((await stat(join(discovered.env.GCMP_TEST_ROOT, 'first'))).isDirectory());
                assert.ok((await stat(join(discovered.env.GCMP_TEST_ROOT, 'second'))).isDirectory());
                assert.equal(vscode.Uri.file(discovered.env.GCMP_TEST_ROOT).fsPath, vscode.Uri.file(root).fsPath);
                assert.equal(vscode.Uri.file(discovered.config.workspaceFolder).fsPath, workspaceFile.fsPath);
                assert.ok(
                    discovered.config.launchArgs.includes(
                        `--user-data-dir=${join(discovered.env.GCMP_TEST_ROOT, 'user-data')}`
                    )
                );
                assert.ok(discovered.config.launchArgs.includes('--enable-proposed-api=vicanent.gcmp'));
                assert.equal(await readFile(workspaceFile.fsPath, 'utf8'), originalWorkspace);
            }
        } finally {
            await editor.update('tabSize', originalTabSize, vscode.ConfigurationTarget.Workspace);
        }
        assert.equal(
            vscode.workspace.getConfiguration('editor', folder.uri).inspect<number>('tabSize')?.workspaceValue,
            originalTabSize
        );
    });

    for (const initialState of [
        'current settings',
        'matching proxy',
        'matching provider',
        'matching both',
        'empty objects'
    ] as const) {
        test(`persists global overrides and refreshes routing through real configuration events (${initialState})`, async () => {
            const { root } = getIsolatedWorkspace();
            const configuration = vscode.workspace.getConfiguration('gcmp');
            const originalMachineOverrides =
                configuration.inspect<GCMPConfig['machineOverrides']>('machineOverrides')?.globalValue;
            const originalProvider =
                configuration.inspect<GCMPConfig['providerOverrides']>('providerOverrides')?.globalValue;
            const extension = vscode.extensions.getExtension('vicanent.gcmp');
            assert.ok(extension);
            const machineOverrides: GCMPConfig['machineOverrides'] = {
                codex: {
                    proxy: ' http://127.0.0.1:18081 ',
                    models: [{ id: ' Scoped-Model ', proxy: ' noproxy ' }]
                }
            };
            const providerOverrides: GCMPConfig['providerOverrides'] = {
                codex: {
                    proxy: 'http://synchronized-provider-proxy.example:8080',
                    retry: { maxAttempts: 7 }
                }
            };

            try {
                if (initialState !== 'current settings') {
                    const initialProxy =
                        initialState === 'matching proxy' || initialState === 'matching both' ? machineOverrides : {};
                    const initialProvider =
                        initialState === 'matching provider' || initialState === 'matching both' ?
                            providerOverrides
                        :   {};
                    await Promise.all([
                        configuration.update('machineOverrides', initialProxy, vscode.ConfigurationTarget.Global),
                        configuration.update('providerOverrides', initialProvider, vscode.ConfigurationTarget.Global)
                    ]);
                    assert.deepEqual(
                        vscode.workspace.getConfiguration('gcmp').inspect('machineOverrides')?.globalValue,
                        initialProxy
                    );
                    assert.deepEqual(
                        vscode.workspace.getConfiguration('gcmp').inspect('providerOverrides')?.globalValue,
                        initialProvider
                    );
                }

                // 同值写入不会触发变更事件，事件断言必须从不同的初始状态开始。
                await Promise.all([
                    configuration.update('machineOverrides', undefined, vscode.ConfigurationTarget.Global),
                    configuration.update('providerOverrides', undefined, vscode.ConfigurationTarget.Global)
                ]);
                assert.equal(
                    vscode.workspace.getConfiguration('gcmp').inspect('machineOverrides')?.globalValue,
                    undefined
                );
                assert.equal(
                    vscode.workspace.getConfiguration('gcmp').inspect('providerOverrides')?.globalValue,
                    undefined
                );

                ConfigManager.clearCache();
                assert.equal(ConfigManager.getConfig().debug.captureHar, false);
                ConfigManager.initialize({
                    extensionPath: extension.extensionPath,
                    globalStorageUri: vscode.Uri.file(join(root, 'storage'))
                } as vscode.ExtensionContext);
                const cached = ConfigManager.getConfig();
                assert.equal(ConfigManager.getConfig(), cached);

                await updateGlobalSetting('machineOverrides', machineOverrides);
                assert.deepEqual(
                    vscode.workspace.getConfiguration('gcmp').inspect('machineOverrides')?.globalValue,
                    machineOverrides
                );
                assert.notEqual(ConfigManager.getConfig(), cached);
                assert.equal(ConfigManager.resolveProxyForModel(undefined, 'codex'), 'http://127.0.0.1:18081');
                assert.equal(ConfigManager.resolveProxyForModel({ id: 'Scoped-Model' }, 'codex'), 'noproxy');
                assert.equal(
                    ConfigManager.resolveProxyForModel({ id: 'scoped-model' }, 'codex'),
                    'http://127.0.0.1:18081'
                );

                await updateGlobalSetting('providerOverrides', providerOverrides);
                assert.deepEqual(
                    vscode.workspace.getConfiguration('gcmp').inspect('providerOverrides')?.globalValue,
                    providerOverrides
                );
                assert.deepEqual(ConfigManager.getProviderOverrides(), providerOverrides);
                const beforeSwitch = ConfigManager.getConfig();
                await updateGlobalSetting('machineOverrides', { codex: { proxy: 'noproxy' } });
                assert.notEqual(ConfigManager.getConfig(), beforeSwitch);
                assert.equal(ConfigManager.resolveProxyForModel(undefined, 'codex'), 'noproxy');
                assert.deepEqual(ConfigManager.getProviderOverrides(), providerOverrides);

                await updateGlobalSetting('machineOverrides', undefined);
                assert.equal(
                    vscode.workspace.getConfiguration('gcmp').inspect('machineOverrides')?.globalValue,
                    undefined
                );
                assert.equal(Object.keys(ConfigManager.getConfig().machineOverrides).length, 0);
                assert.deepEqual(ConfigManager.getProviderOverrides(), providerOverrides);
                assert.equal(
                    ConfigManager.resolveProxyForModel(undefined, 'codex'),
                    'http://synchronized-provider-proxy.example:8080'
                );
            } finally {
                try {
                    await Promise.all([
                        configuration.update(
                            'machineOverrides',
                            originalMachineOverrides,
                            vscode.ConfigurationTarget.Global
                        ),
                        configuration.update('providerOverrides', originalProvider, vscode.ConfigurationTarget.Global)
                    ]);
                } finally {
                    await ConfigManager.dispose();
                }
            }
            assert.deepEqual(
                vscode.workspace.getConfiguration('gcmp').inspect('machineOverrides')?.globalValue,
                originalMachineOverrides
            );
            assert.deepEqual(
                vscode.workspace.getConfiguration('gcmp').inspect('providerOverrides')?.globalValue,
                originalProvider
            );
        });
    }

    test('rejects workspace and folder overrides while allowing resource-scoped settings', async () => {
        const { folder } = getIsolatedWorkspace();
        const editor = vscode.workspace.getConfiguration('editor', folder.uri);
        const originalTabSize = editor.inspect<number>('tabSize');
        const configuration = vscode.workspace.getConfiguration('gcmp', folder.uri);

        try {
            await editor.update('tabSize', 3, vscode.ConfigurationTarget.Workspace);
            await editor.update('tabSize', 5, vscode.ConfigurationTarget.WorkspaceFolder);
            const writtenTabSize = vscode.workspace.getConfiguration('editor', folder.uri).inspect<number>('tabSize');
            assert.equal(writtenTabSize?.workspaceValue, 3);
            assert.equal(writtenTabSize?.workspaceFolderValue, 5);

            for (const key of ['machineOverrides', 'providerOverrides'] as const) {
                const before = configuration.inspect<GCMPConfig[typeof key]>(key);
                const value =
                    key === 'machineOverrides' ?
                        { codex: { proxy: 'noproxy' } }
                    :   { codex: { retry: { maxAttempts: 7 } } };
                for (const target of [
                    vscode.ConfigurationTarget.Workspace,
                    vscode.ConfigurationTarget.WorkspaceFolder
                ]) {
                    await assert.rejects(
                        async () => configuration.update(key, value, target),
                        (error: unknown) => error instanceof Error && error.message.includes(`gcmp.${key}`)
                    );
                    const after = vscode.workspace
                        .getConfiguration('gcmp', folder.uri)
                        .inspect<GCMPConfig[typeof key]>(key);
                    assert.deepEqual(after?.globalValue, before?.globalValue);
                    assert.deepEqual(after?.workspaceValue, before?.workspaceValue);
                    assert.deepEqual(after?.workspaceFolderValue, before?.workspaceFolderValue);
                }
            }
        } finally {
            await Promise.all([
                editor.update('tabSize', originalTabSize?.workspaceValue, vscode.ConfigurationTarget.Workspace),
                editor.update(
                    'tabSize',
                    originalTabSize?.workspaceFolderValue,
                    vscode.ConfigurationTarget.WorkspaceFolder
                )
            ]);
        }
        const restoredTabSize = vscode.workspace.getConfiguration('editor', folder.uri).inspect<number>('tabSize');
        assert.equal(restoredTabSize?.workspaceValue, originalTabSize?.workspaceValue);
        assert.equal(restoredTabSize?.workspaceFolderValue, originalTabSize?.workspaceFolderValue);
    });

    test('machine model proxy takes precedence over the model and provider proxies', () => {
        withConfig(
            createConfig({
                codex: {
                    proxy: 'http://provider-proxy.example:8080',
                    models: [{ id: 'gpt-5', proxy: 'http://machine-model-proxy.example:8080' }]
                }
            }),
            () => {
                assert.equal(
                    ConfigManager.resolveProxyForModel(
                        { id: 'gpt-5', proxy: 'http://model-proxy.example:8080' },
                        'codex'
                    ),
                    'http://machine-model-proxy.example:8080'
                );
            }
        );
    });

    test('model proxy remains higher priority than the machine provider proxy', () => {
        withConfig(createConfig({ codex: { proxy: 'http://machine-proxy.example:8080' } }), () => {
            assert.equal(
                ConfigManager.resolveProxyForModel({ proxy: 'http://model-proxy.example:8080' }, 'codex'),
                'http://model-proxy.example:8080'
            );
        });
    });

    test('routes real loopback traffic, bypasses noproxy, and restores configuration after timeouts', async () => {
        let targetRequests = 0;
        let proxyConnections = 0;
        const originalGetConfig = ConfigManager.getConfig;
        const targetServer = http.createServer((request, response) => {
            targetRequests++;
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            if (request.url === '/stalled') {
                response.flushHeaders();
                return;
            }
            response.end('loopback-ok');
        });
        const proxyServer = http.createServer((_request, response) => {
            response.writeHead(501);
            response.end();
        });
        proxyServer.on('connect', (request, clientSocket, head) => {
            proxyConnections++;
            const [host, rawPort] = (request.url ?? '').split(':');
            const upstreamSocket = net.connect(Number(rawPort), host, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) {
                    upstreamSocket.write(head);
                }
                upstreamSocket.pipe(clientSocket);
                clientSocket.pipe(upstreamSocket);
            });
            trackSocket(proxyServer, upstreamSocket);
            upstreamSocket.on('error', () => clientSocket.destroy());
            clientSocket.on('error', () => upstreamSocket.destroy());
            upstreamSocket.on('close', () => clientSocket.destroy());
            clientSocket.on('close', () => upstreamSocket.destroy());
        });

        try {
            const targetPort = await listenOnLoopback(targetServer);
            const proxyPort = await listenOnLoopback(proxyServer);
            const targetUrl = `http://127.0.0.1:${targetPort}/probe`;
            const proxyUrl = `http://127.0.0.1:${proxyPort}`;

            await withAsyncConfig(createConfig({ codex: { proxy: proxyUrl } }), async () => {
                const response = await ConfigManager.fetchWithProxy(
                    targetUrl,
                    { signal: AbortSignal.timeout(5_000) },
                    { providerKey: 'codex', skipHar: true }
                );
                assert.equal(await response.text(), 'loopback-ok');
            });

            assert.equal(proxyConnections, 1);
            assert.equal(targetRequests, 1);

            await withAsyncConfig(createConfig({ codex: { proxy: 'noproxy' } }), async () => {
                const response = await ConfigManager.fetchWithProxy(
                    targetUrl,
                    { signal: AbortSignal.timeout(5_000) },
                    { providerKey: 'codex', skipHar: true }
                );
                assert.equal(await response.text(), 'loopback-ok');
            });

            assert.equal(proxyConnections, 1);
            assert.equal(targetRequests, 2);

            for (const proxy of [proxyUrl, 'noproxy']) {
                const signal = AbortSignal.timeout(1_000);
                await assert.rejects(
                    withAsyncConfig(createConfig({ codex: { proxy } }), async () => {
                        const response = await ConfigManager.fetchWithProxy(
                            `http://127.0.0.1:${targetPort}/stalled`,
                            { signal },
                            { providerKey: 'codex', skipHar: true }
                        );
                        return response.text();
                    }),
                    (error: unknown) =>
                        signal.aborted &&
                        error instanceof Error &&
                        (error.name === 'TimeoutError' || error.name === 'AbortError')
                );
                assert.equal(ConfigManager.getConfig, originalGetConfig);
            }
            assert.equal(targetRequests, 4);
        } finally {
            try {
                await Promise.all([closeServer(proxyServer), closeServer(targetServer)]);
            } finally {
                await closeProxyAgents();
            }
        }
        assert.equal(ConfigManager.getConfig, originalGetConfig);
        assert.equal(proxyServer.listening, false);
        assert.equal(targetServer.listening, false);
        assert.ok([...serverSockets.get(proxyServer)!].every(socket => socket.destroyed));
    });

    test('closes an unfinished CONNECT tunnel without waiting for its peer', async () => {
        const server = http.createServer();
        const acceptedSockets = new Set<net.Socket>();
        server.on('connection', socket => acceptedSockets.add(socket));
        server.on('connect', (_request, socket) => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        });
        let request: http.ClientRequest | undefined;
        let clientSocket: net.Socket | undefined;
        let closing: Promise<void> | undefined;
        let timer: NodeJS.Timeout | undefined;

        try {
            const port = await listenOnLoopback(server);
            request = http.request({
                hostname: '127.0.0.1',
                port,
                method: 'CONNECT',
                path: '127.0.0.1:1',
                signal: AbortSignal.timeout(5_000)
            });
            const connected = once(request, 'connect');
            request.end();
            [, clientSocket] = (await connected) as [http.IncomingMessage, net.Socket, Buffer];
            clientSocket.resume();
            const clientClosed = once(clientSocket, 'close');
            closing = closeServer(server);
            const result = await Promise.race([
                Promise.all([closing, clientClosed]).then(() => 'closed'),
                new Promise<string>(resolve => {
                    timer = setTimeout(() => resolve('timeout'), 1_000);
                })
            ]);
            assert.equal(result, 'closed');
            assert.ok([...acceptedSockets].every(socket => socket.destroyed));
        } finally {
            clearTimeout(timer);
            request?.destroy();
            clientSocket?.destroy();
            for (const socket of acceptedSockets) {
                socket.destroy();
            }
            await (closing ?? closeServer(server));
        }
    });

    test('FIM and NES model names can select machine model proxies', () => {
        withConfig(
            createConfig({
                deepseek: {
                    proxy: 'http://machine-provider-proxy.example:8080',
                    models: [{ id: 'deepseek-chat', proxy: 'http://completion-model-proxy.example:8080' }]
                }
            }),
            () => {
                assert.equal(
                    ConfigManager.resolveProxyForModel({ model: 'deepseek-chat' }, 'deepseek'),
                    'http://completion-model-proxy.example:8080'
                );
            }
        );
    });

    test('built-in handler root keys still honor model sub-provider overrides', () => {
        withConfig(
            createConfig({
                dashscope: {
                    proxy: 'http://root-provider-proxy.example:8080',
                    models: [
                        {
                            id: 'qwen3.8-max-token-plan',
                            proxy: 'http://root-model-proxy.example:8080'
                        }
                    ]
                },
                'dashscope-token': {
                    proxy: 'http://sub-provider-proxy.example:8080',
                    models: [{ id: 'qwen3.8-max-token-plan', proxy: 'noproxy' }]
                }
            }),
            () => {
                assert.equal(
                    ConfigManager.resolveProxyForModel(
                        { id: 'qwen3.8-max-token-plan', provider: 'dashscope-token' },
                        'dashscope'
                    ),
                    'noproxy'
                );
                assert.equal(
                    ConfigManager.resolveProxyForModel(
                        { id: 'another-token-plan-model', provider: 'dashscope-token' },
                        'dashscope'
                    ),
                    'http://sub-provider-proxy.example:8080'
                );
            }
        );
    });

    test('supports exact compatible providers, compatible fallback, and noproxy', () => {
        withConfig(
            createConfig({
                Acme: { models: [{ id: 'acme-model', proxy: 'noproxy' }] },
                compatible: { proxy: 'http://compatible-proxy.example:8080' }
            }),
            () => {
                assert.equal(
                    ConfigManager.resolveProxyForModel({ id: 'acme-model', provider: 'Acme' }, 'compatible'),
                    'noproxy'
                );
                assert.equal(
                    ConfigManager.resolveProxyForModel({ provider: 'Other' }, 'compatible'),
                    'http://compatible-proxy.example:8080'
                );
                assert.equal(
                    ConfigManager.resolveProxyForModel({ id: 'providerless-model' }, 'compatible'),
                    'http://compatible-proxy.example:8080'
                );
            }
        );
    });

    test('uses synchronized provider and model proxy fields as fallback', () => {
        const providerOverrides: GCMPConfig['providerOverrides'] = {
            Acme: {
                proxy: 'http://synchronized-provider-proxy.example:8080',
                models: [{ id: 'acme-model', proxy: 'noproxy' }]
            }
        };

        withConfig(createConfig({}, providerOverrides), () => {
            assert.equal(
                ConfigManager.resolveProxyForModel({ id: 'acme-model', provider: 'Acme' }, 'compatible'),
                'noproxy'
            );
            assert.equal(
                ConfigManager.resolveProxyForModel({ id: 'other-model', provider: 'Acme' }, 'compatible'),
                'http://synchronized-provider-proxy.example:8080'
            );
            assert.equal(
                ConfigManager.resolveProxyForModel({ id: 'acme-model', provider: 'acme' }, 'compatible'),
                'http://global-proxy.example:8080'
            );
        });
    });

    for (const { name, models, expected } of [
        {
            name: 'a later entry first defines the proxy',
            models: [
                { id: 'gpt-5', maxOutputTokens: 42 },
                { id: 'gpt-5', proxy: 'noproxy' }
            ],
            expected: 'noproxy'
        },
        {
            name: 'a later noproxy replaces an endpoint',
            models: [
                { id: 'gpt-5', proxy: 'http://first-proxy.example:8080' },
                { id: 'gpt-5', proxy: 'noproxy' }
            ],
            expected: 'noproxy'
        },
        {
            name: 'a later entry does not define the proxy',
            models: [
                { id: 'gpt-5', proxy: 'noproxy' },
                { id: 'gpt-5', maxOutputTokens: 42 }
            ],
            expected: 'noproxy'
        },
        {
            name: 'a later endpoint replaces noproxy',
            models: [
                { id: 'gpt-5', proxy: 'noproxy' },
                { id: 'gpt-5', proxy: 'http://last-proxy.example:8080' }
            ],
            expected: 'http://last-proxy.example:8080'
        },
        {
            name: 'a later empty proxy remains explicit',
            models: [
                { id: 'gpt-5', proxy: 'noproxy' },
                { id: 'gpt-5', proxy: '' }
            ],
            expected: undefined
        },
        {
            name: 'a differently cased model cannot replace the proxy',
            models: [
                { id: 'gpt-5', proxy: 'noproxy' },
                { id: 'GPT-5', proxy: '' }
            ],
            expected: 'noproxy'
        },
        {
            name: 'entries without a proxy retain the provider fallback',
            models: [
                { id: 'gpt-5', maxOutputTokens: 42 },
                { id: 'gpt-5', maxInputTokens: 4096 }
            ],
            expected: 'http://synchronized-provider-proxy.example:8080'
        }
    ]) {
        test(`preserves synchronized model proxy merge order when ${name}`, () => {
            const providerOverrides: GCMPConfig['providerOverrides'] = {
                codex: { proxy: 'http://synchronized-provider-proxy.example:8080', models }
            };
            const originalOverrides = structuredClone(providerOverrides);
            withConfig(createConfig({}, providerOverrides), () => {
                assert.equal(ConfigManager.resolveProxyForModel({ id: 'gpt-5' }, 'codex'), expected);
                assert.equal(ConfigManager.resolveProxyForModel({ model: 'gpt-5' }, 'codex'), expected);
            });
            assert.deepEqual(providerOverrides, originalOverrides);
        });
    }

    test('machine provider proxy takes precedence over synchronized model and provider proxies', () => {
        const providerOverrides: GCMPConfig['providerOverrides'] = {
            Acme: {
                proxy: 'http://synchronized-provider-proxy.example:8080',
                models: [{ id: 'acme-model', proxy: 'http://synchronized-model-proxy.example:8080' }]
            }
        };

        withConfig(
            createConfig({ Acme: { proxy: 'http://machine-provider-proxy.example:8080' } }, providerOverrides),
            () => {
                assert.equal(
                    ConfigManager.resolveProxyForModel({ id: 'acme-model', provider: 'Acme' }, 'compatible'),
                    'http://machine-provider-proxy.example:8080'
                );
            }
        );
    });

    test('redacts credentials from nested machine proxy overrides in config logs', () => {
        const sanitized = sanitizeConfigForLogging({
            machineOverrides: {
                codex: {
                    proxy: 'http://provider-user:provider-secret@proxy.example:8080',
                    models: [
                        {
                            id: 'gpt-5',
                            proxy: 'http://model-user:model-secret@proxy.example:8081'
                        }
                    ]
                }
            },
            providerOverrides: {
                codex: {
                    proxy: 'http://synchronized-user:synchronized-secret@proxy.example:8082'
                }
            }
        });

        assert.equal(sanitized.machineOverrides.codex.proxy, 'http://proxy.example:8080/');
        assert.equal(sanitized.machineOverrides.codex.models[0].proxy, 'http://proxy.example:8081/');
        assert.equal(sanitized.providerOverrides.codex.proxy, 'http://proxy.example:8082/');
    });

    test('redacts credentials from authenticated proxy shorthand in config logs', () => {
        const sanitized = sanitizeConfigForLogging({
            machineOverrides: {
                codex: {
                    proxy: 'provider-user:provider-secret@proxy.example:8080',
                    models: [{ id: 'gpt-5', proxy: 'model-user:model-secret@proxy.example:8081' }]
                }
            }
        });

        assert.equal(sanitized.machineOverrides.codex.proxy, 'http://proxy.example:8080/');
        assert.equal(sanitized.machineOverrides.codex.models[0].proxy, 'http://proxy.example:8081/');
    });

    test('authenticates and redacts password-only proxy URLs and shorthand', async () => {
        let targetRequests = 0;
        let expectedProxyAuthorization = '';
        const observedProxyAuthorization: string[] = [];
        const targetServer = http.createServer((_request, response) => {
            targetRequests++;
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('authenticated');
        });
        const proxyServer = http.createServer((_request, response) => {
            response.writeHead(501);
            response.end();
        });
        proxyServer.on('connect', (request, clientSocket, head) => {
            const proxyAuthorization = request.headers['proxy-authorization'] ?? '';
            observedProxyAuthorization.push(proxyAuthorization);
            if (proxyAuthorization !== expectedProxyAuthorization) {
                clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
                return;
            }

            const [host, rawPort] = (request.url ?? '').split(':');
            const upstreamSocket = net.connect(Number(rawPort), host, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length > 0) {
                    upstreamSocket.write(head);
                }
                upstreamSocket.pipe(clientSocket);
                clientSocket.pipe(upstreamSocket);
            });
            trackSocket(proxyServer, upstreamSocket);
            upstreamSocket.on('error', () => clientSocket.destroy());
            clientSocket.on('error', () => upstreamSocket.destroy());
            upstreamSocket.on('close', () => clientSocket.destroy());
            clientSocket.on('close', () => upstreamSocket.destroy());
        });

        try {
            const targetPort = await listenOnLoopback(targetServer);
            const proxyPort = await listenOnLoopback(proxyServer);
            const targetUrl = `http://127.0.0.1:${targetPort}/authenticated`;
            const cases = [
                { proxy: `http://:secret@127.0.0.1:${proxyPort}`, credentials: ':secret' },
                { proxy: `:p%40ss@127.0.0.1:${proxyPort}`, credentials: ':p@ss' }
            ];

            for (const { proxy, credentials } of cases) {
                expectedProxyAuthorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
                const proxiedFetch = createProxiedFetch(proxy);
                assert.equal(typeof proxiedFetch, 'function');
                assert.equal(sanitizeConfigForLogging({ proxy }).proxy, `http://127.0.0.1:${proxyPort}/`);
                const response = await proxiedFetch(targetUrl, { signal: AbortSignal.timeout(5_000) });
                assert.equal(await response.text(), 'authenticated');
            }

            assert.deepEqual(
                observedProxyAuthorization,
                cases.map(({ credentials }) => `Basic ${Buffer.from(credentials).toString('base64')}`)
            );
            assert.equal(targetRequests, cases.length);
        } finally {
            try {
                await Promise.all([closeServer(proxyServer), closeServer(targetServer)]);
            } finally {
                await closeProxyAgents();
            }
        }
    });

    test('does not expose credentials when an authenticated proxy cannot be parsed', () => {
        const sanitized = sanitizeConfigForLogging({
            machineOverrides: {
                codex: {
                    proxy: 'provider-user:provider-secret@proxy.example:99999',
                    models: [
                        {
                            id: 'gpt-5',
                            proxy: 'http://model-user:model-secret@proxy.example:99999'
                        }
                    ]
                }
            }
        });

        assert.equal(sanitized.machineOverrides.codex.proxy, '[invalid proxy URL]');
        assert.equal(sanitized.machineOverrides.codex.models[0].proxy, '[invalid proxy URL]');
    });

    test('rejects an invalid explicit proxy instead of falling back to system or direct networking', () => {
        for (const proxy of [
            'proxy-user:proxy-secret@proxy.example:99999',
            ':proxy-secret@proxy.example:99999',
            'http://:proxy-secret@proxy.example:65536'
        ]) {
            assert.throws(() => createProxiedFetch(proxy), {
                name: 'TypeError',
                message: 'Invalid proxy URL'
            });
        }
    });

    test('dynamic Schema accepts built-in sub-provider proxy keys', () => {
        const schema = JsonSchemaProvider.getSettingsSchema();
        const setting = schema.properties?.['gcmp.machineOverrides'] as ConfigurationSettingSchema | undefined;
        const providerSetting = schema.properties?.['gcmp.providerOverrides'] as
            | ProviderOverrideSettingsSchema
            | undefined;
        const compatibleSetting = schema.properties?.['gcmp.compatibleModels'] as
            | ConfigurationSettingSchema
            | undefined;

        assert.ok(setting?.propertyNames?.enum?.includes('dashscope-token'));
        assert.ok(setting?.propertyNames?.enum?.includes('dashscope-coding'));
        assert.ok(setting?.propertyNames?.enum?.includes('minimax-token'));
        assertProxyValueSchema(setting?.additionalProperties?.properties?.proxy, true);
        assertProxyValueSchema(setting?.additionalProperties?.properties?.models?.items?.properties?.proxy, false);
        assertProxyValueSchema(providerSetting?.patternProperties?.['^codex$']?.properties?.proxy, true);
        assertProxyValueSchema(
            providerSetting?.patternProperties?.['^codex$']?.properties?.models?.items?.properties?.proxy,
            true
        );
        assertProxyValueSchema(providerSetting?.patternProperties?.['^compatible$']?.properties?.proxy, true);
        assertProxyValueSchema(compatibleSetting?.items?.properties?.proxy, true);
    });
});
