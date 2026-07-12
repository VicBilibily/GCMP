import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeToolSchema } from './schemaSanitizer';

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

test('sanitizeToolSchema strips VS Code UI annotations while preserving schema structure', () => {
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

    assert.deepEqual(sanitizeToolSchema(input), {
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
