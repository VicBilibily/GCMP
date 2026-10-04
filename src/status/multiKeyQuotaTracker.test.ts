import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigSetItem } from '../utils/config/configSetStore';
import type { QuotaQueryContext } from '../quota/statusAdapters/types';
import type { QuotaTable } from '../quota/types';
import {
    collectMultiKeyStatus,
    hashApiKey,
    isMultiKeyModeImpl,
    renderMultiKeySections,
    renderQuotaTable,
    type MultiKeyConfigSource,
    type MultiKeySectionLabels,
    type MultiKeyStatusData
} from './multiKeyQuotaTracker';

interface FakeData {
    usage: number;
}

const labels: MultiKeySectionLabels = {
    nameColumn: 'NAME',
    usageColumn: 'USAGE',
    notConfigured: 'NO KEY',
    queryFailed: 'FAILED',
    staleResult: 'STALE'
};

function createAdapter(overrides?: {
    onQuery?: (apiKey: string, context?: QuotaQueryContext) => Promise<FakeData>;
    summary?: (data: FakeData) => string;
}) {
    const queries: Array<{ apiKey: string; context?: QuotaQueryContext }> = [];
    return {
        queries,
        adapter: {
            async query(apiKey: string, context?: QuotaQueryContext): Promise<FakeData> {
                queries.push({ apiKey, context });
                return overrides?.onQuery ? overrides.onQuery(apiKey, context) : { usage: 50 };
            },
            summary: overrides?.summary ?? ((data: FakeData) => `usage ${data.usage}%`),
            tables: (): QuotaTable[] => [
                { columns: ['A', 'B'], rows: [['1', '2']], align: ['left', 'right'], boldColumns: [0] }
            ]
        }
    };
}

function createSource(items: ConfigSetItem[], keys: Record<string, string | undefined>, activeId?: string) {
    return {
        source: {
            list: () => items,
            getActiveId: () => activeId,
            getApiKey: async (id: string) => keys[id]
        } satisfies MultiKeyConfigSource
    };
}

const itemA: ConfigSetItem = { id: 'a', label: 'Key A' };
const itemB: ConfigSetItem = { id: 'b', label: 'Key B', site: 'api.z.ai' };

// ============= isMultiKeyModeImpl =============

test('isMultiKeyModeImpl: off mode never enables multi-key display', () => {
    assert.equal(isMultiKeyModeImpl('off', 0), false);
    assert.equal(isMultiKeyModeImpl('off', 5), false);
});

test('isMultiKeyModeImpl: failover/balance requires more than one saved config', () => {
    assert.equal(isMultiKeyModeImpl('failover', 1), false);
    assert.equal(isMultiKeyModeImpl('balance', 1), false);
    assert.equal(isMultiKeyModeImpl('failover', 2), true);
    assert.equal(isMultiKeyModeImpl('balance', 3), true);
});

// ============= hashApiKey =============

test('hashApiKey: deterministic and distinct fingerprints', () => {
    assert.equal(hashApiKey('key-1'), hashApiKey('key-1'));
    assert.notEqual(hashApiKey('key-1'), hashApiKey('key-2'));
    assert.equal(hashApiKey('key-1').length, 16);
});

// ============= collectMultiKeyStatus =============

test('collectMultiKeyStatus: marks active config and queries each key', async () => {
    const { adapter, queries } = createAdapter();
    const { source } = createSource([itemA, itemB], { a: 'ka', b: 'kb' }, 'a');

    const status = await collectMultiKeyStatus(source, adapter);

    assert.equal(status.entries.length, 2);
    assert.deepEqual(
        status.entries.map(e => [e.configId, e.isActive, e.status]),
        [
            ['a', true, 'success'],
            ['b', false, 'success']
        ]
    );
    assert.deepEqual(
        queries.map(q => q.apiKey),
        ['ka', 'kb']
    );
});

test('collectMultiKeyStatus: passes per-config site to adapter query', async () => {
    const { adapter, queries } = createAdapter();
    const { source } = createSource([itemA, itemB], { a: 'ka', b: 'kb' }, 'a');

    await collectMultiKeyStatus(source, adapter);

    assert.deepEqual(queries[0].context, undefined);
    assert.deepEqual(queries[1].context, { site: 'api.z.ai' });
});

