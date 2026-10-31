import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { OAuthCredentials } from '../type';

const require = createRequire(import.meta.url);
const fsBuiltin = require('node:fs') as { readFileSync: (...args: unknown[]) => unknown };
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('OAuthCredentialStore 命名凭证管理', async t => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {};
        }
        if (/(?:^|\/)logger(?:\.ts)?$/.test(id)) {
            return {
                Logger: {
                    info: () => undefined,
                    warn: () => undefined,
                    error: () => undefined,
                    trace: () => undefined,
                    debug: () => undefined
                }
            };
        }
        if (/configManager(?:\.ts)?$/.test(id)) {
            return {
                ConfigManager: {
                    resolveProxyForModel: () => undefined,
                    // 动态委托：子测可临时替换 globalThis.fetch 拦截刷新请求
                    fetchWithProxy: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)
                }
            };
        }
        if (/proxyAgent(?:\.ts)?$/.test(id)) {
            return { isNoProxyValue: () => false };
        }
        return originalRequire.call(this, id);
    };

    let OAuthCredentialStore: typeof import('./oauthCredentialStore').OAuthCredentialStore;
    let CodexCliAuth: typeof import('./codexCliAuth').CodexCliAuth;
    let GrokCliAuth: typeof import('./grokCliAuth').GrokCliAuth;
    let BaseCliAuth: typeof import('./baseCliAuth').BaseCliAuth;
    try {
        ({ OAuthCredentialStore } = await import('./oauthCredentialStore'));
        ({ CodexCliAuth } = await import('./codexCliAuth'));
        ({ GrokCliAuth } = await import('./grokCliAuth'));
        ({ BaseCliAuth } = await import('./baseCliAuth'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-oauth-test-'));
    const oauthDir = path.join(rootDir, 'oauth');

    t.after(() => {
        BaseCliAuth.setCredentialPathOverride(undefined);
        OAuthCredentialStore.resetForTests();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    await t.test('校验凭证名', () => {
        assert.equal(OAuthCredentialStore.isValidCredentialName('work'), true);
        assert.equal(OAuthCredentialStore.isValidCredentialName('user@example.com'), true);
        assert.equal(OAuthCredentialStore.isValidCredentialName('a_b-c.d'), true);
        assert.equal(OAuthCredentialStore.isValidCredentialName(''), false);
        assert.equal(OAuthCredentialStore.isValidCredentialName('-lead'), false);
        assert.equal(OAuthCredentialStore.isValidCredentialName('bad/name'), false);
        assert.equal(OAuthCredentialStore.isValidCredentialName('bad name'), false);
        assert.equal(OAuthCredentialStore.isValidCredentialName('a'.repeat(65)), false);
    });

    await t.test('扫描并解析凭证：确定性回退与内容信息', async () => {
        fs.mkdirSync(oauthDir, { recursive: true });
        fs.writeFileSync(
            path.join(oauthDir, 'codex-beta.json'),
            JSON.stringify({ type: 'codex', access_token: 'beta-token', expiry_date: Date.now() + 3600_000 })
        );
        fs.writeFileSync(
            path.join(oauthDir, 'codex-alpha.json'),
            JSON.stringify({ type: 'codex', access_token: 'alpha-token', label: '主账号' })
        );
        fs.writeFileSync(
            path.join(oauthDir, 'grok-main.json'),
            JSON.stringify({ type: 'grok', access_token: 'grok-token' })
        );
        fs.writeFileSync(path.join(oauthDir, 'codex-broken.json'), 'not-json');
        fs.writeFileSync(path.join(oauthDir, 'notes.json'), '{}'); // 无 provider 前缀
        fs.writeFileSync(path.join(oauthDir, 'codex-bad name.json'), '{}'); // 名部分含空格：不做结构校验，仍识别
        fs.writeFileSync(path.join(oauthDir, 'codex-zz12345-user@example.com-team-plan.json'), '{}'); // CPA 风格复合名

        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir });

        // 识别仅以第一个 - 前缀判定 provider，其余整体作为不透明凭证名
        const codexEntries = OAuthCredentialStore.listCredentials('codex');
        assert.deepEqual(
            codexEntries.map(entry => entry.name),
            ['alpha', 'bad name', 'beta', 'broken', 'zz12345-user@example.com-team-plan']
        );
        const byName = new Map(codexEntries.map(entry => [entry.name, entry]));
        assert.equal(byName.get('alpha')?.label, '主账号');
        assert.equal(byName.get('alpha')?.hasAccessToken, true);
        assert.ok(byName.get('beta')?.expiryDate);
        assert.equal(byName.get('broken')?.hasAccessToken, false); // 解析失败仍列出并标记

        assert.deepEqual(
            OAuthCredentialStore.listCredentials('grok').map(entry => entry.name),
            ['main']
        );
        assert.deepEqual(OAuthCredentialStore.listCredentials('claude'), []);

        // 未手工指定：按名称排序取第一份
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'alpha');
        assert.equal(
            OAuthCredentialStore.resolveActiveCredentialPath('codex'),
            path.join(oauthDir, 'codex-alpha.json')
        );
        // oauth 无该 provider 凭证：返回 undefined（调用方回退 CLI 默认目录）
        assert.equal(OAuthCredentialStore.resolveActiveCredentialPath('claude'), undefined);

        // CPA 风格复合名可作为整体被选中并解析
        await OAuthCredentialStore.setActiveCredential('codex', 'zz12345-user@example.com-team-plan');
        assert.equal(
            OAuthCredentialStore.resolveActiveCredentialPath('codex'),
            path.join(oauthDir, 'codex-zz12345-user@example.com-team-plan.json')
        );
    });

    await t.test('活跃选择持久化：重新初始化后仍生效', async () => {
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir });

        await OAuthCredentialStore.setActiveCredential('codex', 'beta');
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'beta');
        const selectionBeforeRestart = OAuthCredentialStore.getActiveCredentialSelection('codex');

        // 模拟另一窗口：重置内存状态后从 active.json 恢复
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir });
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'beta');
        assert.deepEqual(OAuthCredentialStore.getActiveCredentialSelection('codex'), selectionBeforeRestart);

        // 指定项已不存在：回退到排序后的第一份
        await OAuthCredentialStore.setActiveCredential('codex', 'ghost');
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'alpha');
    });

    await t.test('路由模式和账号权重持久化，删除账号时清除权重', async () => {
        const routingDir = path.join(rootDir, 'routing-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: routingDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'alpha', { access_token: 'a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'beta', { access_token: 'b' });

        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), { mode: 'off', weights: {}, generation: 0 });
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', 'alpha'), 1);
        await assert.rejects(OAuthCredentialStore.setCredentialWeight('codex', 'alpha', 101), /weight/i);
        await OAuthCredentialStore.setCredentialWeight('codex', 'alpha', 0);
        await OAuthCredentialStore.setRoutingMode('codex', 'balance');
        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), {
            mode: 'balance',
            weights: { alpha: 0 },
            generation: 2
        });

        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: routingDir });
        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), {
            mode: 'balance',
            weights: { alpha: 0 },
            generation: 2
        });
        await OAuthCredentialStore.deleteCredentialFile('codex', 'alpha');
        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), {
            mode: 'balance',
            weights: {},
            generation: 3
        });
    });

    await t.test('路由权重支持手工凭证名且安全处理原型键', async () => {
        const manualNameDir = path.join(rootDir, 'routing-manual-name-oauth');
        fs.mkdirSync(manualNameDir, { recursive: true });
        fs.writeFileSync(path.join(manualNameDir, 'codex-manual account.json'), JSON.stringify({ access_token: 'a' }));
        fs.writeFileSync(path.join(manualNameDir, 'codex-__proto__.json'), JSON.stringify({ access_token: 'b' }));
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: manualNameDir });

        await OAuthCredentialStore.setCredentialWeight('codex', 'manual account', 0);
        await OAuthCredentialStore.setCredentialWeight('codex', '__proto__', 0);

        const settings = OAuthCredentialStore.getRoutingSettings('codex');
        assert.equal(Object.getPrototypeOf(settings.weights), Object.prototype);
        assert.equal(Object.hasOwn(settings.weights, 'manual account'), true);
        assert.equal(Object.hasOwn(settings.weights, '__proto__'), true);
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', 'manual account'), 0);
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', '__proto__'), 0);

        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: manualNameDir });
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', 'manual account'), 0);
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', '__proto__'), 0);
    });

    await t.test('路由设置读取其他窗口更新的文件内容', async () => {
        const routingDir = path.join(rootDir, 'routing-window-sync-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: routingDir });
        assert.equal(OAuthCredentialStore.getRoutingSettings('codex').mode, 'off');

        fs.mkdirSync(routingDir, { recursive: true });
        fs.writeFileSync(
            path.join(routingDir, 'routing.json'),
            JSON.stringify({ providers: { codex: { mode: 'balance', weights: { alpha: 4 }, generation: 7 } } })
        );

        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), {
            mode: 'balance',
            weights: { alpha: 4 },
            generation: 7
        });
        assert.equal(OAuthCredentialStore.getCredentialWeight('codex', 'alpha'), 4);
    });

    await t.test('并发设置路由模式和权重时保持 failover 资格不变量', async () => {
        const concurrentRoutingDir = path.join(rootDir, 'concurrent-routing-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: concurrentRoutingDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'alpha', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'beta', { access_token: 'token-b' });

        const results = await Promise.allSettled([
            OAuthCredentialStore.setRoutingMode('codex', 'failover'),
            OAuthCredentialStore.setCredentialWeight('codex', 'alpha', 0)
        ]);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);

        const settings = OAuthCredentialStore.getRoutingSettings('codex');
        const eligibleCount = OAuthCredentialStore.listCredentials('codex').filter(
            entry => entry.hasAccessToken && (settings.weights[entry.name] ?? 1) > 0
        ).length;
        assert.ok(settings.mode === 'off' || eligibleCount >= 2);
    });

    await t.test('删除账号后 failover 不再满足最少账号数时关闭路由', async () => {
        const failoverDir = path.join(rootDir, 'routing-failover-delete-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: failoverDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'alpha', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'beta', { access_token: 'token-b' });
        await OAuthCredentialStore.setRoutingMode('codex', 'failover');

        await OAuthCredentialStore.deleteCredentialFile('codex', 'beta');

        assert.deepEqual(OAuthCredentialStore.getRoutingSettings('codex'), {
            mode: 'off',
            weights: {},
            generation: 2
        });
    });

    await t.test('保存与删除凭证文件', async () => {
        const missingDir = path.join(rootDir, 'missing-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: missingDir });
        assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'missing'), false);

        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir });

        const filePath = await OAuthCredentialStore.saveCredentialFile('codex', 'work', {
            type: 'codex',
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 123
        });
        assert.equal(filePath, path.join(oauthDir, 'codex-work.json'));
        assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), {
            type: 'codex',
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 123
        });

        await assert.rejects(
            () => OAuthCredentialStore.saveCredentialFile('codex', 'bad/name', {}),
            /Invalid credential name/
        );

        // 删除活跃凭证后清除选择，回退到剩余凭证的第一份
        await OAuthCredentialStore.setActiveCredential('codex', 'work');
        assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'work'), true);
        assert.equal(fs.existsSync(filePath), false);
        assert.notEqual(OAuthCredentialStore.getActiveCredentialName('codex'), 'work');
        assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'work'), false);
    });

    await t.test('详细删除回执报告锁内有效活跃账号', async () => {
        const statusDir = path.join(rootDir, 'delete-status-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: statusDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });

        assert.deepEqual(await OAuthCredentialStore.deleteCredentialFileWithStatus('codex', 'a'), {
            deleted: true,
            wasActive: true
        });

        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.setActiveCredential('codex', 'b');
        assert.deepEqual(await OAuthCredentialStore.deleteCredentialFileWithStatus('codex', 'a'), {
            deleted: true,
            wasActive: false
        });
        assert.deepEqual(await OAuthCredentialStore.deleteCredentialFileWithStatus('codex', 'missing'), {
            deleted: false,
            wasActive: false
        });
    });

    await t.test('活跃凭证副作用检查与执行期间串行化选择变更', async () => {
        const guardDir = path.join(rootDir, 'active-guard-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: guardDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        const order: string[] = [];
        let enterAction!: () => void;
        let releaseAction!: () => void;
        const actionEntered = new Promise<void>(resolve => {
            enterAction = resolve;
        });
        const actionGate = new Promise<void>(resolve => {
            releaseAction = resolve;
        });
        const initialSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');
        const guardedAction = OAuthCredentialStore.runIfActiveCredential('codex', initialSelection, async () => {
            enterAction();
            await actionGate;
            order.push('key');
        });

        await actionEntered;
        const selectionChange = OAuthCredentialStore.setActiveCredential('codex', 'b').then(() => {
            order.push('selection');
        });
        assert.deepEqual([...order], []);
        releaseAction();

        assert.equal(await guardedAction, true);
        await selectionChange;
        assert.deepEqual([...order], ['key', 'selection']);

        assert.equal(
            await OAuthCredentialStore.runIfActiveCredential('codex', initialSelection, async () => {
                order.push('stale-key');
            }),
            false
        );
        assert.deepEqual([...order], ['key', 'selection']);

        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        assert.equal(
            await OAuthCredentialStore.runIfActiveCredential('codex', initialSelection, async () => {
                order.push('aba-stale-key');
            }),
            false
        );
        assert.deepEqual([...order], ['key', 'selection']);
    });

    await t.test('条件切换拒绝覆盖已经变化的活跃选择', async () => {
        const conditionalDir = path.join(rootDir, 'conditional-selection-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: conditionalDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        const staleSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');

        await OAuthCredentialStore.setActiveCredential('codex', 'b');
        assert.equal(await OAuthCredentialStore.setActiveCredentialIfCurrent('codex', staleSelection, 'a'), undefined);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'b');
    });

    await t.test('其他 provider 的选择变化不使当前 provider 的 generation 失效', async () => {
        const providerIsolationDir = path.join(rootDir, 'provider-isolation-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: providerIsolationDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'codex-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'codex-b' });
        await OAuthCredentialStore.saveCredentialFile('grok', 'a', { access_token: 'grok-a' });
        await OAuthCredentialStore.saveCredentialFile('grok', 'b', { access_token: 'grok-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        await OAuthCredentialStore.setActiveCredential('grok', 'a');
        const codexSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');

        const selectionPath = path.join(providerIsolationDir, 'active.json');
        const activeSelection = JSON.parse(fs.readFileSync(selectionPath, 'utf-8')) as Record<string, unknown>;
        const generations = JSON.parse(String(activeSelection.__gcmp_active_selection_generations_v1__)) as Record<
            string,
            number
        >;
        activeSelection.grok = 'b';
        generations.grok = (generations.grok ?? 0) + 1;
        activeSelection.__gcmp_active_selection_generations_v1__ = JSON.stringify(generations);
        fs.writeFileSync(selectionPath, JSON.stringify(activeSelection));

        assert.deepEqual(OAuthCredentialStore.getActiveCredentialSelection('codex'), codexSelection);
        let actionRan = false;
        assert.equal(
            await OAuthCredentialStore.runIfActiveCredential('codex', codexSelection, async () => {
                actionRan = true;
            }),
            true
        );
        assert.equal(actionRan, true);
    });

    await t.test('条件切换拒绝已经删除的目标账号', async () => {
        const deletedTargetDir = path.join(rootDir, 'conditional-deleted-target-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: deletedTargetDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        const expectedSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');
        await OAuthCredentialStore.deleteCredentialFile('codex', 'b');

        assert.equal(
            await OAuthCredentialStore.setActiveCredentialIfCurrent('codex', expectedSelection, 'b'),
            undefined
        );
        assert.deepEqual(OAuthCredentialStore.getActiveCredentialSelection('codex'), expectedSelection);
    });

    await t.test('条件切换拒绝跨窗口切换后回到同一账号的旧快照', async () => {
        const abaDir = path.join(rootDir, 'selection-aba-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: abaDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        const staleSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');

        const selectionPath = path.join(abaDir, 'active.json');
        const externalState = JSON.parse(fs.readFileSync(selectionPath, 'utf-8')) as Record<string, unknown>;
        const generations = JSON.parse(String(externalState.__gcmp_active_selection_generations_v1__)) as Record<
            string,
            number
        >;
        externalState.codex = 'b';
        generations.codex += 1;
        externalState.codex = 'a';
        generations.codex += 1;
        externalState.__gcmp_active_selection_generations_v1__ = JSON.stringify(generations);
        fs.writeFileSync(selectionPath, JSON.stringify(externalState));

        assert.deepEqual(OAuthCredentialStore.getActiveCredentialSelection('codex'), {
            name: 'a',
            generation: staleSelection.generation + 2
        });
        assert.equal(await OAuthCredentialStore.setActiveCredentialIfCurrent('codex', staleSelection, 'b'), undefined);
        assert.equal(await OAuthCredentialStore.runIfActiveCredential('codex', staleSelection, async () => {}), false);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');
    });

    await t.test('旧版平铺读写保留选择并使旧 ABA 快照失效', async () => {
        const compatibilityDir = path.join(rootDir, 'legacy-active-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: compatibilityDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        const staleSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');
        const selectionPath = path.join(compatibilityDir, 'active.json');

        const legacyWriteSelection = async (name: string) => {
            const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf-8')) as Record<string, unknown>;
            const legacyState = Object.fromEntries(
                Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            );
            legacyState.codex = name;
            const tempPath = `${selectionPath}.${name}.${Date.now()}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(legacyState));
            fs.renameSync(tempPath, selectionPath);
        };

        await legacyWriteSelection('b');
        await legacyWriteSelection('a');

        const currentSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');
        assert.equal(currentSelection.name, 'a');
        assert.ok(currentSelection.generation > staleSelection.generation);
        assert.equal(await OAuthCredentialStore.setActiveCredentialIfCurrent('codex', staleSelection, 'b'), undefined);
        assert.equal(await OAuthCredentialStore.runIfActiveCredential('codex', staleSelection, async () => {}), false);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');
    });

    await t.test('active.json 内容和 revision 使用同一文件版本', async () => {
        const raceDir = path.join(rootDir, 'selection-read-race-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: raceDir });
        await OAuthCredentialStore.saveCredentialFile('codex', 'a', { access_token: 'token-a' });
        await OAuthCredentialStore.saveCredentialFile('codex', 'b', { access_token: 'token-b' });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: raceDir });

        const selectionPath = path.join(raceDir, 'active.json');
        const originalReadFileSync = fsBuiltin.readFileSync;
        let externalWritesCompleted = false;
        fsBuiltin.readFileSync = (...args: unknown[]) => {
            const content = originalReadFileSync(...args);
            if (!externalWritesCompleted && (args[0] === selectionPath || typeof args[0] === 'number')) {
                externalWritesCompleted = true;
                for (const name of ['b', 'a']) {
                    const current = JSON.parse(fs.readFileSync(selectionPath, 'utf-8')) as Record<string, unknown>;
                    const legacyState = Object.fromEntries(
                        Object.entries(current).filter(
                            (entry): entry is [string, string] => typeof entry[1] === 'string'
                        )
                    );
                    legacyState.codex = name;
                    const tempPath = `${selectionPath}.${name}.tmp`;
                    fs.writeFileSync(tempPath, JSON.stringify(legacyState));
                    fs.renameSync(tempPath, selectionPath);
                }
            }
            return content;
        };
        syncBuiltinESMExports();
        try {
            const staleSelection = OAuthCredentialStore.getActiveCredentialSelection('codex');
            assert.equal(externalWritesCompleted, true);
            assert.equal(staleSelection.name, 'a');
            assert.equal(
                await OAuthCredentialStore.setActiveCredentialIfCurrent('codex', staleSelection, 'b'),
                undefined
            );
            assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');
        } finally {
            fsBuiltin.readFileSync = originalReadFileSync;
            syncBuiltinESMExports();
        }
    });

    await t.test('CodexCliAuth 使用 oauth 凭证并保持平铺格式保存', async () => {
        const isolatedDir = path.join(rootDir, 'isolated-oauth');
        fs.mkdirSync(isolatedDir, { recursive: true });
        const flatFile = path.join(isolatedDir, 'codex-flat.json');
        fs.writeFileSync(
            flatFile,
            JSON.stringify({
                type: 'codex',
                label: '保留字段',
                access_token: 'flat-token',
                refresh_token: 'flat-refresh',
                expiry_date: 1000,
                account_id: 'acct-1'
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: isolatedDir });

        const auth = new CodexCliAuth();
        assert.equal(auth.isOAuthCredentialActive(), true);
        assert.equal(auth.getCredentialPath(), flatFile);

        const credentials = await auth.loadCredentials();
        assert.equal(credentials?.access_token, 'flat-token');
        assert.equal((credentials as { account_id?: string } | null)?.account_id, 'acct-1');

        // 刷新后的保存走归一化平铺格式：覆盖令牌字段、保留既有无关字段
        class TestAuth extends CodexCliAuth {
            save(record: Record<string, unknown>): Promise<void> {
                return (
                    this as unknown as { saveCredentials(c: Record<string, unknown>): Promise<void> }
                ).saveCredentials(record);
            }
        }
        const testAuth = new TestAuth();
        await testAuth.save({ access_token: 'new-token', refresh_token: 'new-refresh', expiry_date: 2000 });
        const saved = JSON.parse(fs.readFileSync(flatFile, 'utf-8')) as Record<string, unknown>;
        assert.equal(saved.type, 'codex');
        assert.equal(saved.label, '保留字段');
        assert.equal(saved.account_id, 'acct-1');
        assert.equal(saved.access_token, 'new-token');
        assert.equal(saved.refresh_token, 'new-refresh');
        assert.equal(saved.expiry_date, 2000);
    });

    await t.test('CodexCliAuth 构建导入记录并选择性移除 CLI 原生凭证', async () => {
        const auth = new CodexCliAuth();
        // 先赋值为变量再传入，避免对象字面量超额属性检查（account_id 为 Codex 扩展字段）
        const codexCredentials = { access_token: 'a', refresh_token: 'r', expiry_date: 5, account_id: 'acct' };
        const record = auth.toOAuthStoreRecord(codexCredentials);
        assert.deepEqual(record, {
            type: 'codex',
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 5,
            account_id: 'acct'
        });

        // 移除仅针对 tokens/last_refresh，保留 OPENAI_API_KEY 等无关字段
        const cliFile = path.join(rootDir, 'fake-codex-auth.json');
        fs.writeFileSync(
            cliFile,
            JSON.stringify({ OPENAI_API_KEY: 'sk-key', tokens: { access_token: 'x' }, last_refresh: '2026-01-01' })
        );
        BaseCliAuth.setCredentialPathOverride(cliFile);
        await auth.removeCliNativeCredential();
        assert.deepEqual(JSON.parse(fs.readFileSync(cliFile, 'utf-8')), { OPENAI_API_KEY: 'sk-key' });

        // 仅含 OAuth 字段的文件整体删除
        fs.writeFileSync(cliFile, JSON.stringify({ tokens: { access_token: 'x' }, last_refresh: 'y' }));
        await auth.removeCliNativeCredential();
        assert.equal(fs.existsSync(cliFile), false);
        BaseCliAuth.setCredentialPathOverride(undefined);
    });

    await t.test('GrokCliAuth 加载 oauth 平铺凭证并附带扩展字段导出', async () => {
        const grokDir = path.join(rootDir, 'grok-oauth');
        fs.mkdirSync(grokDir, { recursive: true });
        const flatFile = path.join(grokDir, 'grok-main.json');
        fs.writeFileSync(
            flatFile,
            JSON.stringify({
                type: 'grok',
                access_token: 'grok-token',
                refresh_token: 'grok-refresh',
                expiry_date: 3000,
                oidc_client_id: 'oidc-1'
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: grokDir });

        const auth = new GrokCliAuth();
        assert.equal(auth.isOAuthCredentialActive(), true);
        const credentials = await auth.loadCredentials();
        assert.equal(credentials?.access_token, 'grok-token');
        assert.equal((credentials as { oidc_client_id?: string } | null)?.oidc_client_id, 'oidc-1');

        const grokCredentials = {
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 1,
            oidc_client_id: 'c',
            email: 'e'
        };
        assert.deepEqual(auth.toOAuthStoreRecord(grokCredentials), {
            type: 'grok',
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 1,
            oidc_client_id: 'c',
            email: 'e'
        });
    });

    await t.test('GrokCliAuth 仅移除当前使用的认证记录', async () => {
        const cliFile = path.join(rootDir, 'fake-grok-auth.json');
        fs.writeFileSync(
            cliFile,
            JSON.stringify({
                'https://auth.x.ai::client-1': { key: 'k1', refresh_token: 'r1' },
                'https://auth.x.ai::client-2': { key: 'k2' }
            })
        );
        BaseCliAuth.setCredentialPathOverride(cliFile);
        const auth = new GrokCliAuth();
        await auth.removeCliNativeCredential();
        const remaining = JSON.parse(fs.readFileSync(cliFile, 'utf-8')) as Record<string, unknown>;
        assert.deepEqual(Object.keys(remaining), ['https://auth.x.ai::client-2']);
        BaseCliAuth.setCredentialPathOverride(undefined);
    });

    /** 自造 JWT（仅测试用，签名段为空） */
    const makeJwt = (payload: Record<string, unknown>): string => {
        const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
    };
    const sha256Prefix8 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

    await t.test('CodexCliAuth 按账号身份派生凭证名（同 CLIProxyAPI）', async () => {
        const accountId = 'acc-123';
        const expectedHash = sha256Prefix8(accountId);
        const idToken = makeJwt({
            email: 'user@example.com',
            'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'Team Plan' }
        });
        const cliFile = path.join(rootDir, 'fake-codex-identity.json');
        fs.writeFileSync(
            cliFile,
            JSON.stringify({
                tokens: { access_token: 'x', refresh_token: 'y', id_token: idToken },
                last_refresh: '2026-01-01'
            })
        );
        BaseCliAuth.setCredentialPathOverride(cliFile);
        try {
            const auth = new CodexCliAuth();
            const credentials = await auth.loadCliNativeCredentials();
            assert.ok(credentials);
            // 从 id_token 提取账号身份
            assert.equal((credentials as { email?: string }).email, 'user@example.com');
            assert.equal((credentials as { plan_type?: string }).plan_type, 'Team Plan');
            assert.equal((credentials as { account_id?: string }).account_id, accountId);
            // 完整身份：<hash8>-<email>-<归一化plan>
            assert.equal(auth.suggestCredentialName(credentials), `${expectedHash}-user@example.com-team-plan`);
            // 导入记录附带身份字段
            const record = auth.toOAuthStoreRecord(credentials);
            assert.equal(record.email, 'user@example.com');
            assert.equal(record.plan_type, 'Team Plan');
        } finally {
            BaseCliAuth.setCredentialPathOverride(undefined);
        }

        const auth = new CodexCliAuth();
        // 无 plan：省略 plan 段
        const noPlan = {
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 1,
            account_id: accountId,
            email: 'user@example.com'
        };
        assert.equal(auth.suggestCredentialName(noPlan), `${expectedHash}-user@example.com`);
        // 无 account_id：仅 email(-plan)
        const noAccount = {
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 1,
            email: 'user@example.com',
            plan_type: 'plus'
        };
        assert.equal(auth.suggestCredentialName(noAccount), 'user@example.com-plus');
        // 非法字符替换为 _
        const plusEmail = { access_token: 'a', refresh_token: 'r', expiry_date: 1, email: 'user+tag@example.com' };
        assert.equal(auth.suggestCredentialName(plusEmail), 'user_tag@example.com');
        // 无身份：回退令牌哈希 account-<hash8>
        const bare = { access_token: 'a', refresh_token: 'refresh-x', expiry_date: 1 };
        assert.equal(auth.suggestCredentialName(bare), `account-${sha256Prefix8('refresh-x')}`);
        // 超长 email：截断 email 段，保留账号哈希与 plan 后缀，总长 ≤64
        const longEmail = {
            access_token: 'a',
            refresh_token: 'r',
            expiry_date: 1,
            account_id: accountId,
            email: `${'u'.repeat(80)}@example.com`,
            plan_type: 'pro'
        };
        const longName = auth.suggestCredentialName(longEmail);
        assert.ok(longName.length <= 64, `name too long: ${longName.length}`);
        assert.ok(longName.startsWith(`${expectedHash}-`), `account hash lost: ${longName}`);
        assert.ok(longName.endsWith('-pro'), `plan suffix lost: ${longName}`);
        // 派生名均满足凭证名规则
        for (const name of [
            `${expectedHash}-user@example.com-team-plan`,
            auth.suggestCredentialName(noPlan),
            auth.suggestCredentialName(noAccount),
            auth.suggestCredentialName(bare)
        ]) {
            assert.equal(OAuthCredentialStore.isValidCredentialName(name), true, `invalid name: ${name}`);
        }
    });

    await t.test('GrokCliAuth 按 email/user_id 派生凭证名（同 CLIProxyAPI xai）', () => {
        const auth = new GrokCliAuth();
        const withEmail = { access_token: 'a', refresh_token: 'r', expiry_date: 1, email: 'dev@x.ai' };
        assert.equal(auth.suggestCredentialName(withEmail), 'dev@x.ai');
        const withUserId = { access_token: 'a', refresh_token: 'r', expiry_date: 1, user_id: 'u-1' };
        assert.equal(auth.suggestCredentialName(withUserId), 'u-1');
        const bare = { access_token: 'a', refresh_token: 'refresh-y', expiry_date: 1 };
        assert.equal(auth.suggestCredentialName(bare), `account-${sha256Prefix8('refresh-y')}`);
    });

    await t.test('手工放置的凭证文件不经 store API 写入也可被识别（目录 mtime 缓存失效）', () => {
        const manualDir = path.join(rootDir, 'manual-oauth');
        fs.mkdirSync(manualDir, { recursive: true });
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: manualDir });
        assert.deepEqual(OAuthCredentialStore.listCredentials('codex'), []);

        // 模拟手工放置/其他窗口写入：直接写文件并推进目录 mtime
        fs.writeFileSync(path.join(manualDir, 'codex-placed.json'), JSON.stringify({ access_token: 't' }));
        const bumped = new Date(Date.now() + 5000);
        fs.utimesSync(manualDir, bumped, bumped);

        assert.deepEqual(
            OAuthCredentialStore.listCredentials('codex').map(entry => entry.name),
            ['placed']
        );
    });

    await t.test('active.json 内容变化即重载（即使 mtime 相同），损坏时回退排序首个', async () => {
        const syncDir = path.join(rootDir, 'sync-oauth');
        fs.mkdirSync(syncDir, { recursive: true });
        fs.writeFileSync(path.join(syncDir, 'codex-a.json'), '{}');
        fs.writeFileSync(path.join(syncDir, 'codex-b.json'), '{}');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: syncDir });

        await OAuthCredentialStore.setActiveCredential('codex', 'a');
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');

        // 模拟另一窗口直接改写 active.json，同时保留原 mtime
        const selectionFile = path.join(syncDir, 'active.json');
        const fixedTime = new Date(1_700_000_000_000);
        fs.utimesSync(selectionFile, fixedTime, fixedTime);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');
        const previousStat = fs.statSync(selectionFile);
        fs.writeFileSync(selectionFile, JSON.stringify({ codex: 'b' }));
        fs.utimesSync(selectionFile, fixedTime, fixedTime);
        assert.equal(fs.statSync(selectionFile).mtimeMs, previousStat.mtimeMs);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'b');

        // active.json 损坏：视为无选择，回退排序后的第一份
        const sameMtime = fs.statSync(selectionFile);
        fs.writeFileSync(selectionFile, 'not-json');
        fs.utimesSync(selectionFile, fixedTime, fixedTime);
        assert.equal(fs.statSync(selectionFile).mtimeMs, sameMtime.mtimeMs);
        assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'a');
    });

    await t.test('并发更新不同 provider 的活跃选择时不丢失另一项', async () => {
        const concurrentDir = path.join(rootDir, 'concurrent-oauth');
        fs.mkdirSync(concurrentDir, { recursive: true });
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: concurrentDir });

        await Promise.all([
            OAuthCredentialStore.setActiveCredential('codex', 'codex-account'),
            OAuthCredentialStore.setActiveCredential('grok', 'grok-account')
        ]);

        const activeSelection = JSON.parse(fs.readFileSync(path.join(concurrentDir, 'active.json'), 'utf-8')) as Record<
            string,
            unknown
        >;
        assert.deepEqual(
            { codex: activeSelection.codex, grok: activeSelection.grok },
            { codex: 'codex-account', grok: 'grok-account' }
        );
        assert.deepEqual(JSON.parse(String(activeSelection.__gcmp_active_selection_generations_v1__)), {
            codex: 1,
            grok: 1
        });
    });

    await t.test('活跃选择锁可回收死进程留下的锁目录', async () => {
        const recoveryDir = path.join(rootDir, 'recovery-oauth');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const deadProcess = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
        assert.equal(deadProcess.status, 0);
        assert.equal(typeof deadProcess.pid, 'number');
        const deadPid = deadProcess.pid as number;
        assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });

        const lockDir = path.join(recoveryDir, 'active.selection.lock');
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid, token: 'dead-owner' }));
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: recoveryDir });

        await OAuthCredentialStore.setActiveCredential('codex', 'recovered');

        const activeSelection = JSON.parse(fs.readFileSync(path.join(recoveryDir, 'active.json'), 'utf-8')) as Record<
            string,
            unknown
        >;
        assert.equal(activeSelection.codex, 'recovered');
        assert.deepEqual(JSON.parse(String(activeSelection.__gcmp_active_selection_generations_v1__)), { codex: 1 });
        assert.equal(fs.existsSync(lockDir), false);
        assert.equal(fs.existsSync(`${lockDir}.reclaim`), false);
    });

    await t.test('loadCredentials 缓存按路径绑定：切换活跃凭证后不经工厂失效也重载新文件', async () => {
        const switchDir = path.join(rootDir, 'switch-oauth');
        fs.mkdirSync(switchDir, { recursive: true });
        fs.writeFileSync(
            path.join(switchDir, 'codex-a.json'),
            JSON.stringify({ type: 'codex', access_token: 'token-a', refresh_token: 'r', expiry_date: 1 })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: switchDir });

        const auth = new CodexCliAuth();
        assert.equal((await auth.loadCredentials())?.access_token, 'token-a');

        // 模拟跨窗口切换：仅 active.json 变化，本进程实例缓存未失效，路径变化强制重载
        fs.writeFileSync(
            path.join(switchDir, 'codex-b.json'),
            JSON.stringify({ type: 'codex', access_token: 'token-b', refresh_token: 'r', expiry_date: 1 })
        );
        await OAuthCredentialStore.setActiveCredential('codex', 'b');
        assert.equal((await auth.loadCredentials())?.access_token, 'token-b');
    });

    await t.test('oauth 文件夹仅含其他 provider 凭证时回退 CLI 默认目录', () => {
        BaseCliAuth.setCredentialPathOverride(undefined);
        const otherDir = path.join(rootDir, 'other-oauth');
        fs.mkdirSync(otherDir, { recursive: true });
        fs.writeFileSync(path.join(otherDir, 'grok-main.json'), JSON.stringify({ access_token: 'g' }));
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: otherDir });

        const auth = new CodexCliAuth();
        assert.equal(auth.isOAuthCredentialActive(), false);
        assert.equal(auth.getCredentialPath(), path.join(os.homedir(), '.codex', 'auth.json'));
    });

    await t.test('BaseCliAuth 默认移除实现删除整个 CLI 原生凭证文件', async () => {
        class TestCliAuth extends BaseCliAuth {
            constructor(credentialPath: string) {
                super({
                    providerKey: 'other',
                    name: 'Other CLI',
                    clientId: 'client',
                    tokenUrl: 'https://example.com/token',
                    credentialPathPattern: credentialPath,
                    cliCommand: 'other-cli'
                });
            }
            protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
                return credentials;
            }
        }

        const otherDir = path.join(rootDir, 'other-oauth');
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: otherDir });
        const cliFile = path.join(rootDir, 'other-cli-auth.json');
        fs.writeFileSync(cliFile, JSON.stringify({ anything: true }));

        const auth = new TestCliAuth(cliFile);
        assert.equal(auth.isOAuthCredentialActive(), false);
        await auth.removeCliNativeCredential();
        assert.equal(fs.existsSync(cliFile), false);
        // 文件已不存在时不报错
        await auth.removeCliNativeCredential();
    });

    await t.test('GrokCliAuth 使用 oauth 凭证时按平铺格式保存并保留既有字段', async () => {
        const grokSaveDir = path.join(rootDir, 'grok-save-oauth');
        fs.mkdirSync(grokSaveDir, { recursive: true });
        const flatFile = path.join(grokSaveDir, 'grok-main.json');
        fs.writeFileSync(
            flatFile,
            JSON.stringify({
                type: 'grok',
                label: '保留字段',
                access_token: 'old',
                refresh_token: 'r',
                expiry_date: 1,
                email: 'dev@x.ai'
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: grokSaveDir });

        class TestGrokAuth extends GrokCliAuth {
            save(record: Record<string, unknown>): Promise<void> {
                return (
                    this as unknown as { saveCredentials(c: Record<string, unknown>): Promise<void> }
                ).saveCredentials(record);
            }
        }
        const testAuth = new TestGrokAuth();
        await testAuth.save({ access_token: 'new-token', refresh_token: 'new-refresh', expiry_date: 2 });
        const saved = JSON.parse(fs.readFileSync(flatFile, 'utf-8')) as Record<string, unknown>;
        assert.equal(saved.type, 'grok');
        assert.equal(saved.label, '保留字段');
        assert.equal(saved.email, 'dev@x.ai');
        assert.equal(saved.access_token, 'new-token');
        assert.equal(saved.refresh_token, 'new-refresh');
    });

    await t.test('CodexCliAuth 刷新 oauth 凭证时保留账号身份字段并写回平铺文件', async () => {
        const refreshDir = path.join(rootDir, 'refresh-oauth');
        fs.mkdirSync(refreshDir, { recursive: true });
        const flatFile = path.join(refreshDir, 'codex-work.json');
        fs.writeFileSync(
            flatFile,
            JSON.stringify({
                type: 'codex',
                access_token: 'old-access',
                refresh_token: 'old-refresh',
                expiry_date: 1000,
                account_id: 'acc-123',
                email: 'user@example.com',
                plan_type: 'plus'
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: refreshDir });

        const originalFetch = globalThis.fetch;
        // 刷新响应不携带 id_token：身份字段应保留原值
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            )) as typeof fetch;
        try {
            const auth = new CodexCliAuth();
            const refreshed = await auth.refreshCredentials(undefined, true);
            assert.equal(refreshed.access_token, 'new-access');
            assert.equal((refreshed as { account_id?: string }).account_id, 'acc-123');
            assert.equal((refreshed as { email?: string }).email, 'user@example.com');
            assert.equal((refreshed as { plan_type?: string }).plan_type, 'plus');

            const saved = JSON.parse(fs.readFileSync(flatFile, 'utf-8')) as Record<string, unknown>;
            assert.equal(saved.access_token, 'new-access');
            assert.equal(saved.refresh_token, 'new-refresh');
            assert.equal(saved.account_id, 'acc-123');
            assert.equal(saved.email, 'user@example.com');
            assert.equal(saved.plan_type, 'plus');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('按非活跃 OAuth 路径认证时刷新原账号且不切换活跃选择', async () => {
        const namedRefreshDir = path.join(rootDir, 'named-refresh-oauth');
        fs.mkdirSync(namedRefreshDir, { recursive: true });
        const fileA = path.join(namedRefreshDir, 'codex-a.json');
        const fileB = path.join(namedRefreshDir, 'codex-b.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'expired-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        fs.writeFileSync(
            fileB,
            JSON.stringify({
                type: 'codex',
                access_token: 'active-b',
                refresh_token: 'refresh-b',
                expiry_date: Date.now() + 24 * 3600_000
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: namedRefreshDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'b');

        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({ access_token: 'refreshed-a', refresh_token: 'rotated-a', expires_in: 3600 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )) as typeof fetch;
        try {
            const auth = new CodexCliAuth();
            const credentials = await auth.ensureAuthenticatedFromPath(fileA);
            assert.equal(credentials?.access_token, 'refreshed-a');
            assert.equal(OAuthCredentialStore.getActiveCredentialName('codex'), 'b');
            assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf-8')).access_token, 'refreshed-a');
            assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf-8')).access_token, 'active-b');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('加载凭证后缓存切换：刷新仍回写原凭证文件', async () => {
        const cacheRaceDir = path.join(rootDir, 'refresh-cache-race-oauth');
        fs.mkdirSync(cacheRaceDir, { recursive: true });
        const fileA = path.join(cacheRaceDir, 'codex-a.json');
        const fileB = path.join(cacheRaceDir, 'codex-b.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'token-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        fs.writeFileSync(
            fileB,
            JSON.stringify({
                type: 'codex',
                access_token: 'token-b',
                refresh_token: 'refresh-b',
                expiry_date: Date.now() + 24 * 3600_000
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: cacheRaceDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        const auth = new CodexCliAuth();
        const credentialsA = await auth.loadCredentials();
        assert.equal(credentialsA?.access_token, 'token-a');
        await OAuthCredentialStore.setActiveCredential('codex', 'b');
        assert.equal((await auth.loadCredentials())?.access_token, 'token-b');

        let refreshTarget: string | undefined;
        const authInternals = auth as unknown as {
            refreshAccessToken: (credentials: OAuthCredentials, credentialPath: string) => Promise<OAuthCredentials>;
        };
        const originalRefreshAccessToken = authInternals.refreshAccessToken;
        authInternals.refreshAccessToken = async (credentials, credentialPath) => {
            const refreshed = {
                ...credentials,
                access_token: 'refreshed-a',
                refresh_token: 'rotated-a',
                expiry_date: Date.now() + 3600_000
            };
            refreshTarget = credentialPath;
            fs.writeFileSync(credentialPath, JSON.stringify(refreshed));
            return refreshed;
        };
        try {
            const result = await auth.refreshCredentials(credentialsA!, true);
            assert.equal(refreshTarget, fileA);
            assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf-8')).access_token, 'refreshed-a');
            assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf-8')).access_token, 'token-b');
            assert.equal(result.access_token, 'token-b');
        } finally {
            authInternals.refreshAccessToken = originalRefreshAccessToken;
        }
    });

    await t.test('刷新挂起期间切换活跃账号：只回写原凭证并返回新活跃账号', async () => {
        const raceDir = path.join(rootDir, 'refresh-switch-oauth');
        fs.mkdirSync(raceDir, { recursive: true });
        const fileA = path.join(raceDir, 'codex-a.json');
        const fileB = path.join(raceDir, 'codex-b.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        fs.writeFileSync(
            fileB,
            JSON.stringify({
                type: 'codex',
                access_token: 'token-b',
                refresh_token: 'refresh-b',
                expiry_date: Date.now() + 24 * 3600_000
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: raceDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        let resolveFetch!: (response: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => {
            markFetchStarted = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            markFetchStarted();
            return new Promise<Response>(resolve => {
                resolveFetch = resolve;
            });
        }) as typeof fetch;

        try {
            const auth = new CodexCliAuth();
            const pendingRefresh = auth.refreshCredentials(undefined, true);
            await fetchStarted;

            // 网络刷新仍挂起时，模拟另一窗口将活跃凭证切到 B
            await OAuthCredentialStore.setActiveCredential('codex', 'b');
            resolveFetch(
                new Response(
                    JSON.stringify({
                        access_token: 'new-a',
                        refresh_token: 'new-refresh-a',
                        expires_in: 3600
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            );

            const result = await pendingRefresh;
            assert.equal(result.access_token, 'token-b');
            assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf-8')).access_token, 'new-a');
            assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf-8')).access_token, 'token-b');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('删除 OAuth 账号与在途刷新竞争时不重建凭证文件', async () => {
        const deleteRaceDir = path.join(rootDir, 'refresh-delete-race-oauth');
        fs.mkdirSync(deleteRaceDir, { recursive: true });
        const fileA = path.join(deleteRaceDir, 'codex-a.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: deleteRaceDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        let resolveFetch!: (response: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => {
            markFetchStarted = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            markFetchStarted();
            return new Promise<Response>(resolve => {
                resolveFetch = resolve;
            });
        }) as typeof fetch;

        try {
            const auth = new CodexCliAuth();
            const pendingRefresh = auth.refreshCredentials(undefined, true);
            await fetchStarted;

            assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'a'), true);
            assert.equal(fs.existsSync(fileA), false);
            resolveFetch(
                new Response(
                    JSON.stringify({ access_token: 'new-a', refresh_token: 'new-refresh-a', expires_in: 3600 }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            );

            await assert.rejects(pendingRefresh, /deleted before refreshed credentials could be saved/i);
            assert.equal(fs.existsSync(fileA), false);
            assert.deepEqual(OAuthCredentialStore.listCredentials('codex'), []);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('刷新写回后删除 OAuth 账号时拒绝返回已删除凭证', async () => {
        const deleteAfterSaveDir = path.join(rootDir, 'refresh-delete-after-save-oauth');
        fs.mkdirSync(deleteAfterSaveDir, { recursive: true });
        const filePath = path.join(deleteAfterSaveDir, 'codex-a.json');
        fs.writeFileSync(
            filePath,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: deleteAfterSaveDir });

        let markSaveCompleted!: () => void;
        const saveCompleted = new Promise<void>(resolve => {
            markSaveCompleted = resolve;
        });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>(resolve => {
            releaseRefresh = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-refresh-a', expires_in: 3600 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })) as typeof fetch;

        const auth = new CodexCliAuth();
        const authInternals = auth as unknown as {
            refreshAccessToken: (credentials: OAuthCredentials, credentialPath: string) => Promise<OAuthCredentials>;
        };
        const originalRefreshAccessToken = authInternals.refreshAccessToken;
        authInternals.refreshAccessToken = async (credentials, credentialPath) => {
            const refreshed = await originalRefreshAccessToken.call(auth, credentials, credentialPath);
            markSaveCompleted();
            await refreshGate;
            return refreshed;
        };

        try {
            const pendingRefresh = auth.ensureAuthenticatedFromPath(filePath, true);
            await saveCompleted;
            assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf-8')).access_token, 'new-a');
            assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'a'), true);
            releaseRefresh();

            await assert.rejects(pendingRefresh, /deleted during token refresh/i);
            assert.equal(fs.existsSync(filePath), false);
        } finally {
            releaseRefresh();
            authInternals.refreshAccessToken = originalRefreshAccessToken;
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('删除后同名重新导入时丢弃旧账号的在途刷新结果', async () => {
        const replaceRaceDir = path.join(rootDir, 'refresh-reimport-race-oauth');
        fs.mkdirSync(replaceRaceDir, { recursive: true });
        const credentialPath = path.join(replaceRaceDir, 'codex-a.json');
        fs.writeFileSync(
            credentialPath,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'old-refresh-a', expiry_date: 1 })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: replaceRaceDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        let resolveFetch!: (response: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => {
            markFetchStarted = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            markFetchStarted();
            return new Promise<Response>(resolve => {
                resolveFetch = resolve;
            });
        }) as typeof fetch;

        try {
            const auth = new CodexCliAuth();
            const pendingRefresh = auth.refreshCredentials(undefined, true);
            await fetchStarted;

            assert.equal(await OAuthCredentialStore.deleteCredentialFile('codex', 'a'), true);
            await OAuthCredentialStore.saveCredentialFile('codex', 'a', {
                type: 'codex',
                access_token: 'new-import',
                refresh_token: 'new-refresh',
                expiry_date: Date.now() + 86_400_000
            });
            resolveFetch(
                new Response(
                    JSON.stringify({
                        access_token: 'stale-refresh-result',
                        refresh_token: 'stale-rotated',
                        expires_in: 3600
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            );

            await assert.rejects(pendingRefresh, /changed while refreshed credentials were in flight/i);
            const saved = JSON.parse(fs.readFileSync(credentialPath, 'utf-8')) as { access_token: string };
            assert.equal(saved.access_token, 'new-import');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('命名账号与默认请求共享刷新结果但各自遵循账号路由', async () => {
        const sharedRefreshDir = path.join(rootDir, 'shared-refresh-policy-oauth');
        fs.mkdirSync(sharedRefreshDir, { recursive: true });
        const fileA = path.join(sharedRefreshDir, 'codex-a.json');
        const fileB = path.join(sharedRefreshDir, 'codex-b.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        fs.writeFileSync(
            fileB,
            JSON.stringify({
                type: 'codex',
                access_token: 'token-b',
                refresh_token: 'refresh-b',
                expiry_date: Date.now() + 24 * 3600_000
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: sharedRefreshDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        let resolveFetch!: (response: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => {
            markFetchStarted = resolve;
        });
        let markDefaultJoined!: () => void;
        const defaultJoined = new Promise<void>(resolve => {
            markDefaultJoined = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            markFetchStarted();
            return new Promise<Response>(resolve => {
                resolveFetch = resolve;
            });
        }) as typeof fetch;

        try {
            const auth = new CodexCliAuth();
            const originalRefreshCredentials = auth.refreshCredentials.bind(auth);
            let refreshCalls = 0;
            auth.refreshCredentials = async (...args: Parameters<typeof auth.refreshCredentials>) => {
                const pending = originalRefreshCredentials(...args);
                refreshCalls += 1;
                if (refreshCalls === 2) {
                    markDefaultJoined();
                }
                return await pending;
            };

            const namedRequest = auth.ensureAuthenticatedFromPath(fileA);
            await fetchStarted;
            const defaultRequest = auth.ensureAuthenticated();
            await defaultJoined;
            await OAuthCredentialStore.setActiveCredential('codex', 'b');
            resolveFetch(
                new Response(
                    JSON.stringify({ access_token: 'new-a', refresh_token: 'new-refresh-a', expires_in: 3600 }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            );

            const [namedCredentials, defaultCredentials] = await Promise.all([namedRequest, defaultRequest]);
            assert.equal(namedCredentials?.access_token, 'new-a');
            assert.equal(defaultCredentials?.access_token, 'token-b');
            assert.equal(refreshCalls, 2);
            assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf-8')).access_token, 'new-a');
            assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf-8')).access_token, 'token-b');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('默认请求先启动刷新时命名查询仍返回指定账号', async () => {
        const reverseRefreshDir = path.join(rootDir, 'reverse-refresh-policy-oauth');
        fs.mkdirSync(reverseRefreshDir, { recursive: true });
        const fileA = path.join(reverseRefreshDir, 'codex-a.json');
        const fileB = path.join(reverseRefreshDir, 'codex-b.json');
        fs.writeFileSync(
            fileA,
            JSON.stringify({ type: 'codex', access_token: 'old-a', refresh_token: 'refresh-a', expiry_date: 1 })
        );
        fs.writeFileSync(
            fileB,
            JSON.stringify({
                type: 'codex',
                access_token: 'token-b',
                refresh_token: 'refresh-b',
                expiry_date: Date.now() + 24 * 3600_000
            })
        );
        OAuthCredentialStore.resetForTests();
        OAuthCredentialStore.initialize({ oauthDir: reverseRefreshDir });
        await OAuthCredentialStore.setActiveCredential('codex', 'a');

        let resolveFetch!: (response: Response) => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>(resolve => {
            markFetchStarted = resolve;
        });
        let markNamedJoined!: () => void;
        const namedJoined = new Promise<void>(resolve => {
            markNamedJoined = resolve;
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            markFetchStarted();
            return new Promise<Response>(resolve => {
                resolveFetch = resolve;
            });
        }) as typeof fetch;

        try {
            const auth = new CodexCliAuth();
            const originalRefreshCredentials = auth.refreshCredentials.bind(auth);
            let refreshCalls = 0;
            auth.refreshCredentials = async (...args: Parameters<typeof auth.refreshCredentials>) => {
                const pending = originalRefreshCredentials(...args);
                refreshCalls += 1;
                if (refreshCalls === 2) {
                    markNamedJoined();
                }
                return await pending;
            };

            const defaultRequest = auth.ensureAuthenticated();
            await fetchStarted;
            const namedRequest = auth.ensureAuthenticatedFromPath(fileA);
            await namedJoined;
            await OAuthCredentialStore.setActiveCredential('codex', 'b');
            resolveFetch(
                new Response(
                    JSON.stringify({ access_token: 'new-a', refresh_token: 'new-refresh-a', expires_in: 3600 }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            );

            const [defaultCredentials, namedCredentials] = await Promise.all([defaultRequest, namedRequest]);
            assert.equal(defaultCredentials?.access_token, 'token-b');
            assert.equal(namedCredentials?.access_token, 'new-a');
            assert.equal(refreshCalls, 2);
            assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf-8')).access_token, 'new-a');
            assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf-8')).access_token, 'token-b');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    await t.test('loadCliNativeCredentials 在 CLI 原生凭证不存在时返回 null', async () => {
        BaseCliAuth.setCredentialPathOverride(path.join(rootDir, 'missing-auth.json'));
        try {
            const auth = new CodexCliAuth();
            assert.equal(await auth.loadCliNativeCredentials(), null);
        } finally {
            BaseCliAuth.setCredentialPathOverride(undefined);
        }
    });
});
