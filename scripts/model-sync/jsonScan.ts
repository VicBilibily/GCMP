/** 带源码位置的 JSON 解析器，用于格式保持编辑；检测重复键。 */

export interface JsonNode {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
    start: number;
    end: number;
}

export interface JsonProperty {
    key: string;
    keyStart: number;
    keyEnd: number;
    value: JsonAnyNode;
}

export interface JsonObjectNode extends JsonNode {
    type: 'object';
    properties: JsonProperty[];
}

export interface JsonArrayNode extends JsonNode {
    type: 'array';
    items: JsonAnyNode[];
}

export interface JsonValueNode extends JsonNode {
    type: 'string' | 'number' | 'boolean' | 'null';
    value: unknown;
}

export type JsonAnyNode = JsonObjectNode | JsonArrayNode | JsonValueNode;

export function parseJsonWithSpans(text: string): JsonAnyNode {
    const parser = new Parser(text);
    const node = parser.parseValue();
    parser.skipWhitespace();
    if (!parser.atEnd()) {
        throw parser.error('JSON 末尾存在多余内容');
    }
    return node;
}

class Parser {
    private pos = 0;

    constructor(private readonly text: string) {}

    atEnd(): boolean {
        return this.pos >= this.text.length;
    }

    error(message: string): Error {
        return new Error(`${message}（偏移 ${this.pos}）`);
    }

    skipWhitespace(): void {
        while (this.pos < this.text.length && /[\s]/.test(this.text[this.pos])) {
            this.pos++;
        }
    }

    parseValue(): JsonAnyNode {
        this.skipWhitespace();
        const ch = this.text[this.pos];
        if (ch === '{') {
            return this.parseObject();
        }
        if (ch === '[') {
            return this.parseArray();
        }
        if (ch === '"') {
            return this.parseString();
        }
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
            return this.parseNumber();
        }
        if (this.text.startsWith('true', this.pos)) {
            const start = this.pos;
            this.pos += 4;
            return { type: 'boolean', start, end: this.pos, value: true };
        }
        if (this.text.startsWith('false', this.pos)) {
            const start = this.pos;
            this.pos += 5;
            return { type: 'boolean', start, end: this.pos, value: false };
        }
        if (this.text.startsWith('null', this.pos)) {
            const start = this.pos;
            this.pos += 4;
            return { type: 'null', start, end: this.pos, value: null };
        }
        throw this.error('无效的 JSON 值');
    }

    private parseObject(): JsonObjectNode {
        const start = this.pos;
        this.pos++; // {
        const properties: JsonProperty[] = [];
        const seen = new Set<string>();
        this.skipWhitespace();
        if (this.text[this.pos] === '}') {
            return { type: 'object', start, end: ++this.pos, properties };
        }
        for (;;) {
            this.skipWhitespace();
            if (this.text[this.pos] !== '"') {
                throw this.error('对象键必须是字符串');
            }
            const keyNode = this.parseString();
            const key = keyNode.value as string;
            if (seen.has(key)) {
                throw this.error(`重复的对象键 "${key}"`);
            }
            seen.add(key);
            this.skipWhitespace();
            if (this.text[this.pos] !== ':') {
                throw this.error('对象键后缺少冒号');
            }
            this.pos++;
            const value = this.parseValue();
            properties.push({ key, keyStart: keyNode.start, keyEnd: keyNode.end, value });
            this.skipWhitespace();
            const ch = this.text[this.pos];
            if (ch === ',') {
                this.pos++;
                continue;
            }
            if (ch === '}') {
                return { type: 'object', start, end: ++this.pos, properties };
            }
            throw this.error('对象属性后缺少逗号或右括号');
        }
    }

    private parseArray(): JsonArrayNode {
        const start = this.pos;
        this.pos++; // [
        const items: JsonAnyNode[] = [];
        this.skipWhitespace();
        if (this.text[this.pos] === ']') {
            return { type: 'array', start, end: ++this.pos, items };
        }
        for (;;) {
            items.push(this.parseValue());
            this.skipWhitespace();
            const ch = this.text[this.pos];
            if (ch === ',') {
                this.pos++;
                continue;
            }
            if (ch === ']') {
                return { type: 'array', start, end: ++this.pos, items };
            }
            throw this.error('数组元素后缺少逗号或右括号');
        }
    }

    private parseString(): JsonValueNode {
        const start = this.pos;
        let end = this.pos + 1;
        for (;;) {
            const ch = this.text[end];
            if (ch === undefined) {
                throw this.error('字符串未闭合');
            }
            if (ch === '\\') {
                end += 2;
                continue;
            }
            if (ch === '"') {
                end++;
                break;
            }
            end++;
        }
        const raw = this.text.slice(start, end);
        this.pos = end;
        return { type: 'string', start, end, value: JSON.parse(raw) };
    }

    private parseNumber(): JsonValueNode {
        const start = this.pos;
        const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
        if (!match) {
            throw this.error('无效的数字');
        }
        this.pos += match[0].length;
        return { type: 'number', start, end: this.pos, value: Number(match[0]) };
    }
}
