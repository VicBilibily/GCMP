import {
    setScopedRequestClassification,
    type RequestClassification,
    type RequestContinuity
} from './requestClassification';
import { resolveRequestBehavior, type RequestBehavior } from './requestBehavior';

interface ScopeOptions {
    modelOptions?: { requestKind?: unknown; subSessionId?: unknown };
}

interface RequestScopeContext {
    classification: RequestClassification;
    behavior: RequestBehavior;
    continuity?: RequestContinuity;
    fullSummaryMatch?: boolean;
}

export class ProviderRequestScopes {
    private readonly scopes = new WeakMap<object, RequestScopeContext>();
    private readonly delegated = new WeakSet<object>();

    create<T extends ScopeOptions>(options: T, classify: (options: T) => RequestClassification): T {
        if (this.delegated.delete(options) && this.scopes.has(options)) {
            return options;
        }
        const classification = classify(options);
        const scoped = {
            ...options,
            modelOptions: { ...options.modelOptions, requestKind: classification.requestKind }
        };
        delete scoped.modelOptions.subSessionId;
        setScopedRequestClassification(scoped, classification);
        this.scopes.set(scoped, { classification, behavior: resolveRequestBehavior(classification) });
        return scoped;
    }

    get(options: object): RequestScopeContext | undefined {
        return this.scopes.get(options);
    }

    delegate(options: object): void {
        if (this.scopes.has(options)) {
            this.delegated.add(options);
        }
    }
}
