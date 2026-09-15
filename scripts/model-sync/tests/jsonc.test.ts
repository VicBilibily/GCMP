import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonc, stripJsonComments } from '../jsonc';

test('行注释与块注释被剥离，换行保留', () => {
    const input = '{\n // 行注释\n "a": 1, /* 块\n 注释 */ "b": 2\n}';
    const parsed = parseJsonc<Record<string, number>>(input);
    assert.deepEqual(parsed, { a: 1, b: 2 });
    // 块注释内换行保留，错误行号不漂移
    assert.equal(stripJsonComments(input).split('\n').length, input.split('\n').length);
});

test('字符串中的双斜杠与转义引号不误判', () => {
    const input = '{ "url": "https://example.com/v1//models", "q": "\\" // not comment" } // 真注释';
    const parsed = parseJsonc<Record<string, string>>(input);
    assert.equal(parsed.url, 'https://example.com/v1//models');
    assert.equal(parsed.q, '" // not comment');
});

test('字符串中的块注释标记不误判', () => {
    const input = '{ "pattern": "/* not comment */" /* 真注释 */ }';
    const parsed = parseJsonc<Record<string, string>>(input);
    assert.equal(parsed.pattern, '/* not comment */');
});

test('EOF 前的行注释不需要换行结尾', () => {
    const parsed = parseJsonc<Record<string, number>>('{ "a": 1 } // 尾部注释');
    assert.deepEqual(parsed, { a: 1 });
});
