import type { ProviderConfig } from '../../../types/sharedTypes';

export interface OpenAIProviderContext {
    readonly provider: string;
    readonly providerConfig: ProviderConfig | undefined;
}