test('collectMultiKeyStatus: reuses main query result for active entry when key identity matches', async () => {
    const { adapter, queries } = createAdapter();
    const { source } = createSource([itemA, itemB], { a: 'ka', b: 'kb' }, 'a');

    const status = await collectMultiKeyStatus(source, adapter, {
        activeReuse: { configId: 'a', keyHash: hashApiKey('ka'), data: { usage: 42 } }
    });

    const active = status.entries.find(e => e.configId === 'a');
    assert.equal(active?.status, 'success');
    assert.deepEqual(active?.data, { usage: 42 });
    // 激活 key 未被重复查询
    assert.deepEqual(
        queries.map(q => q.apiKey),
        ['kb']
    );
});

test('collectMultiKeyStatus: queries active entry itself when reuse identity mismatches', async () => {
    const { adapter, queries } = createAdapter();
    const { source } = createSource([itemA, itemB], { a: 'ka', b: 'kb' }, 'a');

    const status = await collectMultiKeyStatus(source, adapter, {
        activeReuse: { configId: 'a', keyHash: hashApiKey('stale-key'), data: { usage: 42 } }
    });

    assert.deepEqual(
        queries.map(q => q.apiKey),
        ['ka', 'kb']
    );
    assert.equal(status.entries.find(e => e.configId === 'a')?.data?.usage, 50);
});

test('collectMultiKeyStatus: marks missing-key entry without querying adapter', async () => {
    const { adapter, queries } = createAdapter();
    const { source } = createSource([itemA, itemB], { a: 'ka', b: undefined }, 'a');

    const status = await collectMultiKeyStatus(source, adapter);

    const entryB = status.entries.find(e => e.configId === 'b');
    assert.equal(entryB?.status, 'missing-key');
    assert.deepEqual(
        queries.map(q => q.apiKey),
        ['ka']
    );
});

test('collectMultiKeyStatus: captures adapter failure as error entry', async () => {
    const { adapter } = createAdapter({
        onQuery: async apiKey => {
            if (apiKey === 'kb') {
                throw new Error('boom');
            }
            return { usage: 50 };
        }
    });
    const { source } = createSource([itemA, itemB], { a: 'ka', b: 'kb' }, 'a');

    const status = await collectMultiKeyStatus(source, adapter);

    const entryB = status.entries.find(e => e.configId === 'b');
    assert.equal(entryB?.status, 'error');
    assert.equal(entryB?.error, 'boom');
    assert.equal(status.entries.find(e => e.configId === 'a')?.status, 'success');
});

test('collectMultiKeyStatus: discards late result when key replaced during query', async () => {
    const keys: Record<string, string | undefined> = { a: 'ka', b: 'kb' };
    const { adapter } = createAdapter({
        onQuery: async apiKey => {
            if (apiKey === 'kb') {
                keys.b = 'kb-rotated';
            }
            return { usage: 50 };
        }
    });
    const { source } = createSource([itemA, itemB], keys, 'a');

    const status = await collectMultiKeyStatus(source, adapter);

    const entryB = status.entries.find(e => e.configId === 'b');
    assert.equal(entryB?.status, 'stale');
});

// ============= renderQuotaTable =============

test('renderQuotaTable: renders alignment and bold metadata', () => {
    const md = renderQuotaTable({
        columns: ['Window', 'Remain'],
        rows: [['5h', '20%']],
        align: ['left', 'right'],
        boldColumns: [0]
    });

    assert.equal(md, '| Window | Remain |\n| :--- | ---: |\n| **5h** | 20% |\n');
});

// ============= renderMultiKeySections =============

function makeStatus(entries: MultiKeyStatusData<FakeData>['entries']): MultiKeyStatusData<FakeData> {
    return { entries, timestamp: Date.now() };
}

test('renderMultiKeySections: empty for single entry', () => {
    const { adapter } = createAdapter();
    const status = makeStatus([
        {
            configId: 'a',
            label: 'Key A',
            isActive: true,
            keyHash: 'h',
            status: 'success',
            data: { usage: 1 },
            timestamp: 0
        }
    ]);

    assert.equal(renderMultiKeySections(status, adapter, labels), '');
});

