/** 格式保持的供应商配置写入：基于源码区间的局部编辑，不做整体重排。 */
import {
    parseJsonWithSpans,
    type JsonArrayNode,
    type JsonNode,
    type JsonObjectNode,
    type JsonValueNode
} from './jsonScan';
import { normalizeNumber } from './merge';
import type { FieldOp, ProviderModelEntry, TargetEdit } from './types';

interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/** 内置字段顺序：新增字段按此定位插入；未收录的字段追加到对象末尾。 */
const FIELD_ORDER = [
    'id',
    'name',
    'model',
    'baseUrl',
    'tooltip',
    'sdkMode',
    'contextSize',
    'maxInputTokens',
    'maxOutputTokens',
    'reasoningEffort',
    'reasoningDefault',
    'thinking',
    'thinkingFormat',
    'serviceTier',
    'webSearchTool',
    'useInstructions',
    'capabilities',
    'tokenPricing',
    'extraBody'
];

/** 将变更计划应用到配置文本，返回新文本；无变更时返回原文。 */
export function applyTargetEdit(text: string, edit: TargetEdit): string {
    const root = parseJsonWithSpans(text);
    if (root.type !== 'object') {
        throw new Error('供应商配置根节点必须是对象');
    }
    const modelsProp = root.properties.find(prop => prop.key === 'models');
    if (!modelsProp || modelsProp.value.type !== 'array') {
        throw new Error('供应商配置缺少 models 数组');
    }
    const modelsArray = modelsProp.value;
    const byLocalId = new Map<string, JsonObjectNode>();
    for (const item of modelsArray.items) {
        if (item.type !== 'object') {
            throw new Error('models 数组元素必须是对象');
        }
        const idProp = item.properties.find(prop => prop.key === 'id');
        const id = idProp && idProp.value.type === 'string' ? (idProp.value as JsonValueNode).value : undefined;
        if (typeof id !== 'string' || !id) {
            throw new Error('models 数组元素缺少字符串 id');
        }
        if (byLocalId.has(id)) {
            throw new Error(`models 数组存在重复的模型 id "${id}"`);
        }
        byLocalId.set(id, item);
    }

    const edits: TextEdit[] = [];
    const removalNodes = edit.removals.map(localId => {
        const node = byLocalId.get(localId);
        if (!node) {
            throw new Error(`待移除的模型 "${localId}" 不存在`);
        }
        byLocalId.delete(localId);
        return node;
    });
    // 相邻元素合并为单段编辑，避免逗号归属重叠
    removalNodes.sort((a, b) => a.start - b.start);
    const runs: JsonObjectNode[][] = [];
    for (const node of removalNodes) {
        const run = runs[runs.length - 1];
        const prev = run?.[run.length - 1];
        if (prev && text.slice(prev.end, node.start).trim() === ',') {
            run.push(node);
        } else {
            runs.push([node]);
        }
    }
    for (const run of runs) {
        edits.push(removeArrayItemRun(text, modelsArray, run));
    }
    for (const update of edit.updates) {
        const node = byLocalId.get(update.localId);
        if (!node) {
            throw new Error(`待更新的模型 "${update.localId}" 不存在`);
        }
        edits.push(...applyFieldOps(text, node, update.ops));
    }
    if (edit.additions.length > 0) {
        edits.push(...insertArrayItems(text, modelsArray, edit.additions, byLocalId));
    }
    if (edits.length === 0) {
        return text;
    }

    const result = applyTextEdits(text, edits);
    validateResult(result);
    return result;
}

