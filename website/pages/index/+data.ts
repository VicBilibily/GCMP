// 仅在服务端执行：读取原始提供商配置生成首页统计
export { data }
export type Data = Awaited<ReturnType<typeof data>>

import type { PageContextServer } from 'vike/types'
import { providers } from '../../src/data'
import manifest from '../../public/configs/index.json'

async function data(_pageContext: PageContextServer) {
  return {
    gcmpVersion: manifest.gcmpVersion,
    providerCount: providers.length,
    modelCount: providers.reduce((n, p) => n + p.config.models.length, 0),
    providers: providers.map((p) => ({
      id: p.id,
      displayName: p.config.displayName,
      modelCount: p.config.models.length
    }))
  }
}
