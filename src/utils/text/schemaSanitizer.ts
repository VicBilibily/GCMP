/*---------------------------------------------------------------------------------------------
 *  Schema Sanitizer
 *  从 tool inputSchema 中移除 VS Code / JSON Schema UI 专用注解字段，
 *  避免将不被后端 API 接受的字段透传出去。
 *--------------------------------------------------------------------------------------------*/

/**
 * 需要从 tool schema 中递归删除的字段集合，分两类：
 *
 * （1）VS Code 扩展注解：仅用于设置编辑器渲染，所有 LLM API 均不接受。
 * （2）标准 JSON Schema 元数据：虽属规范，但各 LLM API
 *     明确拒绝这些字段，故统一剔除。
 */
const droppedKeys = new Set<string>([
    // ── VS Code 扩展注解字段 ──
    'enumDescriptions',
    'markdownEnumDescriptions',
    'markdownDescription',
    'deprecationMessage',
    'markdownDeprecationMessage',
    'errorMessage',
    'patternErrorMessage',
    'enumItemLabels',
    'order',
    'editPresentation',
    'scope',
    'tags',
    // ── 标准 JSON Schema 元数据 ──
    '$schema',
    '$id',
    '$comment',
    'title',
    'readOnly',
    'writeOnly',
    'deprecated'
]);

const propertyMapKeywords = new Set<string>([
    'properties',
    '$defs',
    'definitions',
    'patternProperties',
    'dependentSchemas',
    'dependencies',
    'dependentRequired'
]);

/**
 * 递归移除 JSON Schema 对象中的 VS Code 扩展注解字段。
 *
 * - 对基本类型（string / number / boolean / null）直接返回原值。
 * - 对数组递归处理每个元素。
 * - 对对象递归处理每个值，并跳过 `droppedKeys` 中列出的键。
 *
 * 关键：`properties` / `$defs` / `definitions` / `patternProperties` 的值
 * 是「名称 → schema」映射，其键是用户自定义的参数名 / 类型名（可能与
 * droppedKeys 重名，例如 `scope`、`deprecated`、`tags` 等），在这一层不做
 * key 过滤，仅对每个 schema 值继续递归过滤。
 *
 * 该函数返回的是新对象，不会修改原始输入。
 *
 * @param schema - 待清洗的 JSON Schema 对象（或任意值）
 * @param insidePropertyMap - 内部使用：当前是否处于属性名映射层
 */
export function sanitizeToolSchema<T>(schema: T, insidePropertyMap = false): T {
    if (schema === null || schema === undefined) {
        return schema;
    }

    if (typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => sanitizeToolSchema(item, insidePropertyMap)) as unknown as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        // 当处于「名称 → schema」映射层时（properties / $defs 等的值），
        // key 是参数名或类型名，不是 schema 注解字段，不可过滤。
        if (!insidePropertyMap && droppedKeys.has(key)) {
            continue;
        }

        // 以下关键字的值是「名称 → schema」映射：进入下一层时须跳过 key 过滤。
        // 关键：仅当当前层本身是 schema 结构层（!insidePropertyMap）时才判断。
        // 若已处于属性名映射层（insidePropertyMap=true），key 是用户定义的参数名，
        // 即便参数名恰好为 'properties'/'$defs' 等，其值也是一个普通 schema，
        // 不应再次标记为属性名映射层，否则该 schema 的注解字段将被漏掉。
        const nextInsidePropertyMap = !insidePropertyMap && propertyMapKeywords.has(key);
        result[key] = sanitizeToolSchema(value, nextInsidePropertyMap);
    }
    return result as T;
}