function applyFieldOps(text: string, objectNode: JsonObjectNode, ops: FieldOp[]): TextEdit[] {
    const edits: TextEdit[] = [];
    const propIndent = detectIndent(text, objectNode);
    // 相邻属性合并为单段移除，避免逗号归属重叠
    const removeProps = ops
        .filter(op => op.kind === 'remove')
        .map(op => objectNode.properties.find(item => item.key === op.field))
        .filter((prop): prop is JsonObjectNode['properties'][number] => prop !== undefined)
        .sort((a, b) => a.keyStart - b.keyStart);
    const runs: JsonObjectNode['properties'][number][][] = [];
    for (const prop of removeProps) {
        const run = runs[runs.length - 1];
        const prev = run?.[run.length - 1];
        if (prev && text.slice(prev.value.end, prop.keyStart).trim() === ',') {
            run.push(prop);
        } else {
            runs.push([prop]);
        }
    }
    for (const run of runs) {
        edits.push(removeObjectPropertyRun(text, objectNode, run));
    }
    for (const op of ops) {
        if (op.kind === 'remove') {
            continue;
        }
        const prop = objectNode.properties.find(item => item.key === op.field);
        if (prop) {
            edits.push({ start: prop.value.start, end: prop.value.end, text: serializeValue(op.value, propIndent) });
        }
    }
    // 新增字段按内置字段序定位插入；同插入点的多字段合并为单段编辑
    const newOps = ops
        .filter((op): op is Extract<FieldOp, { kind: 'set' }> => op.kind === 'set')
        .filter(op => !objectNode.properties.some(item => item.key === op.field))
        .map(op => ({ op, rank: FIELD_ORDER.indexOf(op.field) }))
        .sort((a, b) => (a.rank === -1 ? FIELD_ORDER.length : a.rank) - (b.rank === -1 ? FIELD_ORDER.length : b.rank));
    const buckets = new Map<number, Array<Extract<FieldOp, { kind: 'set' }>>>();
    for (const { op, rank } of newOps) {
        const successor =
            rank === -1 ? undefined : objectNode.properties.find(item => FIELD_ORDER.indexOf(item.key) > rank);
        const key = successor ? lineStartOf(text, successor.keyStart) : -1;
        const bucket = buckets.get(key) ?? [];
        bucket.push(op);
        buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets) {
        const rendered = bucket
            .map(op => `${propIndent}${JSON.stringify(op.field)}: ${serializeValue(op.value, propIndent)}`)
            .join(',\n');
        if (key !== -1) {
            edits.push({ start: key, end: key, text: `${rendered},\n` });
            continue;
        }
        const lastProp = objectNode.properties[objectNode.properties.length - 1];
        if (!lastProp) {
            edits.push({ start: objectNode.end - 1, end: objectNode.end - 1, text: rendered.trimStart() });
        } else {
            edits.push({ start: lastProp.value.end, end: lastProp.value.end, text: `,\n${rendered}` });
        }
    }
    return edits;
}

/** 移除一段相邻数组元素并处理相邻逗号。 */
function removeArrayItemRun(text: string, array: JsonArrayNode, run: JsonObjectNode[]): TextEdit {
    const first = run[0];
    const last = run[run.length - 1];
    if (array.items[0] === first && array.items[array.items.length - 1] === last) {
        return { start: lineStartOf(text, first.start), end: last.end, text: '' };
    }
    if (array.items[array.items.length - 1] === last) {
        let comma = first.start - 1;
        while (comma >= 0 && /\s/.test(text[comma])) {
            comma--;
        }
        if (text[comma] === ',') {
            return { start: comma, end: last.end, text: '' };
        }
    }
    let end = last.end;
    let cursor = end;
    while (cursor < text.length && /[ \t]/.test(text[cursor])) {
        cursor++;
    }
    if (text[cursor] === ',') {
        end = skipLineEnding(text, cursor + 1);
    }
    return { start: lineStartOf(text, first.start), end, text: '' };
}

/** 移除一段相邻对象属性并处理相邻逗号。 */
function removeObjectPropertyRun(
    text: string,
    objectNode: JsonObjectNode,
    run: Array<{ keyStart: number; value: JsonNode }>
): TextEdit {
    const first = run[0];
    const last = run[run.length - 1];
    const isTail = objectNode.properties[objectNode.properties.length - 1].keyStart === last.keyStart;
    if (isTail && objectNode.properties.length > run.length) {
        let comma = lineStartOf(text, first.keyStart) - 1;
        while (comma >= 0 && /\s/.test(text[comma])) {
            comma--;
        }
        if (text[comma] === ',') {
            return { start: comma, end: last.value.end, text: '' };
        }
    }
    let end = last.value.end;
    if (text[end] === ',') {
        end++;
        end = skipLineEnding(text, end);
    }
    return { start: lineStartOf(text, first.keyStart), end, text: '' };
}

/** 按锚点分桶插入新条目；同桶条目保持 additions 中的相对顺序，渲染为一个连续块。 */
function insertArrayItems(
    text: string,
    array: JsonArrayNode,
    additions: TargetEdit['additions'],
    byLocalId: Map<string, JsonObjectNode>
): TextEdit[] {
    const buckets = new Map<string, { after?: string; before?: string; entries: ProviderModelEntry[] }>();
    for (const addition of additions) {
        const key =
            addition.after !== undefined ? `a:${addition.after}`
            : addition.before !== undefined ? `b:${addition.before}`
            : 'end';
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { after: addition.after, before: addition.before, entries: [] };
            buckets.set(key, bucket);
        }
        bucket.entries.push(addition.entry);
    }
    const edits: TextEdit[] = [];
    for (const bucket of buckets.values()) {
        if (bucket.after !== undefined) {
            const anchor = byLocalId.get(bucket.after);
            if (!anchor) {
                throw new Error(`插入锚点 "${bucket.after}" 不存在`);
            }
            const itemIndent = ' '.repeat(indentWidthOf(text, anchor.start));
            const rendered = bucket.entries
                .map(entry => `${itemIndent}${serializeModelEntry(entry, itemIndent)}`)
                .join(',\n');
            edits.push({ start: anchor.end, end: anchor.end, text: `,\n${rendered}` });
        } else if (bucket.before !== undefined) {
            const anchor = byLocalId.get(bucket.before);
            if (!anchor) {
                throw new Error(`插入锚点 "${bucket.before}" 不存在`);
            }
            const itemIndent = ' '.repeat(indentWidthOf(text, anchor.start));
            const rendered = bucket.entries
                .map(entry => `${itemIndent}${serializeModelEntry(entry, itemIndent)}`)
                .join(',\n');
            edits.push({
                start: lineStartOf(text, anchor.start),
                end: lineStartOf(text, anchor.start),
                text: `${rendered},\n`
            });
        } else {
            edits.push(appendArrayItems(text, array, bucket.entries));
        }
    }
    return edits;
}

