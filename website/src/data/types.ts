// 官网侧精简类型，对齐 GCMP src/providers/config/*.json 的实际字段
export type PricingArray = number[]

// 对齐 sharedTypes 的 ModelTokenPricingInput：数组简写（默认 USD）/ 双币映射 / canonical 对象
export type ModelTokenPricingInput =
  | PricingArray
  | { USD?: PricingArray; RMB?: PricingArray }
  | { pricing?: PricingArray | { USD?: PricingArray; RMB?: PricingArray }; tiers?: unknown[] }

export interface ModelCapabilities {
  toolCalling?: boolean
  imageInput?: boolean
}

export interface ModelInfo {
  id: string
  name: string
  model?: string
  tooltip?: string
  sdkMode?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  thinking?: string[]
  reasoningEffort?: string[]
  webSearchTool?: boolean
  capabilities?: ModelCapabilities
  tokenPricing?: ModelTokenPricingInput
}

export interface ProviderConfig {
  displayName: string
  baseUrl?: string
  apiKeyTemplate?: string
  models: ModelInfo[]
}

export interface ProviderEntry {
  id: string
  config: ProviderConfig
}

// 归一化定价为 { USD?, RMB? } 形式；数组简写按 GCMP 约定默认为 USD
export function getTokenPricing(model: ModelInfo): { USD?: PricingArray; RMB?: PricingArray } | undefined {
  const toMap = (p: PricingArray | { USD?: PricingArray; RMB?: PricingArray }) =>
    Array.isArray(p) ? { USD: p } : p

  const pricing = model.tokenPricing
  if (!pricing) return undefined
  if (Array.isArray(pricing)) return { USD: pricing }
  if ('pricing' in pricing && pricing.pricing) return toMap(pricing.pricing)
  return pricing as { USD?: PricingArray; RMB?: PricingArray }
}

export function formatTokens(n: number | undefined): string {
  if (!n) return '—'
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}
