# JSON Schema 依赖选项联动

## 目标

让字段 B 的 `enum`/`required`/`pattern` 随字段 A 的值变化（主要服务 `settings.json` 的提示与校验）。

## 做法

- 首选：`allOf` 里写多组 `if` + `then`（单值匹配用 `const`）。
- 组合约束：用 `oneOf`/`anyOf`（或 `dependencies` + `oneOf`）。
- 枚举来自运行时数据：在代码里生成/覆盖 schema（动态 enum）。

## GCMP 落点

- 静态：`package.json` → `contributes.configuration.properties`。
- 动态：`src/utils/jsonSchemaProvider.ts`（用于 `settings.json` 的增强提示/校验）。

## 约束/注意

- 使用 Draft-07，并声明 `"$schema": "http://json-schema.org/draft-07/schema#"`。
- VS Code 设置 UI 对复杂联动支持有限，以 `settings.json` 为准。
- 性能：少条件、少嵌套。

## 最小验证

- 变更后 Reload Window。
- 在 `settings.json`：A 改值时，B 的提示/校验随之变化；非法组合有红线。