function appendArrayItems(text: string, array: JsonArrayNode, additions: ProviderModelEntry[]): TextEdit {
    const items = array.items;
    const lastItem = items[items.length - 1];
    const itemIndent = lastItem ? ' '.repeat(indentWidthOf(text, lastItem.start)) : '        ';
    const closingIndent = ' '.repeat(Math.max(0, itemIndent.length - 4));
    const rendered = additions.map(entry => `${itemIndent}${serializeModelEntry(entry, itemIndent)}`).join(',\n');
    if (!lastItem) {
        return { start: array.end - 1, end: array.end - 1, text: `\n${rendered}\n${closingIndent}` };
    }
    return { start: lastItem.end, end: lastItem.end, text: `,\n${rendered}` };
}

/** 按供应商配置既有风格序列化新模型条目。 */
function serializeModelEntry(entry: ProviderModelEntry, itemIndent: string): string {
    const propIndent = `${itemIndent}    `;
    const lines = Object.entries(entry)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${propIndent}${JSON.stringify(key)}: ${serializeValue(value, propIndent)}`);
    return `{\n${lines.join(',\n')}\n${itemIndent}}`;
}

function serializeValue(value: unknown, indent: string): string {
    if (typeof value === 'number') {
        return String(normalizeNumber(value));
    }
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (value.every(item => typeof item !== 'object' || item === null)) {
            return `[${value.map(item => serializeValue(item, indent)).join(', ')}]`;
        }
        const childIndent = `${indent}    `;
        return `[\n${value.map(item => `${childIndent}${serializeValue(item, childIndent)}`).join(',\n')}\n${indent}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
        if (entries.every(([, item]) => typeof item !== 'object' || item === null)) {
            return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${serializeValue(item, indent)}`).join(', ')} }`;
        }
        const childIndent = `${indent}    `;
        const lines = entries.map(
            ([key, item]) => `${childIndent}${JSON.stringify(key)}: ${serializeValue(item, childIndent)}`
        );
        return `{\n${lines.join(',\n')}\n${indent}}`;
    }
    throw new Error(`不支持序列化的值类型：${typeof value}`);
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let result = text;
    for (const edit of sorted) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result;
}

/** 修改后完整校验：语法、重复键、模型 id 唯一。 */
function validateResult(text: string): void {
    const root = parseJsonWithSpans(text);
    if (root.type !== 'object') {
        throw new Error('写入结果不是有效的配置对象');
    }
    const modelsProp = root.properties.find(prop => prop.key === 'models');
    if (!modelsProp || modelsProp.value.type !== 'array') {
        throw new Error('写入结果缺少 models 数组');
    }
    const seen = new Set<string>();
    for (const item of modelsProp.value.items) {
        if (item.type !== 'object') {
            throw new Error('写入结果的 models 元素不是对象');
        }
        const idProp = item.properties.find(prop => prop.key === 'id');
        const id = idProp && idProp.value.type === 'string' ? String((idProp.value as JsonValueNode).value) : undefined;
        if (!id || seen.has(id)) {
            throw new Error(`写入结果存在缺失或重复的模型 id "${id ?? ''}"`);
        }
        seen.add(id);
    }
}

/** 取属性键所在行的前导空白。 */
function detectIndent(text: string, objectNode: JsonObjectNode): string {
    const firstProp = objectNode.properties[0];
    if (!firstProp) {
        return '        ';
    }
    return text.slice(lineStartOf(text, firstProp.keyStart), firstProp.keyStart);
}

function lineStartOf(text: string, offset: number): number {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') {
        start--;
    }
    return start;
}

function indentWidthOf(text: string, offset: number): number {
    return offset - lineStartOf(text, offset);
}

function skipLineEnding(text: string, offset: number): number {
    if (text[offset] === '\r' && text[offset + 1] === '\n') {
        return offset + 2;
    }
    if (text[offset] === '\r' || text[offset] === '\n') {
        return offset + 1;
    }
    return offset;
}
