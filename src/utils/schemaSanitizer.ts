/*---------------------------------------------------------------------------------------------
 *  Schema Sanitizer
 *  从 tool inputSchema 中移除 VS Code / JSON Schema UI 专用注解字段，
 *  避免将不被后端 API（Gemini、OpenAI、Anthropic 等）接受的字段透传出去。
 *--------------------------------------------------------------------------------------------*/

/**
 * 需要从 tool schema 中递归删除的字段集合，分两类：
 *
 * （1）VS Code 扩展注解：仅用于设置编辑器渲染，所有 LLM API 均不接受。
 * （2）标准 JSON Schema 元数据：虽属规范，但各 LLM API（尤其是 Gemini）
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

const geminiAllowedKeys = new Set<string>([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'propertyOrdering',
    'anyOf'
]);

export type ToolSchemaTarget = 'openai' | 'anthropic' | 'gemini';

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
 */
export function sanitizeToolSchema<T>(schema: T): T {
    return sanitizeToolSchemaForTarget(schema, 'openai');
}

/**
 * 按目标提供商方言生成最终用于工具声明的 schema。
 * 当前 OpenAI / Anthropic 走通用清洗，Gemini 额外做方言降级与字段白名单过滤。
 */
export function sanitizeToolSchemaForTarget<T>(schema: T, target: ToolSchemaTarget): T {
    const sanitized = sanitizeGenericToolSchema(schema);
    switch (target) {
        case 'gemini':
            return jsonSchemaToGeminiSchema(sanitized) as T;
        case 'anthropic':
        case 'openai':
        default:
            return sanitized;
    }
}

/**
 * 按目标 SDK 生成最终会发往模型请求体中的 schema。
 * Gemini 额外做方言转换与字段白名单过滤，保证发送链路与 token 统计一致。
 */
export function sanitizeToolSchemaForSdkMode<T>(schema: T, sdkMode?: string): T {
    return sanitizeToolSchemaForTarget(schema, resolveToolSchemaTargetFromSdkMode(sdkMode));
}

function resolveToolSchemaTargetFromSdkMode(sdkMode?: string): ToolSchemaTarget {
    switch (sdkMode) {
        case 'anthropic':
            return 'anthropic';
        case 'gemini-sse':
            return 'gemini';
        case 'openai':
        case 'openai-sse':
        case 'openai-responses':
        default:
            return 'openai';
    }
}

function sanitizeGenericToolSchema<T>(schema: T, insidePropertyMap = false): T {
    if (schema === null || schema === undefined) {
        return schema;
    }

    if (typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => sanitizeGenericToolSchema(item)) as unknown as T;
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
        result[key] = sanitizeGenericToolSchema(value, nextInsidePropertyMap);
    }
    return result as T;
}

/**
 * 将 JSON Schema 转成 Gemini functionDeclaration 可接受的 schema 子集。
 * 规则参考 promptfoo / LiteLLM / Google ADK 的通用做法：
 * - 先展开 $ref
 * - 将 anyOf/oneOf + null 降级为 nullable
 * - 将 type 转为 Gemini 大写枚举
 * - 最后按 Gemini 支持字段递归白名单过滤
 */
