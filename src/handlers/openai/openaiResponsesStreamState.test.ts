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

test('工具调用索引优先绑定 call_id，并复用 item_id 映射', async () => {
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
