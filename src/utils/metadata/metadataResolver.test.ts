import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderConfig } from '../../types/sharedTypes';
import builtinMetadata from './gcmp-metadata.json';
import {
    getClaudeCodeCliVersion,
    getCodexTuiCliHeader,
    hashCliMetadata,
    parseGcmpMetadata,
    setRemoteCliMetadata,
    withCodexCliMetadata
} from './metadataResolver';

function resetSnapshot(): void {
    setRemoteCliMetadata(undefined);
}

test('parseGcmpMetadata parses a valid payload', () => {
    const parsed = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            contentHash: '368f63c6bb20',
            cli: {
                claudeCode: { version: '2.1.300' },
                codexTui: { version: '0.200.0', originator: 'codex-tui' }
            }
        })
    );
    assert.equal(parsed?.schemaVersion, 1);
    assert.equal(parsed?.contentHash, '368f63c6bb20');
    assert.equal(parsed?.cli.claudeCodeVersion, '2.1.300');
    assert.equal(parsed?.cli.codexTuiVersion, '0.200.0');
    assert.equal(parsed?.cli.codexTuiOriginator, 'codex-tui');
});

test('parseGcmpMetadata rejects invalid JSON and unsupported schemaVersion', () => {
    assert.equal(parseGcmpMetadata('not-json'), undefined);
    assert.equal(parseGcmpMetadata('"just a string"'), undefined);
    assert.equal(parseGcmpMetadata(JSON.stringify({ schemaVersion: 2, cli: {} })), undefined);
    assert.equal(parseGcmpMetadata(JSON.stringify({ cli: {} })), undefined);
});

test('parseGcmpMetadata drops invalid leaf fields but keeps valid ones', () => {
    const parsed = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            contentHash: 123,
            cli: {
                claudeCode: { version: '  ' },
                codexTui: { version: '0.200.0', originator: 42 }
            }
        })
    );
    assert.equal(parsed?.contentHash, undefined);
    assert.equal(parsed?.cli.claudeCodeVersion, undefined);
    assert.equal(parsed?.cli.codexTuiVersion, '0.200.0');
    assert.equal(parsed?.cli.codexTuiOriginator, undefined);
});

test('parseGcmpMetadata rejects header-unsafe or malformed version strings', () => {
    const injected = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            cli: {
                claudeCode: { version: '2.1.300\nX-Evil: 1' },
                codexTui: { version: 'not a version', originator: 'codex-tui' }
            }
        })
    );
    assert.equal(injected?.cli.claudeCodeVersion, undefined);
    assert.equal(injected?.cli.codexTuiVersion, undefined);

    const badOriginator = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            cli: { codexTui: { version: '0.200.0', originator: 'codex-tui\nX-Evil: 1' } }
        })
    );
    assert.equal(badOriginator?.cli.codexTuiVersion, '0.200.0');
    assert.equal(badOriginator?.cli.codexTuiOriginator, undefined);

    const spacedOriginator = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            cli: { codexTui: { originator: 'codex tui' } }
        })
    );
    assert.equal(spacedOriginator?.cli.codexTuiOriginator, undefined);

    const prerelease = parseGcmpMetadata(
        JSON.stringify({
            schemaVersion: 1,
            cli: {
                claudeCode: { version: '2.1.300-beta.1' },
                codexTui: { version: '0.200.0', originator: 'codex_vscode' }
            }
        })
    );
    assert.equal(prerelease?.cli.claudeCodeVersion, '2.1.300-beta.1');
    assert.equal(prerelease?.cli.codexTuiVersion, '0.200.0');
    assert.equal(prerelease?.cli.codexTuiOriginator, 'codex_vscode');
});

test('parseGcmpMetadata tolerates non-object cli groups', () => {
    const nonObjectCli = parseGcmpMetadata(JSON.stringify({ schemaVersion: 1, cli: 'broken' }));
    assert.deepEqual(nonObjectCli?.cli, {
        claudeCodeVersion: undefined,
        codexTuiVersion: undefined,
        codexTuiOriginator: undefined
    });

    const nonObjectSections = parseGcmpMetadata(
        JSON.stringify({ schemaVersion: 1, cli: { claudeCode: ['x'], codexTui: null } })
    );
    assert.equal(nonObjectSections?.cli.claudeCodeVersion, undefined);
    assert.equal(nonObjectSections?.cli.codexTuiVersion, undefined);

    const numericVersion = parseGcmpMetadata(
        JSON.stringify({ schemaVersion: 1, cli: { claudeCode: { version: 2.1 } } })
    );
    assert.equal(numericVersion?.cli.claudeCodeVersion, undefined);
});