export function jsonSchemaToGeminiSchema(
    jsonSchema: unknown,
    rootSchema: unknown = jsonSchema,
    refStack: Set<string> | undefined = undefined
): Record<string, unknown> {
    if (!jsonSchema || typeof jsonSchema !== 'object') {
        return {};
    }

    const root =
        rootSchema && typeof rootSchema === 'object'
            ? (rootSchema as Record<string, unknown>)
            : (jsonSchema as Record<string, unknown>);
    const stack = refStack instanceof Set ? refStack : new Set<string>();

    const refRaw = (jsonSchema as Record<string, unknown>).$ref;
    const ref = typeof refRaw === 'string' ? String(refRaw).trim() : '';
    if (ref) {
        if (stack.has(ref)) {
            return {};
        }
        stack.add(ref);

        const resolved = (() => {
            if (ref === '#') {
                return root;
            }
            if (!ref.startsWith('#/')) {
                return null;
            }
            const decode = (token: string) => token.replace(/~1/g, '/').replace(/~0/g, '~');
            const parts = ref
                .slice(2)
                .split('/')
                .map(part => decode(part));
            let current: unknown = root;
            for (const part of parts) {
                if (!current || typeof current !== 'object') {
                    return null;
                }
                if (!(part in (current as Record<string, unknown>))) {
                    return null;
                }
                current = (current as Record<string, unknown>)[part];
            }
            return current && typeof current === 'object' ? (current as Record<string, unknown>) : null;
        })();

        const merged: Record<string, unknown> = {
            ...(resolved && typeof resolved === 'object' ? resolved : {}),
            ...(jsonSchema as Record<string, unknown>)
        };
        delete merged.$ref;
        const output = jsonSchemaToGeminiSchema(merged, root, stack);
        stack.delete(ref);
        return output;
    }

    const input = { ...(jsonSchema as Record<string, unknown>) };
    const output: Record<string, unknown> = {};

    let anyOf: unknown[] | null = null;
    if (Array.isArray(input.anyOf)) {
        anyOf = input.anyOf as unknown[];
    } else if (Array.isArray(input.oneOf)) {
        anyOf = input.oneOf as unknown[];
    }
    if (anyOf && anyOf.length > 0) {
        const variants = anyOf.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
        const nonNullVariants = variants.filter(item => item.type !== 'null');
        const hasNullVariant = nonNullVariants.length !== variants.length;

        if (hasNullVariant) {
            output.nullable = true;
        }

        if (nonNullVariants.length === 1) {
            return filterGeminiSchemaFields({
                ...output,
                ...jsonSchemaToGeminiSchema(nonNullVariants[0], root, stack)
            });
        }

        if (nonNullVariants.length > 1) {
            output.anyOf = nonNullVariants.map(variant => jsonSchemaToGeminiSchema(variant, root, stack));
            return filterGeminiSchemaFields(output);
        }

        if (hasNullVariant) {
            output.type = 'OBJECT';
            return filterGeminiSchemaFields(output);
        }
    }

    if (Array.isArray(input.type)) {
        const typeList = (input.type as unknown[]).filter(type => typeof type === 'string') as string[];
        if (typeList.length > 0) {
            const nonNullTypes = typeList.filter(type => type !== 'null');
            const hasNullType = nonNullTypes.length !== typeList.length;

            if (hasNullType) {
                output.nullable = true;
            }

            if (nonNullTypes.length === 1) {
                return filterGeminiSchemaFields({
                    ...output,
                    ...jsonSchemaToGeminiSchema(
                        { ...input, type: nonNullTypes[0], anyOf: undefined, oneOf: undefined },
                        root,
                        stack
                    )
                });
            }

            if (nonNullTypes.length > 1) {
                output.anyOf = nonNullTypes.map(type =>
                    jsonSchemaToGeminiSchema({ ...input, type, anyOf: undefined, oneOf: undefined }, root, stack)
                );
                return filterGeminiSchemaFields(output);
            }

            output.type = 'OBJECT';
            return filterGeminiSchemaFields(output);
        }
    }

    const rawType = typeof input.type === 'string' ? input.type : '';
    if (rawType && rawType !== 'null') {
        const mapped = mapJsonSchemaType(rawType);
        if (mapped) {
            output.type = mapped;
        }
    }

    if (Array.isArray(input.enum) && input.enum.length > 0) {
        output.enum = input.enum;
    }

    if (input.const !== undefined && !('enum' in output)) {
        output.enum = [input.const];
    }

    if (typeof input.description === 'string' && input.description.trim()) {
        output.description = input.description;
    }

    if (typeof input.format === 'string' && input.format.trim()) {
        output.format = input.format;
    }

    if (Array.isArray(input.propertyOrdering)) {
        output.propertyOrdering = input.propertyOrdering.filter(value => typeof value === 'string');
    }

    if (typeof input.minItems === 'number') {
        output.minItems = input.minItems;
    }
    if (typeof input.maxItems === 'number') {
        output.maxItems = input.maxItems;
    }
    if (typeof input.minLength === 'number') {
        output.minLength = input.minLength;
    }
    if (typeof input.maxLength === 'number') {
        output.maxLength = input.maxLength;
    }
    if (typeof input.minimum === 'number') {
        output.minimum = input.minimum;
    }
    if (typeof input.maximum === 'number') {
        output.maximum = input.maximum;
    }

    if (input.items && typeof input.items === 'object') {
        const itemSchema = input.items as Record<string, unknown>;
        output.items =
            Object.keys(itemSchema).length === 0
                ? { type: 'OBJECT' }
                : jsonSchemaToGeminiSchema(itemSchema, root, stack);
    }

    if (input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)) {
        const properties: Record<string, unknown> = {};
        for (const [propertyKey, propertyValue] of Object.entries(input.properties as Record<string, unknown>)) {
            if (!propertyValue || typeof propertyValue !== 'object') {
                continue;
            }
            properties[propertyKey] = jsonSchemaToGeminiSchema(propertyValue, root, stack);
        }
        output.properties = properties;
    }

    if (Array.isArray(input.required)) {
        output.required = Array.from(new Set((input.required as unknown[]).filter(value => typeof value === 'string')));
    }

    if (!output.type && output.properties && typeof output.properties === 'object') {
        output.type = 'OBJECT';
    }

    if (output.properties && typeof output.properties === 'object' && Object.keys(output.properties).length === 0) {
        delete output.properties;
        delete output.required;
        output.type = 'OBJECT';
    }

    return filterGeminiSchemaFields(output);
}

function filterGeminiSchemaFields(schema: Record<string, unknown>): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (!geminiAllowedKeys.has(key) || value == null) {
            continue;
        }

        if (key === 'properties' && typeof value === 'object' && !Array.isArray(value)) {
            const properties: Record<string, unknown> = {};
            for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
                if (!propertyValue || typeof propertyValue !== 'object') {
                    continue;
                }
                properties[propertyKey] = filterGeminiSchemaFields(propertyValue as Record<string, unknown>);
            }
            filtered[key] = properties;
            continue;
        }

        if (key === 'items' && typeof value === 'object' && !Array.isArray(value)) {
            filtered[key] = filterGeminiSchemaFields(value as Record<string, unknown>);
            continue;
        }

        if (key === 'anyOf' && Array.isArray(value)) {
            filtered[key] = value
                .filter(item => item && typeof item === 'object')
                .map(item => filterGeminiSchemaFields(item as Record<string, unknown>));
            continue;
        }

        filtered[key] = value;
    }
    return filtered;
}

function mapJsonSchemaType(type: string): string | undefined {
    switch ((type || '').toLowerCase()) {
        case 'string':
            return 'STRING';
        case 'number':
            return 'NUMBER';
        case 'integer':
            return 'INTEGER';
        case 'boolean':
            return 'BOOLEAN';
        case 'object':
            return 'OBJECT';
        case 'array':
            return 'ARRAY';
        default:
            return undefined;
    }
}
