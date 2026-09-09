# 仅远端发布模型运维指南

适用于免费额度、临时测试等**可能随时失效**的模型:不内置进插件包,仅通过远端配置清单发布与下线。

数据源格式与字段约束见 [website/remote-extra/README.md](../website/remote-extra/README.md),本文侧重生命周期与运维行为。

## 架构位置

```
website/remote-extra/<provider>.json   ← 唯一数据源(本仓库维护)
        │ generate-config-index.mjs(构建期强校验 + 合并)
        ▼
website/public/configs/<provider>.json ← 内置模型 + 仅远端模型(追加在末尾)
        │ 部署 gcmp.dev
        ▼
客户端 RemoteModelsService             ← 15min 定时 / 激活时 / 手动刷新拉取
        │ sanitizeProviderModels 合并去重(远端优先,内置回退)
        ▼
模型选择器展示                          ← 仅远端模型继承内置 provider 的 baseUrl/密钥槽位
```

## 发布

1. 在 `website/remote-extra/` 新增或修改 `<provider>.json`(provider 必须已内置)
2. 运行 website 构建;构建期校验:未知 provider、内置同 id 冲突、禁止字段(`baseUrl` 等)都会**报错终止**
3. 部署 gcmp.dev 后,客户端按 contentHash 增量拉取,正常联网且刷新成功时最多 15min 内生效(或用户手动执行 `GCMP: Refresh Remote Metadata` 触发刷新)

## 下线

从 remote-extra 删除该模型(或整个文件)→ 重新构建部署。客户端下轮刷新重建合并列表,由于内置无该模型回退,模型直接从选择器消失。

**时效窗口**:正常联网且刷新成功时,部署后到客户端生效最长 15min(定时周期)。网络或清单校验失败时客户端会保留旧缓存,需待后续刷新成功;窗口期内用户仍可选中该模型,调用时由 provider API 返回模型不存在错误——属预期行为,文案上请在 `tooltip` 标注"可能随时失效"。

## 客户端行为细节

- **排序**:仅远端模型追加在该 provider 模型列表末尾
- **字段继承**:仅远端模型无 `baseUrl`/`endpoint`/`provider`,自动使用内置 provider 级配置与密钥
- **多实例**:Leader 窗口拉取写磁盘缓存,其余窗口经 InterInstanceBus 通知重读,行为一致
- **开发调试**:dev 模式(扩展开发宿主)自动合并本仓库 `website/remote-extra/`,与生产效果一致,无需部署

## 排障

| 现象 | 排查 |
|------|------|
| 构建报错 provider 不存在 | remote-extra 文件名须与 `src/providers/config/` 内置文件名一致 |
| 模型不出现在选择器 | 确认已部署;客户端执行 `GCMP: Refresh Remote Metadata`;查 GCMP 输出面板 `[Models]` 日志 |
| 模型字段未生效 | 检查是否配置了禁止字段(`baseUrl`/`endpoint`/`proxy`/`apiKeyTemplate`/`provider`),构建期本应拦截 |
| 下线后仍可见 | 可手动触发刷新;网络或清单校验失败时保留旧缓存,需排查日志并等待刷新成功 |