test('getClaudeCodeCliVersion falls back to shared metadata file', () => {
    resetSnapshot();
    assert.equal(getClaudeCodeCliVersion(), builtinMetadata.cli.claudeCode.version);
});

test('getClaudeCodeCliVersion prefers remote snapshot and restores fallback after reset', () => {
    setRemoteCliMetadata({ claudeCodeVersion: '9.9.9' });
    assert.equal(getClaudeCodeCliVersion(), '9.9.9');
    resetSnapshot();
    assert.equal(getClaudeCodeCliVersion(), builtinMetadata.cli.claudeCode.version);
});

test('getCodexTuiCliHeader falls back to builtin metadata and prefers remote snapshot field-wise', () => {
    resetSnapshot();
    assert.deepEqual(getCodexTuiCliHeader(), {
        version: builtinMetadata.cli.codexTui.version,
        originator: builtinMetadata.cli.codexTui.originator
    });

    setRemoteCliMetadata({ codexTuiVersion: '0.200.0' });
    assert.deepEqual(getCodexTuiCliHeader(), {
        version: '0.200.0',
        originator: builtinMetadata.cli.codexTui.originator
    });

    setRemoteCliMetadata({ codexTuiOriginator: 'codex_vscode' });
    assert.deepEqual(getCodexTuiCliHeader(), {
        version: builtinMetadata.cli.codexTui.version,
        originator: 'codex_vscode'
    });

    setRemoteCliMetadata({ codexTuiVersion: '0.201.0', codexTuiOriginator: 'codex_vscode' });
    assert.deepEqual(getCodexTuiCliHeader(), { version: '0.201.0', originator: 'codex_vscode' });
    resetSnapshot();
});

test('hashCliMetadata is stable for same content and changes with any field', () => {
    const base = { claudeCodeVersion: '2.1.263', codexTuiVersion: '0.153.4', codexTuiOriginator: 'codex-tui' };
    assert.equal(hashCliMetadata(base), hashCliMetadata({ ...base }));
    assert.equal(hashCliMetadata(base), '368f63c6bb20');
    assert.notEqual(hashCliMetadata({ ...base, claudeCodeVersion: '2.1.300' }), hashCliMetadata(base));
    assert.notEqual(hashCliMetadata({}), hashCliMetadata(base));
});

test('withCodexCliMetadata injects builtin metadata header when config has none', () => {
    resetSnapshot();
    const config = {
        displayName: 'Codex',
        baseUrl: 'https://example.com',
        apiKeyTemplate: 'x',
        models: []
    } as ProviderConfig;
    const merged = withCodexCliMetadata(config);
    assert.deepEqual(merged.customHeader, {
        version: builtinMetadata.cli.codexTui.version,
        originator: builtinMetadata.cli.codexTui.originator
    });
    assert.equal(config.customHeader, undefined);
});

test('withCodexCliMetadata lets metadata win over config baseline without mutating input', () => {
    resetSnapshot();
    const config = {
        displayName: 'Codex',
        baseUrl: 'https://example.com',
        apiKeyTemplate: 'x',
        models: [],
        customHeader: { version: '0.153.2', originator: 'codex-tui', 'X-Keep': '1' }
    } as ProviderConfig;
    const merged = withCodexCliMetadata(config);
    assert.equal(merged.customHeader?.version, builtinMetadata.cli.codexTui.version);
    assert.equal(merged.customHeader?.['X-Keep'], '1');
    assert.equal(config.customHeader?.version, '0.153.2');
});

test('withCodexCliMetadata prefers remote snapshot over builtin metadata', () => {
    setRemoteCliMetadata({ codexTuiVersion: '0.200.0' });
    const config = {
        displayName: 'Codex',
        baseUrl: 'https://example.com',
        apiKeyTemplate: 'x',
        models: []
    } as ProviderConfig;
    const merged = withCodexCliMetadata(config);
    assert.equal(merged.customHeader?.version, '0.200.0');
    assert.equal(merged.customHeader?.originator, builtinMetadata.cli.codexTui.originator);
    resetSnapshot();
});
