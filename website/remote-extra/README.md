# remote-extra:仅远端发布模型

本目录存放**仅通过远端清单发布、不内置进插件包**的模型配置,适用于免费额度模型、临时测试模型等可能随时失效的模型。

## 工作方式

- 每个 `<provider>.json` 对应一个**已内置**的 provider(`src/providers/config/` 中必须存在同名文件)
- `website/scripts/generate-config-index.mjs` 构建时把这里的 models **追加**到 `public/configs/<provider>.json` 末尾,再计算 contentHash
- 客户端按远端清单合并:仅远端模型随清单刷新(15min 周期 / 激活时 / `gcmp.metadata.refresh` 命令)出现在模型列表中
- **下线 = 从本目录删除该模型(或整个文件)**,重新构建部署后,客户端下轮刷新自动移除

## 文件格式

```json
{
  "models": [
    {
      "id": "example-free-model",
      "name": "Example Free (免费测试)",
      "tooltip": "免费测试模型,可能随时失效",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "capabilities": { "toolCalling": true, "imageInput": false }
    }
  ]
}
```

必填字段:`id`、`name`、`maxInputTokens`、`maxOutputTokens`(与内置模型配置一致)。

可选字段(客户端白名单内):`tooltip`、`version`、`sdkMode`、`model`、`family`、`thinking`、`thinkingFormat`、`reasoningFormat`、`reasoningEffort`、`reasoningDefault`、`contextSize`、`serviceTier`、`tokenPricing`、`limit`、`customHeader`、`extraBody`、`useInstructions`、`cacheTtl`、`webSearchTool`、`nativeTools`。

## 约束(构建期强校验,违反即报错终止)

- **provider 必须已内置**:文件名对应的 `<provider>` 必须在 `src/providers/config/` 中存在;不支持通过本目录引入全新 provider
- **模型 id 不得与内置冲突**:同 provider 下不能复用内置模型 id
- **禁止以下字段**:`baseUrl`、`endpoint`、`modelsEndpoint`、`proxy`、`apiKeyTemplate`、`provider` —— 端点与密钥槽位只能继承内置 provider 配置(客户端安全清洗会剥离这些字段)

## 发布流程

1. 在本目录新增/修改 `<provider>.json`
2. 运行 website 构建(`generate-config-index` 会自动合并并强校验)
3. 部署 gcmp.dev
4. 客户端在正常联网且刷新成功时最多 15min 内自动生效,或用户手动执行 `GCMP: Refresh Remote Metadata` 触发刷新;刷新失败时保留旧缓存

注意:修改本目录后 `public/configs/<provider>.json` 的 contentHash 会变化,客户端按哈希条件增量拉取。
