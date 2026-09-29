import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenericModelProvider } from '../../providers/genericModelProvider';
import {
    clearRegisteredProviders,
    getRegisteredProvider,
    notifyRegisteredProvidersChanged,
    registerProvider,
    registeredProviders
} from './providerRegistry';

test('registered provider refresh notifies every provider without replacing registrations', () => {
    clearRegisteredProviders();
    const notifications: string[] = [];
    const first = {
        notifyModelInformationChanged: () => notifications.push('first')
    } as unknown as GenericModelProvider;
    const second = {
        notifyModelInformationChanged: () => notifications.push('second')
    } as unknown as GenericModelProvider;

    registerProvider('first', first);
    registerProvider('second', second);
    notifyRegisteredProvidersChanged();

    assert.deepEqual(notifications, ['first', 'second']);
    assert.equal(getRegisteredProvider('first'), first);
    assert.equal(getRegisteredProvider('second'), second);
    assert.deepEqual(Object.keys(registeredProviders), ['first', 'second']);
    clearRegisteredProviders();
});

test('registered provider refresh is a no-op when no providers are registered', () => {
    clearRegisteredProviders();
    assert.doesNotThrow(() => notifyRegisteredProvidersChanged());
});
