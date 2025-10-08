# Ghost 防抖逻辑优化

## 问题背景

### 之前的问题
使用**节流（Throttle）逻辑**导致大量请求被跳过：
- 第一个请求开始处理后，在 1 秒内的所有后续请求都被直接拒绝
- 用户快速输入 "abcde" 时，只处理 "a" 的状态，"bcde" 的请求全部被跳过
- 日志显示 70%+ 的请求被跳过："正在处理中，跳过此次请求"
- 导致补全基于过时的上下文，用户体验差

### 节流 vs 防抖
- **Throttle（节流）**：固定时间间隔内只执行第一个请求
  - 适用场景：滚动事件、窗口缩放
  - Ghost 代码补全的问题：处理的是过时的状态（第一个字符）
  
- **Debounce（防抖）**：等待用户停止操作后执行最后一个请求
  - 适用场景：搜索框输入、代码补全
  - Ghost 代码补全的优势：处理的是最新的状态（完整输入）

## 新的防抖逻辑

### 核心原理
```
用户输入:  a → b → c → d → e → (停止)
防抖处理:  ❌   ❌   ❌   ❌   ❌     ✅ (800ms 后触发)
节流处理:  ✅   ❌   ❌   ❌   ❌     (处理 "a"，其他被跳过)
```

### 实现机制

#### 1. 请求ID管理
```typescript
private currentRequestId = 0;  // 全局递增的请求ID
private activeRequestId: number | null = null;  // 当前正在执行的请求
```

每个请求都有唯一的ID，用于追踪和验证请求是否过期。

#### 2. 防抖计时器
```typescript
private debounceTimer: NodeJS.Timeout | undefined;
private readonly debounceDelay = 800; // 800ms
```

用户每次输入都会：
1. 清除之前的计时器
2. 创建新的计时器
3. 只有 800ms 内没有新输入时才会触发请求

#### 3. 请求流程

```typescript
provideInlineCompletionItems() {
    const requestId = ++this.currentRequestId; // 生成新ID
    
    // 手动触发：立即处理，不防抖
    if (context.triggerKind === Invoke) {
        return this.generateCompletion(..., requestId);
    }
    
    // 自动触发：防抖
    return new Promise((resolve) => {
        // 清除旧计时器
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // 设置新计时器
        this.debounceTimer = setTimeout(async () => {
            // 检查请求是否过期
            if (requestId !== this.currentRequestId) {
                resolve(null); // 已被更新的请求取代
                return;
            }
            
            // 检查取消
            if (token.isCancellationRequested) {
                resolve(null);
                return;
            }
            
            // 执行补全生成
            const result = await this.generateCompletion(..., requestId);
            resolve(result);
        }, this.debounceDelay);
    });
}
```

#### 4. 并发控制

```typescript
private async generateCompletion(..., requestId: number) {
    // 记录活跃请求
    if (this.activeRequestId !== null) {
        Logger.trace(`已有活跃请求 #${this.activeRequestId}`);
        // 当前请求会继续，但会被记录
    }
    
    try {
        this.activeRequestId = requestId;
        
        // ... 生成补全 ...
        
    } finally {
        // 只清除自己的活跃标记
        if (this.activeRequestId === requestId) {
            this.activeRequestId = null;
        }
    }
}
```

## 效果对比

### 场景 1：快速输入
```
用户输入: "const user = { name: 'John', age: 30 }"

节流逻辑 (旧):
  - 请求 #1: "const u" → 开始处理 ✅
  - 请求 #2-20: 跳过 ❌
  - 结果: 基于 "const u" 生成补全（不准确）

防抖逻辑 (新):
  - 请求 #1-20: 防抖计时器重置
  - 请求 #21: 用户停止输入 800ms 后 → 开始处理 ✅
  - 结果: 基于完整输入生成补全（准确）
```

### 场景 2：手动触发
```
用户按 Ctrl+Space 手动触发

防抖逻辑:
  - 检测到 TriggerKind === Invoke
  - 立即处理，跳过防抖逻辑 ✅
  - 即时响应，无延迟
```

### 场景 3：换行触发
```
用户输入:
  function add(a, b) {
      |← 光标在这里，刚换行
  }

