/*---------------------------------------------------------------------------------------------
 *  工具转换器
 *  将 VS Code 工具定义转换为 AI SDK 格式
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { Logger } from '../../utils/logger';

type ToolInput = Record<string, unknown>;
type ToolInputSchema = z.ZodType<ToolInput>;
export type AiSdkToolSet = Record<string, Tool<ToolInputSchema, unknown>>;

/** 判断 Zod schema 是否可作为工具输入参数（ZodObject / ZodRecord / 其组合） */
function isToolInputSchema(schema: z.ZodTypeAny): schema is ToolInputSchema {
    if (schema instanceof z.ZodObject || schema instanceof z.ZodRecord) {
        return true;
    }

    if (schema instanceof z.ZodUnion) {
        return schema.options.length > 0 && schema.options.every(isToolInputSchema);
    }

    if (schema instanceof z.ZodIntersection) {
        return isToolInputSchema(schema._def.left) && isToolInputSchema(schema._def.right);
    }

    return false;
}

/** 将多个子 schema 转为 ZodUnion */
function createUnionSchema(schemas: readonly object[]): z.ZodTypeAny {
    const zodSchemas = schemas.map(jsonSchemaToZod);

    if (zodSchemas.length === 0) {
        return z.never();
    }

    if (zodSchemas.length === 1) {
        return zodSchemas[0];
    }

    const [first, second, ...rest] = zodSchemas;
    return z.union([first, second, ...rest]);
}

/** 将多个子 schema 交叉合并（对应 JSON Schema allOf） */
function createIntersectionSchema(schemas: readonly object[]): z.ZodTypeAny {
    const zodSchemas = schemas.map(jsonSchemaToZod);

    if (zodSchemas.length === 0) {
        return z.object({});
    }

    return zodSchemas.slice(1).reduce((current, next) => z.intersection(current, next), zodSchemas[0]);
}

/**
 * 将 JSON Schema 转换为 Zod schema
 *
 * 支持的类型：
 * - string, number, integer, boolean, null
 * - object (嵌套)
 * - array
 * - enum
 * - oneOf, anyOf, allOf
 */
function jsonSchemaToZod(schema: object | undefined): z.ZodTypeAny {
    if (!schema) {
        return z.object({});
    }

    const jsonSchema = schema as Record<string, unknown>;
    const type = jsonSchema.type as string | string[] | undefined;

    // 处理 enum
    if (jsonSchema.enum) {
        const enumValues = jsonSchema.enum as (string | number | boolean | null)[];
        return z.enum(enumValues.map(String) as [string, ...string[]]);
    }

    // 处理 oneOf
    if (jsonSchema.oneOf) {
        const oneOfSchemas = jsonSchema.oneOf as object[];
        return createUnionSchema(oneOfSchemas);
    }

    // 处理 anyOf
    if (jsonSchema.anyOf) {
        const anyOfSchemas = jsonSchema.anyOf as object[];
        return createUnionSchema(anyOfSchemas);
    }

    // 处理 allOf (合并所有属性)
    if (jsonSchema.allOf) {
        const allOfSchemas = jsonSchema.allOf as object[];
        return createIntersectionSchema(allOfSchemas);
    }

    // 根据类型处理
    if (!type) {
        return z.any();
    }

    const types = Array.isArray(type) ? type : [type];

    // 处理多个类型
    if (types.length > 1) {
        const zodTypes = types.map(t => getZodTypeForSingleType(t, jsonSchema));
        return z.union(zodTypes as [z.ZodTypeAny, z.ZodTypeAny]);
    }

    // 处理单个类型
    return getZodTypeForSingleType(types[0], jsonSchema);
}

/** 将 JSON Schema 工具参数转换为 Zod 对象 schema，根非对象时降级为 z.record */
function jsonSchemaToToolInputSchema(schema: object | undefined): ToolInputSchema {
    const zodSchema = jsonSchemaToZod(schema);
    if (isToolInputSchema(zodSchema)) {
        return zodSchema;
    }
    Logger.warn('[ToolConverter] Tool input schema root is not an object; using permissive object schema');
    return z.record(z.string(), z.unknown());
}

/**
 * 根据单个类型获取对应的 Zod 类型
 */
function getZodTypeForSingleType(type: string, jsonSchema: Record<string, unknown>): z.ZodTypeAny {
    switch (type) {
        case 'string':
            return createStringSchema(jsonSchema);

        case 'number':
        case 'integer':
            return createNumberSchema(jsonSchema);

        case 'boolean':
            return z.boolean();

        case 'null':
            return z.null();

        case 'array':
            return createArraySchema(jsonSchema);

        case 'object':
            return createObjectSchema(jsonSchema);

        default:
            return z.any();
    }
}

/**
 * 创建 String Schema
 */
function createStringSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
    // 先创建基础 string schema，添加所有字符串约束
    let baseSchema: z.ZodString = z.string();

    // minLength
    if (jsonSchema.minLength !== undefined) {
        baseSchema = baseSchema.min(jsonSchema.minLength as number);
    }

    // maxLength
    if (jsonSchema.maxLength !== undefined) {
        baseSchema = baseSchema.max(jsonSchema.maxLength as number);
    }

    // pattern
    if (jsonSchema.pattern) {
        baseSchema = baseSchema.regex(new RegExp(jsonSchema.pattern as string));
    }

    // format
    if (jsonSchema.format) {
        switch (jsonSchema.format) {
            case 'email':
                baseSchema = baseSchema.email();
                break;
            case 'uri':
            case 'url':
                baseSchema = baseSchema.url();
                break;
            case 'uuid':
                baseSchema = baseSchema.uuid();
                break;
            case 'date-time':
                baseSchema = baseSchema.datetime();
                break;
        }
    }

    // 最后添加描述或默认值（这些会改变 schema 类型）
    let schema: z.ZodTypeAny = baseSchema;

    // 添加描述
    if (jsonSchema.description) {
        schema = schema.describe(jsonSchema.description as string);
    }

    // 添加默认值
    if (jsonSchema.default !== undefined) {
        schema = baseSchema.default(jsonSchema.default as string);
    }

    return schema;
}

/**
 * 创建 Number Schema
 */
function createNumberSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
    // 先创建基础 number schema，添加所有数值约束
    let baseSchema: z.ZodNumber = jsonSchema.type === 'integer' ? z.number().int() : z.number();

    // minimum
    if (jsonSchema.minimum !== undefined) {
        baseSchema = baseSchema.min(jsonSchema.minimum as number);
    }

    // maximum
    if (jsonSchema.maximum !== undefined) {
        baseSchema = baseSchema.max(jsonSchema.maximum as number);
    }

    // exclusiveMinimum
    if (jsonSchema.exclusiveMinimum !== undefined) {
        baseSchema = baseSchema.gt(jsonSchema.exclusiveMinimum as number);
    }

    // exclusiveMaximum
    if (jsonSchema.exclusiveMaximum !== undefined) {
        baseSchema = baseSchema.lt(jsonSchema.exclusiveMaximum as number);
    }

    // multipleOf
    if (jsonSchema.multipleOf !== undefined) {
        baseSchema = baseSchema.multipleOf(jsonSchema.multipleOf as number);
    }

    // 最后添加描述或默认值（这些会改变 schema 类型）
    let schema: z.ZodTypeAny = baseSchema;

    // 添加描述
    if (jsonSchema.description) {
        schema = schema.describe(jsonSchema.description as string);
    }

    // 添加默认值
    if (jsonSchema.default !== undefined) {
        schema = baseSchema.default(jsonSchema.default as number);
    }

    return schema;
}

/**
 * 创建 Array Schema
 */
function createArraySchema(jsonSchema: Record<string, unknown>): z.ZodArray<z.ZodTypeAny> {
    const items = jsonSchema.items as object | undefined;
    const itemSchema = items ? jsonSchemaToZod(items) : z.any();

    let schema = z.array(itemSchema);

    // 添加描述
    if (jsonSchema.description) {
        schema = schema.describe(jsonSchema.description as string);
    }

    // minItems
    if (jsonSchema.minItems !== undefined) {
        schema = schema.min(jsonSchema.minItems as number);
    }

    // maxItems
    if (jsonSchema.maxItems !== undefined) {
        schema = schema.max(jsonSchema.maxItems as number);
    }

    return schema;
}

/**
 * 创建 Object Schema
 */
function createObjectSchema(jsonSchema: Record<string, unknown>): z.ZodTypeAny {
    const properties = jsonSchema.properties as Record<string, object> | undefined;
    const required = jsonSchema.required as string[] | undefined;

    if (!properties) {
        return z.record(z.string(), z.any());
    }

    const zodProperties: Record<string, z.ZodTypeAny> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
        let zodProp = jsonSchemaToZod(propSchema);

        // 如果不是必需字段，标记为可选
        if (!required || !required.includes(key)) {
            zodProp = zodProp.optional();
        }

        zodProperties[key] = zodProp;
    }

    let schema: z.ZodTypeAny = z.object(zodProperties);

    // 添加描述
    if (jsonSchema.description) {
        schema = schema.describe(jsonSchema.description as string);
    }

    // additionalProperties
    if (jsonSchema.additionalProperties === false) {
        schema = z.object(zodProperties).strict();
    }

    return schema;
}

/**
 * 转换 VS Code 工具定义为 AI SDK ToolSet 格式
 *
 * 注意：不提供 execute 函数，工具调用由 VS Code 处理
 */
export function convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined
): AiSdkToolSet | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    const toolSet: AiSdkToolSet = {};

    for (const toolDef of tools) {
        toolSet[toolDef.name] = tool({
            description: toolDef.description,
            parameters: jsonSchemaToToolInputSchema(toolDef.inputSchema)
            // 不提供 execute 函数，工具调用由 VS Code 处理
        });
    }

    return toolSet;
}
