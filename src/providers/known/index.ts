import {
    ModelOverride,
    ResolvedUnifiedProviderConfigMap,
    UnifiedProviderConfig,
    UnifiedProviderConfigMap
} from '../../types/sharedTypes';
import aihubmix from './aihubmix.json';
import aiping from './aiping.json';
import infini from './infini.json';
import mistral from './mistral.json';
import modelscope from './modelscope.json';
import mthreads from './mthreads.json';
import openrouter from './openrouter.json';
import rightcode from './rightcode.json';
import siliconflow from './siliconflow.json';
import tbox from './tbox.json';

export interface KnownProviderConfig extends UnifiedProviderConfig {
    openai?: Omit<ModelOverride, 'id'>;
    anthropic?: Omit<ModelOverride, 'id'>;
}

const providers = {
    aihubmix,
    aiping,
    infini,
    mistral,
    modelscope,
    mthreads,
    openrouter,
    rightcode,
    siliconflow,
    tbox
};

export type KnownProviderName = keyof typeof providers;

export const knownProviders = providers as UnifiedProviderConfigMap;

export const resolvedKnownProviders = knownProviders as unknown as ResolvedUnifiedProviderConfigMap;

export default knownProviders;
