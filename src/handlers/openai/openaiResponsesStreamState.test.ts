import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

let streamProcessorModulePromise:
    | Promise<{
          buildWebSearchCallContent: typeof import('./openaiResponsesStreamProcessor').buildWebSearchCallContent;
          OpenAIResponsesStreamState: typeof import('./openaiResponsesStreamProcessor').OpenAIResponsesStreamState;
      }>
    | undefined;

async function getStreamProcessorModule() {
    if (streamProcessorModulePromise) {
        return streamProcessorModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {};
        }
        return originalRequire.call(this, id);
    };

    streamProcessorModulePromise = import('./openaiResponsesStreamProcessor').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return streamProcessorModulePromise;
}

test('输出文本 delta 与 done 按 item/content 粒度去重', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    state.rememberOutputTextDelta('item-1', 0);

    assert.equal(state.shouldSkipOutputTextDone('item-1', 0), true);
    assert.equal(state.shouldSkipOutputTextDone('item-1', 1), false);
    assert.equal(state.shouldSkipOutputTextDone('item-2', 0), false);
});

test('工具调用索引绑定 item_id，并支持无歧义 call_id 回退', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    const stableIndex = state.getStableToolCallIndex('fc_item_1', 'call_server_1');
    assert.equal(stableIndex, 0);

    const sameByItemId = state.getToolCallIndex('fc_item_1');
    const sameByCallId = state.getStableToolCallIndex(undefined, 'call_server_1');
    assert.equal(sameByItemId, stableIndex);
    assert.equal(sameByCallId, stableIndex);

    state.markToolCallDeltaCounted(stableIndex!);
    state.markToolCallCompleted(stableIndex!);

    assert.equal(state.wasToolCallDeltaCounted(stableIndex!), true);
    assert.equal(state.isToolCallCompleted(stableIndex!), true);
});

test('缺少 item_id 时首次使用无歧义 call_id 建立临时索引', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    const first = state.getStableToolCallIndex(undefined, 'call_only');
    assert.equal(first, 0);
    assert.equal(state.getStableToolCallIndex(undefined, 'call_only'), first);
});

test('重复 call_id 不覆盖 item_id 索引，歧义别名禁止回退', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();
    const first = state.getStableToolCallIndex('item1', 'shared');
    const second = state.getStableToolCallIndex('item2', 'shared');
    assert.notEqual(first, second);
    assert.equal(state.getStableToolCallIndex('item1', 'shared'), first);
    assert.equal(state.getStableToolCallIndex('item2', 'shared'), second);
    assert.equal(state.getStableToolCallIndex(undefined, 'shared'), undefined);
});

test('completed 阶段仅匹配终态前参数与名称一致的记录', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    const streamed = state.getStableToolCallIndex('item_streamed', 'call_1');
    state.markToolCallCompleted(streamed!);
    state.setToolCallBuffer(streamed!, { id: 'call_1', name: 'read_file', args: '{}' });
    state.beginCompletedPhase([{ id: 'item_completed' }]);

    // 网关在 response.completed 中重写 item id（call_id 不变）：归并为同一调用
    assert.equal(state.getCompletedPhaseToolCallIndex('item_completed', 'call_1', 'read_file', '{}'), streamed);
    assert.equal(state.getToolCallIndex('item_completed'), streamed);

    // call_id 别名歧义（已置空）时不归并，分配独立索引
    const first = state.getStableToolCallIndex('itemA', 'shared');
    const second = state.getStableToolCallIndex('itemB', 'shared');
    const fallback = state.getCompletedPhaseToolCallIndex('itemC', 'shared');
    assert.notEqual(fallback, first);
    assert.notEqual(fallback, second);
});

test('web_search_call 内容提取覆盖 search/open_page/find_in_page 并避免重复上报', async () => {
    const { buildWebSearchCallContent, OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    assert.equal(state.markWebSearchCallReported('ws_1'), true);
    assert.equal(state.markWebSearchCallReported('ws_1'), false);

    assert.deepEqual(
        JSON.parse(
            buildWebSearchCallContent({
                action: { type: 'search', query: 'hello', queries: ['hello'] }
            })
        ),
        { type: 'web_search_call', action_type: 'search', query: 'hello', queries: ['hello'] }
    );

    assert.deepEqual(
        JSON.parse(
            buildWebSearchCallContent({
                action: { type: 'open_page', url: 'https://example.com' }
            })
        ),
        { type: 'web_search_call', action_type: 'open_page', url: 'https://example.com' }
    );

    assert.deepEqual(
        JSON.parse(
            buildWebSearchCallContent({
                action: { type: 'find_in_page', pattern: 'needle' }
            })
        ),
        { type: 'web_search_call', action_type: 'find_in_page', pattern: 'needle' }
    );
});

test('跨 output_index 的正文需要插入分段，同一 index 不重复分段', async () => {
    const { OpenAIResponsesStreamState } = await getStreamProcessorModule();
    const state = new OpenAIResponsesStreamState();

    assert.equal(state.shouldSeparateOutputText(0), false);
    assert.equal(state.shouldSeparateOutputText(0), false);
    assert.equal(state.shouldSeparateOutputText(1), true);
    assert.equal(state.shouldSeparateOutputText(undefined), false);
});
