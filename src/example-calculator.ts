// 示例文件 - 用于演示apply_diff工具
class Calculator {
    add(a: number, b: number): number {
        // 添加参数验证
        if (typeof a !== 'number' || typeof b !== 'number') {
            throw new Error('参数必须是数字类型');
        }
        return a + b;
    }

    multiply(a: number, b: number): number {
        return a * b;
    }

    divide(a: number, b: number): number {
        if (typeof a !== 'number' || typeof b !== 'number') {
            throw new Error('参数必须是数字类型');
        }
        if (b === 0) {
            throw new Error('除数不能为零');
        }
        return a / b;
    }
}

export default Calculator;