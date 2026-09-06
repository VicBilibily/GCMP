import type { ProviderConfig, ProviderEntry } from './types'

// 直接加载 public/configs/ 的原始提供商配置（单一数据源，兼作静态分发文件）；
// 增删 JSON 文件后无需改代码
const modules = import.meta.glob<ProviderConfig>('../../public/configs/*.json', {
  eager: true,
  import: 'default'
})

export const providers: ProviderEntry[] = Object.entries(modules)
  .filter(([path]) => !path.endsWith('index.json'))
  .map(([path, config]) => ({
    id: path.split('/').pop()!.replace(/\.json$/, ''),
    config
  }))
  .sort((a, b) => a.config.displayName.localeCompare(b.config.displayName))
