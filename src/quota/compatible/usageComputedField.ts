/**---------------------------------------------------------------------------------------------
 *  余额/用量查询的字段值解析
 *  支持直接 JSON 路径、常量与四则运算；paths 中可嵌套子计算（如 (a-b)/c）
 *--------------------------------------------------------------------------------------------*/

import { getNumberByPath } from '../../utils/text/pathExtractor';
import type { UsageComputedField, UsageFieldValueSource } from '../../types/sharedTypes';

/**
 * 解析 usage 字段值：直接路径或计算字段（支持嵌套子计算）
 * @param data 查询接口返回的 JSON 数据
 * @param fieldSource 字段来源配置
 * @param fieldName 字段名（用于错误信息）
 */
export function resolveUsageFieldValue(
    data: unknown,
    fieldSource: UsageFieldValueSource | undefined,
    fieldName: 'balance' | 'paid' | 'granted'
): number | undefined {
    if (fieldSource === undefined) {
        return undefined;
    }

    if (typeof fieldSource === 'string') {
        return getNumberByPath(data, fieldSource);
    }

    return resolveComputedField(data, fieldSource, fieldName);
}

/**
 * 递归求值计算字段；配置非法时抛错，任一参与项缺失时返回 undefined
 */
function resolveComputedField(
    data: unknown,
    fieldSource: unknown,
    fieldName: 'balance' | 'paid' | 'granted'
): number | undefined {
    if (!isValidComputedField(fieldSource)) {
        throw new Error(`Invalid usage.fields.${fieldName} computed field configuration`);
    }

    const values = fieldSource.paths.map(pathEntry => {
        if (typeof pathEntry === 'number') {
            return Number.isFinite(pathEntry) ? pathEntry : undefined;
        }
        if (typeof pathEntry === 'string') {
            const value = getNumberByPath(data, pathEntry);
            return value === undefined && fieldSource.treatMissingAsZero ? 0 : value;
        }
        // 嵌套子计算：先递归求值，结果参与当前运算
        return resolveComputedField(data, pathEntry, fieldName);
    });
    if (values.some(value => value === undefined)) {
        return undefined;
    }

    const resolvedValues = values as number[];
    let result: number;
    switch (fieldSource.operation) {
        case 'sum':
            result = resolvedValues.reduce((total, value) => total + value, 0);
            break;
        case 'multiply':
            result = resolvedValues.reduce((total, value) => total * value, 1);
            break;
        case 'subtract':
            result = resolvedValues.slice(1).reduce((total, value) => total - value, resolvedValues[0]);
            break;
        case 'divide':
            result = resolvedValues.slice(1).reduce((total, value) => total / value, resolvedValues[0]);
            break;
        default:
            throw new Error(`Invalid usage.fields.${fieldName} computed field configuration`);
    }

    if (!Number.isFinite(result)) {
        throw new Error(`Invalid usage.fields.${fieldName} computed field result`);
    }

    return result;
}

/**
 * 校验计算字段配置（含嵌套子计算）
 */
function isValidComputedField(fieldSource: unknown): fieldSource is UsageComputedField {
    if (fieldSource === null || typeof fieldSource !== 'object' || Array.isArray(fieldSource)) {
        return false;
    }

    const candidate = fieldSource as UsageComputedField;
    return (
        ['sum', 'subtract', 'multiply', 'divide'].includes(candidate.operation) &&
        (candidate.treatMissingAsZero === undefined || typeof candidate.treatMissingAsZero === 'boolean') &&
        Array.isArray(candidate.paths) &&
        candidate.paths.length > 0 &&
        candidate.paths.every(
            path =>
                typeof path === 'number' ||
                (typeof path === 'string' && path.trim().length > 0) ||
                isValidComputedField(path)
        )
    );
}
