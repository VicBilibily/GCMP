// 以扩展内置配置为唯一数据源：先把 ../src/providers/config/*.json 同步到 public/configs/，
// 再重新生成 index.json 分发清单（dev/build 前由 npm 脚本触发）
// gcmpVersion 取自仓库根 package.json，可用 GCMP_VERSION 环境变量或命令行参数覆盖
import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.join(root, '..')
const sourceDir = path.join(repoRoot, 'src', 'providers', 'config')
const configsDir = path.join(root, 'public', 'configs')
const indexPath = path.join(configsDir, 'index.json')

// 先清后拷：扩展侧删除 provider 配置时站点同步移除
await rm(configsDir, { recursive: true, force: true })
await mkdir(configsDir, { recursive: true })
await cp(sourceDir, configsDir, { recursive: true })

// 远程元数据与扩展内置兜底共用同一源文件，同步进 public/ 供 Pages 分发
await copyFile(
    path.join(repoRoot, 'src', 'utils', 'metadata', 'gcmp-metadata.json'),
    path.join(root, 'public', 'gcmp-metadata.json')
)

const files = (await readdir(configsDir))
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .sort()

const providers = []
for (const file of files) {
    const config = JSON.parse(await readFile(path.join(configsDir, file), 'utf8'))
    providers.push({
        id: file.replace(/\.json$/, ''),
        displayName: config.displayName,
        modelCount: config.models.length
    })
}

const gcmpVersion =
    process.argv[2] ??
    process.env.GCMP_VERSION ??
    JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version

const manifest = {
    schemaVersion: 1,
    gcmpVersion,
    generatedAt: new Date().toISOString(),
    providers
}

await writeFile(indexPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`configs/index.json: ${providers.length} providers synced from src/providers/config, gcmp ${gcmpVersion}`)
