import assert from 'node:assert/strict';
import test from 'node:test';
import {
    jsonSchemaToGeminiSchema,
    sanitizeToolSchema,
    sanitizeToolSchemaForSdkMode,
    sanitizeToolSchemaForTarget
} from './schemaSanitizer';

test('sanitizeToolSchema preserves user-defined property names in schema maps', () => {
    const input = {
        type: 'object',
        title: 'Root',
        markdownDescription: 'root description',
        properties: {
            scope: {
                type: 'string',
                title: 'Scope',
                markdownDescription: 'scope description'
            },
            deprecated: {
                type: 'boolean',
                deprecationMessage: 'legacy field'
            },
            tags: {
                type: 'array',
                items: {
                    type: 'string'
                }
            }
        }
    };

    const output = sanitizeToolSchema(input);

    assert.equal('title' in output, false);
    assert.equal('markdownDescription' in output, false);
    assert.deepEqual(Object.keys(output.properties), ['scope', 'deprecated', 'tags']);
    assert.deepEqual(output.properties.scope, { type: 'string' });
    assert.deepEqual(output.properties.deprecated, { type: 'boolean' });
    assert.deepEqual(output.properties.tags, {
        type: 'array',
        items: {
            type: 'string'
        }
    });
});

test('sanitizeToolSchema preserves dependencies and dependentSchemas payloads', () => {
    const input = {
        type: 'object',
        properties: {
            scope: { type: 'string' },
            tags: {
                type: 'array',
                items: { type: 'string' }
            }
        },
        dependencies: {
            scope: ['tags']
        },
        dependentSchemas: {
            scope: {
                type: 'object',
                properties: {
                    tags: {
                        type: 'array',
                        markdownDescription: 'tag list',
                        items: { type: 'string' }
                    }
                }
            }
        }
    };

    const output = sanitizeToolSchema(input);

    assert.deepEqual(output.dependencies, {
        scope: ['tags']
    });
    assert.deepEqual(output.dependentSchemas, {
        scope: {
            type: 'object',
            properties: {
                tags: {
                    type: 'array',
                    items: { type: 'string' }
                }
            }
        }
    });
});

test('sanitizeToolSchemaForSdkMode converts Gemini schemas to provider-safe subset', () => {
    const input = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        title: 'Root',
        additionalProperties: false,
        properties: {
            name: {
                type: 'string',
                default: 'alice',
                description: 'display name'
            },
            status: {
                const: 'ready'
            },
            nickname: {
                type: ['string', 'null'],
                description: 'optional nickname'
            }
        },
        required: ['name']
    };

    const output = sanitizeToolSchemaForSdkMode(input, 'gemini-sse') as Record<string, unknown>;
    const properties = output.properties as Record<string, Record<string, unknown>>;

    assert.deepEqual(output, {
        type: 'OBJECT',
        properties: {
            name: {
                type: 'STRING',
                description: 'display name'
            },
            status: {
                enum: ['ready']
            },
            nickname: {
                type: 'STRING',
                description: 'optional nickname',
                nullable: true
            }
        },
        required: ['name']
    });
    assert.equal('default' in properties.name, false);
    assert.equal('additionalProperties' in output, false);
    assert.equal('$schema' in output, false);
});

test('jsonSchemaToGeminiSchema resolves refs and strips unsupported metadata', () => {
    const input = {
        $defs: {
            SearchScope: {
                type: 'string',
                enum: ['repo', 'workspace'],
                title: 'Search scope'
            }
        },
        type: 'object',
        properties: {
            scope: {
                $ref: '#/$defs/SearchScope'
            }
        }
    };

    const output = jsonSchemaToGeminiSchema(input);

    assert.deepEqual(output, {
        type: 'OBJECT',
        properties: {
            scope: {
                type: 'STRING',
                enum: ['repo', 'workspace']
            }
        }
    });
});

test('sanitizeToolSchemaForTarget uses explicit OpenAI and Anthropic targets', () => {
    const input = {
        type: 'object',
        title: 'Root',
        properties: {
            name: {
                type: 'string',
                default: 'alice'
            }
        },
        additionalProperties: false
    };

    assert.deepEqual(sanitizeToolSchemaForTarget(input, 'openai'), {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                default: 'alice'
            }
        },
        additionalProperties: false
    });

    assert.deepEqual(sanitizeToolSchemaForTarget(input, 'anthropic'), {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                default: 'alice'
            }
        },
        additionalProperties: false
    });
});

test('jsonSchemaToGeminiSchema handles oneOf null, empty object properties, and empty array items', () => {
    const input = {
        type: 'object',
        properties: {
            nickname: {
                oneOf: [{ type: 'string', description: 'optional nickname' }, { type: 'null' }]
            },
            metadata: {
                type: 'object',
                properties: {}
            },
            buckets: {
                type: 'array',
                items: {}
            }
        },
        propertyOrdering: ['nickname', 'metadata', 'buckets']
    };

    assert.deepEqual(jsonSchemaToGeminiSchema(input), {
        type: 'OBJECT',
        properties: {
            nickname: {
                type: 'STRING',
                description: 'optional nickname',
                nullable: true
            },
            metadata: {
                type: 'OBJECT'
            },
            buckets: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT'
                }
            }
        },
        propertyOrdering: ['nickname', 'metadata', 'buckets']
    });
});

test('jsonSchemaToGeminiSchema preserves non-null unions as anyOf', () => {
    const input = {
        oneOf: [
            { type: 'string', description: 'as text' },
            { type: 'integer', description: 'as number' }
        ]
    };

    assert.deepEqual(jsonSchemaToGeminiSchema(input), {
        anyOf: [
            {
                type: 'STRING',
                description: 'as text'
            },
            {
                type: 'INTEGER',
                description: 'as number'
            }
        ]
    });
});
