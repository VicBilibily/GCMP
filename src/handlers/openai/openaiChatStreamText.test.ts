import assert from 'node:assert/strict';
import test from 'node:test';
import { reportChatCompletionText } from './openaiChatStreamText';

function report(choice: Parameters<typeof reportChatCompletionText>[0]): string[] {
    const output: string[] = [];
    reportChatCompletionText(choice, { reportText: text => output.push(text) });
    return output;
}

test('同时存在 delta 和 message 时只报告 delta 内容', () => {
    assert.deepEqual(report({ delta: { content: '你' }, message: { content: '你' } }), ['你']);
});

test('delta 内容缺失时回退到 message 内容', () => {
    assert.deepEqual(report({ message: { content: '你好' } }), ['你好']);
    assert.deepEqual(report({ delta: { content: '' }, message: { content: '你好' } }), ['你好']);
    assert.deepEqual(report({ delta: {}, message: { content: '你好' } }), ['你好']);
});

test('两个连续分片不做跨分片去重', () => {
    const output: string[] = [];
    const reporter = { reportText: (text: string) => output.push(text) };
    reportChatCompletionText({ delta: { content: 'a' } }, reporter);
    reportChatCompletionText({ delta: { content: 'a' } }, reporter);
    assert.deepEqual(output, ['a', 'a']);
});

test('空内容不报告', () => {
    assert.deepEqual(report({ delta: { content: '' }, message: { content: '' } }), []);
    assert.deepEqual(report({}), []);
});