防抖逻辑:
  - 换行后触发补全
  - 800ms 防抖延迟
  - 生成函数体内容建议
```

## 日志示例

### 成功的防抖流程
```
[Trace] Ghost: 自动触发 [请求#1]，启动防抖计时器
[Trace] Ghost: 自动触发 [请求#2]，启动防抖计时器
[Trace] Ghost: 清除旧的防抖计时器
[Trace] Ghost: 自动触发 [请求#3]，启动防抖计时器
[Trace] Ghost: 清除旧的防抖计时器
[Trace] Ghost: 防抖完成 [请求#3]，开始生成补全
[Trace] Ghost: 请求#3 使用策略 [InlineCompletionStrategy] (auto)
[Info]  Ghost [InlineCompletionStrategy] 请求#3 完成: 450 输入, 80 输出, ¥0.0032
[Trace] Ghost: 请求#3 生成补全 [InlineCompletionStrategy]，长度 156
```

### 被取代的请求
```
[Trace] Ghost: 自动触发 [请求#5]，启动防抖计时器
[Trace] Ghost: 自动触发 [请求#6]，启动防抖计时器
[Trace] Ghost: 清除旧的防抖计时器
[Trace] Ghost: 防抖完成 [请求#5]，开始生成补全
[Trace] Ghost: 请求#5 已过期，最新请求是 #6
```

## 配置参数

### 防抖延迟
```typescript
private readonly debounceDelay = 800; // 800ms
```

**调优建议**：
- **500-700ms**：响应更快，但可能在用户还在输入时就触发
- **800-1000ms**（推荐）：平衡点，大多数用户的思考停顿时间
- **1000-1500ms**：更保守，减少不必要的请求，但响应稍慢

### 触发条件
智能触发逻辑保持不变：
- ✅ 注释驱动（优先级最高）
- ✅ 新行（空行或函数体内）
- ✅ 行内补全（操作符、括号后）
- ✅ 自动触发（兜底）

## 优势总结

### 1. 减少无效请求
- 不再处理输入过程中的临时状态
- 只处理用户停止输入后的最终状态
- 大幅减少 API 调用次数和成本

### 2. 提高补全质量
- 基于完整的上下文生成补全
- 更准确理解用户意图
- 更相关的代码建议

### 3. 更好的用户体验
- 手动触发立即响应
- 自动触发不打断输入流程
- 补全出现时机更合理

### 4. 并发安全
- 请求ID机制确保不会处理过期请求
- 活跃请求追踪避免状态混乱
- 取消令牌正确处理中断

## 与 VS Code API 的兼容性

### API 限制
VS Code 的 `InlineCompletionItemProvider` 接口要求返回 Promise 或同步结果。

### 解决方案
```typescript
// ✅ 返回一个 Promise，在防抖延迟后解析
return new Promise((resolve) => {
    this.debounceTimer = setTimeout(async () => {
        const result = await this.generateCompletion(...);
        resolve(result);
    }, this.debounceDelay);
});
```

VS Code 会等待这个 Promise 解析，期间：
- 如果用户继续输入，会发起新的请求（触发新的防抖）
- 如果用户取消（如按 ESC），会通过 `token.isCancellationRequested` 通知
- 如果防抖完成，会执行补全生成并显示结果

## 未来优化方向

### 1. 自适应防抖延迟
根据用户输入速度动态调整延迟：
```typescript
private calculateDebounceDelay(typingSpeed: number): number {
    if (typingSpeed > 5) return 1000; // 快速输入，延迟更长
    if (typingSpeed > 3) return 800;  // 正常速度
    return 600; // 慢速输入，延迟更短
}
```

### 2. 请求优先级
- 注释驱动补全：优先级最高，防抖延迟更短（300ms）
- 新行补全：中等优先级（500ms）
- 行内补全：正常优先级（800ms）

### 3. 预测性预加载
用户输入注释时，提前准备模型，减少实际响应延迟。

### 4. 统计分析
记录防抖效果数据：
- 平均防抖次数/请求
- 节省的 API 调用数
- 用户接受率对比

---

最后更新：2025-01-16