test('renderMultiKeySections: bold usage marks the active entry', () => {
    const { adapter } = createAdapter();
    const status = makeStatus([
        {
            configId: 'a',
            label: 'Key A',
            isActive: true,
            keyHash: 'h1',
            status: 'success',
            data: { usage: 42 },
            timestamp: 0
        },
        {
            configId: 'b',
            label: 'Key B',
            isActive: false,
            keyHash: 'h2',
            status: 'success',
            data: { usage: 7 },
            timestamp: 0
        }
    ]);

    const md = renderMultiKeySections(status, adapter, labels);

    assert.match(md, /\| NAME \| USAGE \|/);
    assert.match(md, /\| \*\*Key A\*\* \| \*\*usage 42%\*\* \|/);
    assert.match(md, /\| Key B \| usage 7% \|/);
});

test('renderMultiKeySections: rows of one table, no per-config sections', () => {
    const { adapter } = createAdapter();
    const status = makeStatus([
        {
            configId: 'a',
            label: 'Key A',
            isActive: true,
            keyHash: 'h1',
            status: 'success',
            data: { usage: 42 },
            timestamp: 0
        },
        {
            configId: 'b',
            label: 'Key B',
            isActive: false,
            keyHash: 'h2',
            status: 'success',
            data: { usage: 7 },
            timestamp: 0
        }
    ]);

    const md = renderMultiKeySections(status, adapter, labels);
    const tableCount = (md.match(/\| :--- \| :--- \|/g) ?? []).length;

    assert.equal(tableCount, 1);
    // 两条数据行在同一张表内连续排列
    assert.match(md, /\| \*\*usage 42%\*\* \|\n\| Key B \| usage 7% \|/);
});

test('renderMultiKeySections: renders missing-key, error and stale placeholders', () => {
    const { adapter } = createAdapter();
    const status = makeStatus([
        { configId: 'a', label: 'Key A', isActive: false, keyHash: 'h1', status: 'missing-key', timestamp: 0 },
        { configId: 'b', label: 'Key B', isActive: false, keyHash: 'h2', status: 'error', error: 'boom', timestamp: 0 },
        { configId: 'c', label: 'Key C', isActive: true, keyHash: 'h3', status: 'stale', timestamp: 0 }
    ]);

    const md = renderMultiKeySections(status, adapter, labels);

    assert.match(md, /\| Key A \| NO KEY \|/);
    assert.match(md, /\| Key B \| FAILED \|/);
    assert.match(md, /\| \*\*Key C\*\* \| \*\*STALE\*\* \|/);
});

for (const [name, input, escaped] of [
    ['pipe', 'Team | Backup', 'Team \\| Backup'],
    ['emphasis', '**Backup** _key_ `code`', '\\*\\*Backup\\*\\* \\_key\\_ \\`code\\`'],
    ['line breaks', 'Team\r\nBackup\nKey\rNext', 'Team Backup Key Next'],
    [
        'links and HTML',
        '[switch](command:gcmp.configSet.switchKey) <b>&copy;</b>',
        '\\[switch\\]\\(command:gcmp\\.configSet\\.switchKey\\) &lt;b&gt;&amp;copy;&lt;/b&gt;'
    ],
    ['backslash', 'Team\\|Backup', 'Team\\\\\\|Backup']
]) {
    test(`renderMultiKeySections: escapes ${name} in names and summaries`, () => {
        const { adapter } = createAdapter({ summary: () => input });
        const status = makeStatus([
            {
                configId: 'a',
                label: input,
                isActive: true,
                keyHash: 'h1',
                status: 'success',
                data: { usage: 1 },
                timestamp: 0
            },
            {
                configId: 'b',
                label: input,
                isActive: false,
                keyHash: 'h2',
                status: 'success',
                data: { usage: 2 },
                timestamp: 0
            }
        ]);

        assert.equal(
            renderMultiKeySections(status, adapter, labels),
            `| NAME | USAGE |\n| :--- | :--- |\n| **${escaped}** | **${escaped}** |\n| ${escaped} | ${escaped} |\n`
        );
    });
}
