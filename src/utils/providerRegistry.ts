import { GenericModelProvider } from '../providers/genericModelProvider';

export const registeredProviders: Record<string, GenericModelProvider> = {};

export function registerProvider(providerKey: string, provider: GenericModelProvider): void {
    registeredProviders[providerKey] = provider;
}

export function getRegisteredProvider(providerKey: string): GenericModelProvider | undefined {
    return registeredProviders[providerKey];
}

export function clearRegisteredProviders(): void {
    for (const providerKey of Object.keys(registeredProviders)) {
        delete registeredProviders[providerKey];
    }
}
