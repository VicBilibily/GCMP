import { ModelOverride, ProviderConfig, ProviderOverride } from '../../types/sharedTypes';

/**
 * 已知提供商配置接口
 */
export interface KnownProviderConfig extends Partial<ProviderConfig & ProviderOverride> {
    /** 针对 OpenAI SDK 的兼容策略 */
    openai?: Omit<ModelOverride, 'id'>;
    /** 针对 Anthropic SDK 的兼容策略 */
    anthropic?: Omit<ModelOverride, 'id'>;
}

// 统一导出所有已知提供商配置，便于代码 import
import aihubmix from './aihubmix.json';
import aiping from './aiping.json';
import modelscope from './modelscope.json';
import openrouter from './openrouter.json';
import siliconflow from './siliconflow.json';
import tbox from './tbox.json';
import mthreads from './mthreads.json';
import infini from './infini.json';
import rightcode from './rightcode.json';
import mistral from './mistral.json';

export const providers: Record<string, KnownProviderConfig> = {
    aihubmix,
    aiping,
    modelscope,
    openrouter,
    siliconflow,
    tbox,
    mthreads,
    infini,
    rightcode,
    mistral
};

export type ProviderName = keyof typeof providers;

export const knownProviders = providers as Record<ProviderName, KnownProviderConfig>;

export default knownProviders;
