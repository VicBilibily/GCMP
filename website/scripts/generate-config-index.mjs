// 以扩展内置配置为唯一数据源：先把 ../src/providers/config/*.json 同步到 public/configs/，
// 再重新生成 index.json 分发清单（dev/build 前由 npm 脚本触发）
// 另合并 remote-extra/<provider>.json 中的"仅远端发布"模型（免费/临时测试模型，不内置进插件包）
// contentHash 为各 provider 文件原文文本的 sha256 前 12 位，供插件按哈希条件拉取
// gcmpVersion 取自仓库根 package.json，可用 GCMP_VERSION 环境变量或命令行参数覆盖
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.join(root, '..')
const sourceDir = path.join(repoRoot, 'src', 'providers', 'config')
const configsDir = path.join(root, 'public', 'configs')
const indexPath = path.join(configsDir, 'index.json')
const extraDir = path.join(root, 'remote-extra')

// 与客户端 modelsResolver 的 FORBIDDEN_MODEL_FIELDS 对齐：这些字段远端下发会被剥离，构建期直接报错
const EXTRA_FORBIDDEN_FIELDS = ['baseUrl', 'endpoint', 'modelsEndpoint', 'proxy', 'apiKeyTemplate', 'provider', '__proto__', 'constructor', 'prototype']

// 先清后拷：扩展侧删除 provider 配置时站点同步移除
await rm(configsDir, { recursive: true, force: true })
await mkdir(configsDir, { recursive: true })
await cp(sourceDir, configsDir, { recursive: true })

// 合并"仅远端发布"模型：追加到对应 provider 的 models 末尾，不修改 src 内置源文件
let extraFiles = []
try {
    extraFiles = (await readdir(extraDir)).filter(f => f.endsWith('.json')).sort()
} catch (error) {
    // remote-extra 目录不存在 = 无仅远端模型，跳过
    if (error.code !== 'ENOENT') throw error
}
for (const file of extraFiles) {
    const providerId = file.replace(/\.json$/, '')
    const targetPath = path.join(configsDir, file)
    let target
    try {
        target = JSON.parse(await readFile(targetPath, 'utf8'))
    } catch {
        throw new Error(
            `remote-extra/${file}: provider "${providerId}" 不在内置 src/providers/config 中，仅远端模型必须挂在已内置 provider 下`
        )
    }
    let extra
    try {
        extra = JSON.parse(await readFile(path.join(extraDir, file), 'utf8'))
    } catch (error) {
        throw new Error(`remote-extra/${file}: JSON 解析失败 - ${error.message}`)
    }
    if (!extra || !Array.isArray(extra.models) || target.models.length + extra.models.length > 512) {
        throw new Error(`remote-extra/${file}: 缺少 models 数组`)
    }
    const builtinIds = new Set(target.models.map(m => m.id))
    for (const model of extra.models) {
        if (!model || typeof model !== 'object' || Array.isArray(model) ||
            typeof model.id !== 'string' || model.id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@+\-/]*$/.test(model.id) ||
            typeof model.name !== 'string' || !model.name.trim() || model.name.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(model.name.trim()) ||
            !Number.isInteger(model.maxInputTokens) || model.maxInputTokens <= 0 || model.maxInputTokens > 10_000_000 ||
            !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0 || model.maxOutputTokens > 1_000_000) {
            throw new Error(`remote-extra/${file}: 模型必填字段非法`)
        }
        const forbidden = EXTRA_FORBIDDEN_FIELDS.filter(f => Object.hasOwn(model, f))
        if (forbidden.length > 0) {
            throw new Error(
                `remote-extra/${file}: 模型 ${model.id} 含禁止下发字段 ${forbidden.join(', ')}（客户端安全清洗会剥离，端点/密钥槽位只能继承内置 provider 配置）`
            )
        }
        if (builtinIds.has(model.id)) {
            throw new Error(`remote-extra/${file}: 模型 ${model.id} 与内置或其他额外模型同 id 冲突`)
        }
        builtinIds.add(model.id)
    }
    target.models = [...target.models, ...extra.models]
    await writeFile(targetPath, JSON.stringify(target, null, 2) + '\n')
    console.log(`remote-extra: ${providerId} +${extra.models.length} remote-only model(s)`)
}

const generatedAt = new Date().toISOString()

// 远程元数据与扩展内置兜底共用同一源文件，同步进 public/ 供 Pages 分发
const metadataPath = path.join(root, 'public', 'gcmp-metadata.json')
await copyFile(
    path.join(repoRoot, 'src', 'utils', 'metadata', 'gcmp-metadata.json'),
    metadataPath
)
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
metadata.generatedAt = generatedAt
await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n')

const files = (await readdir(configsDir))
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .sort()

const providers = []
for (const file of files) {
    const text = await readFile(path.join(configsDir, file), 'utf8')
    const config = JSON.parse(text)
    providers.push({
        id: file.replace(/\.json$/, ''),
        displayName: config.displayName,
        modelCount: config.models.length,
        contentHash: createHash('sha256').update(text).digest('hex').slice(0, 12)
    })
}

const gcmpVersion =
    process.argv[2] ??
    process.env.GCMP_VERSION ??
    JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version

const manifest = {
    schemaVersion: 1,
    gcmpVersion,
    generatedAt,
    providers
}

await writeFile(indexPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`configs/index.json: ${providers.length} providers synced from src/providers/config, gcmp ${gcmpVersion}`)
