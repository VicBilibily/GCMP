/** JSONC 注释剥离：字符串字面量原样保留，注释内换行保留以维持 JSON.parse 错误行号。 */
export function stripJsonComments(text: string): string {
    let output = '';
    let inString = false;
    let escaped = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            index++;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            index++;
            continue;
        }
        if (char === '/' && text[index + 1] === '/') {
            index += 2;
            while (index < text.length && text[index] !== '\n') {
                index++;
            }
            continue;
        }
        if (char === '/' && text[index + 1] === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                if (text[index] === '\n' || text[index] === '\r') {
                    output += text[index];
                }
                index++;
            }
            index = Math.min(index + 2, text.length);
            continue;
        }
        output += char;
        index++;
    }
    return output;
}

export function parseJsonc<T>(text: string): T {
    return JSON.parse(stripJsonComments(text)) as T;
}
