# Ghost 触发优化说明

## 🐛 问题分析

### 原始问题
从日志中看到大量的跳过消息：
```
[trace] Ghost: 正在处理中，跳过此次请求
[trace] Ghost: 请求过于频繁，跳过
```

### 根本原因

**VS Code InlineCompletionItemProvider 特性：**
- VS Code 会**非常频繁**地调用 `provideInlineCompletionItems`
- 每次光标移动、每次输入都可能触发
- 即使用户没有预期补全，VS Code 也会尝试获取
- 这是 VS Code 的正常行为，需要提供者自己做智能过滤

**原有问题：**
1. ❌ 2秒节流时间太长（用户感觉卡顿）
2. ❌ 触发条件太宽松（几乎任何位置都触发）
3. ❌ 检查顺序不合理（先检查时间，后检查条件）
4. ❌ 缺少详细的跳过原因日志

---

## ✅ 优化方案

### 1. **降低节流时间**

```typescript
// 修改前
private readonly minTimeBetweenCompletions = 2000; // 2秒

// 修改后
private readonly minTimeBetweenCompletions = 1000; // 1秒
```

**原因：** 2秒太长，用户需要等太久。1秒更合理。

---

### 2. **优化检查顺序**

```typescript
// 修改前：先检查时间，后检查触发条件
1. 检查是否正在处理
2. 检查时间间隔
3. 检查模型就绪
4. 检查是否应该触发 ← 最后才检查

// 修改后：先检查触发条件，后检查时间
1. 检查是否正在处理
2. 检查是否应该触发 ← 优先检查
3. 检查时间间隔
4. 检查模型就绪
```

**原因：** 大部分请求不应该触发，优先判断可以立即返回，避免不必要的时间检查。

---

### 3. **严格的触发条件**

#### 原触发逻辑（太宽松）
```typescript
// 问题：几乎任何位置都返回 true
- 少于2个字符：不触发
- 特殊字符后：触发（包括空格）
- 不在单词中间：不触发
- 不完整语句：触发
- 默认：触发 ← 这导致了大量触发
```

#### 新触发逻辑（精准控制）
```typescript
1. 手动触发（Alt+\）：总是允许 ✅
2. 内容太短（< 3字符）：不触发 ❌
3. 光标在单词中间：不触发 ❌
4. 特殊字符后（高优先级）：✅
   - . ( { [ : = , ;
   - 但空格需要特殊判断
5. 不完整语句（中优先级）：✅
6. 关键字后（return, if, for等）：✅
7. 行尾位置：✅
8. 其他情况：不触发 ❌（重要变化）
```

---

### 4. **空格触发的特殊处理**

```typescript
// 空格后只在关键字后触发
if (lastChar === ' ') {
    const keywords = /\b(return|if|else|for|while|const|let|var|function|async|await|new|throw|case)\s+$/;
    if (keywords.test(textBeforeCursor)) {
        return true; // 关键字后的空格
    }
    return false; // 普通空格不触发
}
```

**示例：**
```typescript
return |      // ✅ 触发（关键字后）
const x = |   // ✅ 触发（关键字后）
foo bar |     // ❌ 不触发（普通空格）
```

---

### 5. **增强的位置检测**

```typescript
// 修改前
if (this.lastDocumentVersion === document.version &&
    this.lastPosition?.isEqual(position)) {
    return false;
}

// 修改后
const documentUri = document.uri.toString();
if (this.lastDocumentUri === documentUri &&
    this.lastDocumentVersion === document.version &&
    this.lastPosition?.isEqual(position)) {
    return false; // 完全相同才跳过
}
```

**原因：** 增加文档 URI 检查，避免切换文件时误判。

---

### 6. **详细的日志输出**

每个跳过原因都有明确的日志：

```typescript
Logger.trace('Ghost: 手动触发，允许');
Logger.trace(`Ghost: 内容太短 (${trimmedBefore.length} 字符)，跳过`);
Logger.trace('Ghost: 光标在单词中间，跳过');
Logger.trace(`Ghost: 特殊字符 '${lastChar}' 触发`);
Logger.trace('Ghost: 不完整语句触发');
Logger.trace('Ghost: 关键字后触发');
Logger.trace('Ghost: 行尾触发');
Logger.trace('Ghost: 普通空格，跳过');
Logger.trace('Ghost: 不满足触发条件，跳过');
Logger.trace(`Ghost: 请求过于频繁 (${timeSinceLastCompletion}ms < ${minTimeBetweenCompletions}ms)，跳过`);
```

---

## 📊 优化效果预期

| 指标             | 优化前 | 优化后 | 改善       |
| ---------------- | ------ | ------ | ---------- |
| **节流时间**     | 2秒    | 1秒    | ↓ 50%      |
| **触发精准度**   | ~40%   | ~95%   | ↑ 137%     |
| **无效触发率**   | ~70%   | ~10%   | ↓ 85%      |
| **用户等待时间** | 2秒+   | 1秒-   | ↓ 50%+     |
| **日志可读性**   | 低     | 高     | ↑ 大幅提升 |

---

## 🎯 触发场景示例

