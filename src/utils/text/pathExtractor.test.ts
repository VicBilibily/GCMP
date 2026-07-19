/**---------------------------------------------------------------------------------------------
 *  字段路径解析器单元测试
 *--------------------------------------------------------------------------------------------*/

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getValueByPath, getNumberByPath } from './pathExtractor';

describe('getValueByPath', () => {
    const data = {
        balance: 12.5,
        data: {
            balance: 34.6,
            items: [{ credit_balance: 50000 }, { credit_balance: 10000 }]
        },
        usage: {
            today: { cost: 1.23 },
            total: { cost: 9.87 }
        }
    };

    it('returns root value', () => {
        assert.strictEqual(getValueByPath(data, 'balance'), 12.5);
    });

    it('returns nested value with dot path', () => {
        assert.strictEqual(getValueByPath(data, 'data.balance'), 34.6);
    });

    it('returns array item value with bracket index', () => {
        assert.strictEqual(getValueByPath(data, 'data.items[0].credit_balance'), 50000);
    });

    it('returns undefined for missing path', () => {
        assert.strictEqual(getValueByPath(data, 'data.missing'), undefined);
    });

    it('returns undefined for invalid object', () => {
        assert.strictEqual(getValueByPath(null, 'balance'), undefined);
    });
});

describe('getNumberByPath', () => {
    const data = {
        number: 42,
        stringNumber: '3.14',
        notNumber: 'abc',
        infinite: Infinity
    };

    it('parses number value', () => {
        assert.strictEqual(getNumberByPath(data, 'number'), 42);
    });

    it('parses numeric string value', () => {
        assert.strictEqual(getNumberByPath(data, 'stringNumber'), 3.14);
    });

    it('returns undefined for non-numeric string', () => {
        assert.strictEqual(getNumberByPath(data, 'notNumber'), undefined);
    });

    it('returns undefined for infinite number', () => {
        assert.strictEqual(getNumberByPath(data, 'infinite'), undefined);
    });

    it('returns undefined when path is undefined', () => {
        assert.strictEqual(getNumberByPath(data, undefined), undefined);
    });
});
