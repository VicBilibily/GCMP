# Token 定价阶梯（tiers）配置指南

本文定义所有 provider 配置中 `tokenPricing` 与 `tiers` 的通用写法和匹配规则。价格仅用于客户端成本估算，实际账单以提供商为准。

## 基础价格结构

价格数组单位为**每百万 Token**，顺序固定：

```json
[input, output, cacheRead?, cacheWrite?]
```

- `input`：未命中缓存的输入价格。
- `output`：输出价格。
- `cacheRead`：缓存读取价格，可省略。
- `cacheWrite`：缓存写入价格，可省略。
- 若 `cacheWrite` 为 `0`，不要显式写第四项。
- 仅当 `cacheRead` 为 `0` 且 `cacheWrite` 非零时，才需要使用第三项 `0` 占位。

数组简写默认为美元：

```json
"tokenPricing": [1, 4, 0.2]
```

使用双币种或仅原生人民币时，写成货币映射：

```json
"tokenPricing": { "USD": [1, 4, 0.2], "RMB": [7, 28, 1.4] }
```

```json
"tokenPricing": { "RMB": [6, 30, 1.2] }
```

只能配置提供商的原生结算币种。不得把汇率换算出的金额伪装成原生报价。

## 使用 `tiers`

当价格随时间、服务等级或实际输入量变化时，顶层 `pricing` 填默认/回退档，`tiers` 填条件档：

```json
"tokenPricing": {
  "pricing": { "USD": [0.3, 1.2, 0.03], "RMB": [2.1, 8.4, 0.21] },
  "tiers": [
    {
      "serviceTier": "priority",
      "pricing": { "USD": [0.6, 2.4, 0.06], "RMB": [4.2, 16.8, 0.42] }
    }
  ]
}
```

一个 tier 可以使用以下匹配条件；同一 tier 内的已设置条件必须同时满足：

| 字段 | 含义 |
| --- | --- |
| `cron` | 生效时段，使用 5 字段 Unix cron：分、时、日、月、周。 |
| `timezone` | `cron` 的 IANA 时区；未设置时按 `Asia/Shanghai`。 |
| `serviceTier` | 仅在请求选择相同服务等级时命中。 |
| `contextSizeMin` | 实际上下文 Token 达到该阈值时命中；是否包含输出由 `contextSizeInputOnly` 决定。 |
| `contextSizeInputOnly` | 控制 `contextSizeMin` 是否排除输出 Token：`true` 时仅比较输入 Token；默认 `false`，比较输入与输出 Token 之和。 |

`contextSizeMin` 比较的是 API usage 的实际用量：默认使用输入与输出之和；设置 `contextSizeInputOnly: true` 时仅使用输入。它**不是** `contextSize` 或用户预选的上下文窗口。

`contextSizeInputOnly` 仅用于适配提供商对上下文阶梯的计费口径：

- 提供商按“输入 + 输出”的总上下文长度分档时，不设置该字段（默认 `false`）。
- 提供商明确按请求的**输入 prompt** 长度分档时，设置为 `true`；例如输入为 `190000`、输出为 `20000`、阈值为 `200000`，默认口径比较值为 `210000`，会命中；设置 `contextSizeInputOnly: true` 后比较值为 `190000`，不会命中。
- 此字段不改变输入、输出或缓存命中的单价与计费量；它只决定是否命中 `contextSizeMin` 对应的价格档。

## 匹配优先级与排序

运行时按 `tiers` 数组顺序处理，首个满足所有条件的 tier 生效。若命中的 tier 未达到 `contextSizeMin`，会跳过它并继续检查余下 tier；若没有 tier 可用，则回退到顶层 `pricing`。

因此必须把**更具体、门槛更高的规则放在前面**。

### 上下文长度阶梯

相同 `cron` 与 `serviceTier` 范围内，`contextSizeMin` 必须严格按降序排列：

```json
"tokenPricing": {
  "pricing": { "RMB": [3.2, 16, 0.64] },
  "tiers": [
    { "contextSizeMin": 128001, "pricing": { "RMB": [9.6, 48, 1.92] } },
    { "contextSizeMin": 32001, "pricing": { "RMB": [4.8, 24, 0.96] } }
  ]
}
```

该配置的区间为：

| 实际上下文 Token | 生效价格 |
| --- | --- |
| `0` 至 `32000` | 顶层 `pricing` |
| `32001` 至 `128000` | `contextSizeMin: 32001` |
| `128001` 及以上 | `contextSizeMin: 128001` |

若把 `32001` 放在 `128001` 前面，大输入会先命中低阈值档，造成成本低估。

### 服务等级与上下文联合阶梯

服务等级与输入长度同时变化时，将同一服务等级中的高阈值规则放在低阈值规则前，再放该服务等级的无阈值规则：

```json
"tiers": [
  {
    "serviceTier": "priority",
    "contextSizeMin": 512001,
    "pricing": { "USD": [0.9, 3.6, 0.18] }
  },
  {
    "serviceTier": "priority",
    "pricing": { "USD": [0.45, 1.8, 0.09] }
  },
  {
    "serviceTier": "default",
    "contextSizeMin": 512001,
    "pricing": { "USD": [0.6, 2.4, 0.12] }
  }
]
```

### 时间规则

`cron` 表达式必须覆盖整个目标时段。例如工作日 9:00 至 23:59：

```json
{ "cron": "* 9-23 * * 1-5", "timezone": "Asia/Shanghai", "pricing": [2, 8, 0.4] }
```

`"0 9 * * 1-5"` 只匹配工作日的 09:00 这一分钟，通常不是所需的峰时配置。时间规则与其他条件叠加时，应把“指定服务等级 + 指定时段 + 高输入量”之类的最具体规则排在通用时段规则之前。

## tier 的价格写法

每个 tier 的 `pricing` 支持三种形式：

1. 价格数组：默认美元。
2. `{ "USD": [...], "RMB": [...] }` 或仅 `{ "RMB": [...] }` 的货币映射。
3. 数字倍率：基于顶层价格同时放大 USD 与 RMB。

倍率适用于提供商明确规定“峰时为基础价格的固定倍数”的场景：

```json
"tokenPricing": {
  "pricing": { "USD": [1, 4, 0.2], "RMB": [7, 28, 1.4] },
  "tiers": [
    { "cron": "* 9-17 * * 1-5", "pricing": 2 }
  ]
}
```

如果不同字段的涨幅不一致，必须写完整价格数组或货币映射，不能使用倍率。

## 配置检查清单

1. 核对模型、接入渠道、计费类型（常规、批量、低延迟、订阅超额等）和原生币种。
2. 顶层 `pricing` 应是无条件的默认/回退价格。
3. 每个 tier 至少设置一个匹配条件；不能创建没有条件的 tier。
4. 多个上下文阈值按降序排列；高优先级服务等级、时段或组合条件排在通用规则之前。
5. `contextSizeInputOnly: true` 时，`contextSizeMin` 不得超过 `maxInputTokens`；默认口径下不得超过 `maxInputTokens + maxOutputTokens`。
6. 价格数组必须为 2 至 4 个非负数字。
7. 未经明确需求，不修改模型 ID、能力、`thinking` 或 `reasoningEffort`。

## 验证

修改 `tiers` 后至少运行：

```powershell
node --import=tsx --test src/utils/costCalculator.test.ts
npm run typecheck
```

应针对每个新增组合覆盖边界值，例如阈值 `32001` 测试 `32000`、`32001` 和下一档阈值；同时覆盖不同 `serviceTier`、命中和未命中 `cron` 的时间点。