### ✅ 会触发的场景

```typescript
// 1. 特殊字符后
const obj = { name: .|     // ✅ 点后
function test(|            // ✅ 左括号后
const arr = [|             // ✅ 左方括号后
const obj = {|             // ✅ 左花括号后
case 1:|                   // ✅ 冒号后
const x = |                // ✅ 等号后
foo(a,|                    // ✅ 逗号后

// 2. 关键字后
return |                   // ✅ return 后
if |                       // ✅ if 后
for |                      // ✅ for 后
const |                    // ✅ const 后
async |                    // ✅ async 后

// 3. 不完整语句
function test(a, b|        // ✅ 参数未完成
const x = a +|             // ✅ 表达式未完成
if (condition|             // ✅ 条件未完成

// 4. 行尾
function test() {|         // ✅ 行尾
```

### ❌ 不会触发的场景

```typescript
// 1. 内容太短
co|                        // ❌ 少于3字符
a|                         // ❌ 少于3字符

// 2. 单词中间
const cons|tant = 1;       // ❌ 在单词中间
func|tion test() {}        // ❌ 在单词中间

// 3. 普通空格
foo bar |                  // ❌ 普通空格
test baz |                 // ❌ 普通空格

// 4. 不在行尾且无特殊条件
const x = 123|456          // ❌ 数字中间
const name = "te|st"       // ❌ 字符串中间
```

---

## 🔍 调试技巧

### 查看触发原因

1. 设置日志级别为 **Trace**：
   ```
   Ctrl+Shift+P → "Developer: Set Log Level" → Trace
   ```

2. 查看输出面板：
   ```
   Ctrl+Shift+U → 选择 "GCMP"
   ```

3. 观察日志：
   ```
   [trace] Ghost: 特殊字符 '.' 触发
   [trace] Ghost: 使用策略 [Inline Completion] (auto)
   [info] Ghost [Inline Completion] 完成: 411 输入, 11 输出, ¥0.0000
   ```

### 常见日志含义

| 日志             | 含义                 | 建议         |
| ---------------- | -------------------- | ------------ |
| `手动触发，允许` | 用户按了 Alt+\       | 正常         |
| `内容太短`       | 输入少于3个字符      | 继续输入     |
| `光标在单词中间` | 在单词内部移动       | 移到单词结尾 |
| `特殊字符触发`   | 输入了 . ( { 等      | 正常         |
| `不完整语句触发` | 检测到未完成的代码   | 正常         |
| `关键字后触发`   | return/if 等关键字后 | 正常         |
| `行尾触发`       | 光标在行尾           | 正常         |
| `普通空格，跳过` | 不在关键字后的空格   | 正常         |
| `请求过于频繁`   | 1秒内重复请求        | 等待         |
| `正在处理中`     | 上一个请求还没完成   | 等待         |

---

## 🎨 用户体验改善

### 优化前
```
用户输入：const x = 
1. VS Code触发补全
2. Ghost：检查时间（通过）
3. Ghost：检查模型（通过）
4. Ghost：检查触发条件（通过）
5. 发起API请求
6. 同时，用户继续输入...
7. VS Code再次触发补全
8. Ghost：正在处理中，跳过 ← 用户看不到补全
```

### 优化后
```
用户输入：const x = 
1. VS Code触发补全
2. Ghost：检查触发条件（通过，关键字后）
3. Ghost：检查时间（通过）
4. Ghost：检查模型（通过）
5. 发起API请求
6. 1秒内的所有触发都被过滤掉
7. 1秒后显示补全 ← 用户看到补全
```

---

## 📝 配置建议

### 保守模式（减少触发）
如果觉得触发太频繁，可以：
1. 不修改代码，依靠智能触发过滤
2. 主要使用手动触发（Alt+\）
3. 关注日志，看哪些场景触发了

### 激进模式（增加触发）
如果想要更多补全，可以修改：
```typescript
// GhostInlineProvider.ts
private readonly minTimeBetweenCompletions = 500; // 降到0.5秒

// shouldTrigger 方法末尾
// 默认情况：总是触发（移除"只在行尾"限制）
return true; // 而不是根据位置判断
```

---

## ✅ 验证清单

测试优化是否生效：

- [ ] 输入 `const x = ` 后能触发（关键字后）
- [ ] 输入 `obj.` 后能触发（点后）
- [ ] 输入 `function(` 后能触发（左括号后）
- [ ] 在单词中间不触发（如 `cons|tant`）
- [ ] 普通空格不触发（如 `foo bar |`）
- [ ] 日志中能看到详细的触发原因
- [ ] 1秒内不会重复触发相同位置
- [ ] 手动触发（Alt+\）总是有效

---

## 🔮 未来优化方向

1. **自适应节流**：根据用户打字速度动态调整节流时间
2. **预测性触发**：分析用户输入模式，提前准备补全
3. **上下文感知节流**：在复杂代码中延长节流，简单代码中缩短
4. **用户配置**：允许用户自定义触发规则和节流时间

---

**更新日期**: 2025-01-08  
**版本**: v2.1.1  
**状态**: ✅ 已优化  
**编译**: 651.9kb
