import { useDeferredValue, useEffect, useState } from 'react';
import { usePageContext } from 'vike-react/usePageContext';
import { providers } from '../../src/data';
import manifest from '../../public/configs/index.json';
import { formatTokens, getTokenPricing } from '../../src/data/types';
import { useT } from '../../src/i18n';
import './models.css';

const DEFAULT_FILTERS = {
    query: '',
    providerId: '',
    toolCalling: false,
    imageInput: false,
    reasoning: false
};

export default function Page() {
    const t = useT();
    const requestedProvider = usePageContext().urlParsed.search.provider ?? '';
    const initialProvider = providers.some(provider => provider.id === requestedProvider) ? requestedProvider : '';
    const [filters, setFilters] = useState({ ...DEFAULT_FILTERS });
    const [expandedProviders, setExpandedProviders] = useState(
        () => new Set(providers.slice(0, 1).map(provider => provider.id))
    );
    useEffect(() => {
        setFilters({ ...DEFAULT_FILTERS, providerId: initialProvider });
        setExpandedProviders(
            new Set(initialProvider ? [initialProvider] : providers.slice(0, 1).map(provider => provider.id))
        );
    }, [initialProvider]);
    const deferredQuery = useDeferredValue(filters.query);
    const keywords = deferredQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const modelCount = providers.reduce((count, provider) => count + provider.config.models.length, 0);
    const hasFilters = Boolean(
        filters.query.trim() || filters.providerId || filters.toolCalling || filters.imageInput || filters.reasoning
    );
    const results = providers
        .filter(provider => !filters.providerId || provider.id === filters.providerId)
        .map(provider => ({
            provider,
            models: provider.config.models.filter(model => {
                const searchable = [provider.id, provider.config.displayName, model.id, model.name, model.model]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                return (
                    keywords.every(keyword => searchable.includes(keyword)) &&
                    (!filters.toolCalling || model.capabilities?.toolCalling) &&
                    (!filters.imageInput || model.capabilities?.imageInput) &&
                    (!filters.reasoning || Boolean(model.thinking?.length || model.reasoningEffort?.length))
                );
            })
        }))
        .filter(result => result.models.length > 0);
    const matchingCount = results.reduce((count, result) => count + result.models.length, 0);

    function updateFilters(next: Partial<typeof DEFAULT_FILTERS>) {
        setFilters(current => ({ ...current, ...next }));
        setExpandedProviders(new Set(providers.map(provider => provider.id)));
    }

    function resetFilters() {
        setFilters({ ...DEFAULT_FILTERS });
        setExpandedProviders(new Set(providers.slice(0, 1).map(provider => provider.id)));
    }

    return (
        <div className="models-page">
            <h1>{t('Models', '模型列表')}</h1>
            <p className="muted">
                {t(
                    `${providers.length} providers, ${modelCount} models · GCMP v${manifest.gcmpVersion}`,
                    `${providers.length} 家提供商、${modelCount} 个模型 · GCMP v${manifest.gcmpVersion}`
                )}
            </p>
            <form
                className="catalog-controls"
                role="search"
                aria-label={t('Model filters', '模型筛选')}
                onSubmit={event => event.preventDefault()}
                onReset={event => {
                    event.preventDefault();
                    resetFilters();
                }}
            >
                <div className="model-filter-fields">
                    <label className="filter-field">
                        <span>{t('Search models', '搜索模型')}</span>
                        <input
                            type="search"
                            name="query"
                            placeholder={t('Model name, ID or provider', '模型名称、ID 或提供商')}
                            value={filters.query}
                            onChange={event => updateFilters({ query: event.target.value })}
                        />
                    </label>
                    <label className="filter-field">
                        <span>{t('Provider', '提供商')}</span>
                        <select
                            name="provider"
                            value={filters.providerId}
                            onChange={event => updateFilters({ providerId: event.target.value })}
                        >
                            <option value="">{t('All providers', '全部提供商')}</option>
                            {providers.map(provider => (
                                <option key={provider.id} value={provider.id}>
                                    {provider.config.displayName} ({provider.config.models.length})
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <div className="model-filter-options">
                    <fieldset>
                        <legend className="sr-only">{t('Required capabilities', '所需能力')}</legend>
                        <label>
                            <input
                                type="checkbox"
                                checked={filters.toolCalling}
                                onChange={event => updateFilters({ toolCalling: event.target.checked })}
                            />
                            {t('Tool calling', '工具调用')}
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                checked={filters.imageInput}
                                onChange={event => updateFilters({ imageInput: event.target.checked })}
                            />
                            {t('Image input', '图像输入')}
                        </label>
                        <label>
                            <input
                                type="checkbox"
                                checked={filters.reasoning}
                                onChange={event => updateFilters({ reasoning: event.target.checked })}
                            />
                            {t('Reasoning', '推理能力')}
                        </label>
                    </fieldset>
                    <button className="btn-secondary" type="reset" disabled={!hasFilters}>
                        {t('Reset filters', '重置筛选')}
                    </button>
                </div>
            </form>
            <div className="results-toolbar">
                <p role="status" aria-live="polite">
                    {t(
                        `${matchingCount} model${matchingCount === 1 ? '' : 's'} · ${results.length} provider${results.length === 1 ? '' : 's'}`,
                        `${matchingCount} 个模型 · ${results.length} 家提供商`
                    )}
                </p>
                <div className="results-actions">
                    <button
                        className="btn-secondary"
                        type="button"
                        disabled={results.length === 0}
                        onClick={() => setExpandedProviders(new Set(results.map(result => result.provider.id)))}
                    >
                        {t('Expand all', '全部展开')}
                    </button>
                    <button
                        className="btn-secondary"
                        type="button"
                        disabled={results.length === 0}
                        onClick={() => setExpandedProviders(new Set())}
                    >
                        {t('Collapse all', '全部收起')}
                    </button>
                </div>
            </div>
            <p className="muted pricing-note">
                {t(
                    'Base input / output prices per million tokens, in the indicated currency. Tiered rates and subscription billing may differ; provider pricing takes precedence.',
                    '价格为每百万 tokens 的基础输入 / 输出费用，币种以标注为准；阶梯价格和套餐计费可能不同，请以提供商公布价格为准。'
                )}
            </p>
            <div aria-busy={filters.query !== deferredQuery}>
                {results.map(({ provider, models }) => (
                    <details
                        key={provider.id}
                        id={`provider-${provider.id}`}
                        className="provider-section"
                        open={expandedProviders.has(provider.id)}
                        onToggle={event => {
                            const open = event.currentTarget.open;
                            setExpandedProviders(current => {
                                if (current.has(provider.id) === open) return current;
                                const next = new Set(current);
                                if (open) next.add(provider.id);
                                else next.delete(provider.id);
                                return next;
                            });
                        }}
                    >
                        <summary>
                            <span className="provider-name">{provider.config.displayName}</span>
                            <span className="chip-count">
                                {models.length} / {provider.config.models.length}
                            </span>
                            <span className="provider-id">{provider.id}</span>
                        </summary>
                        <div className="provider-meta">
                            <a href={`/configs/${provider.id}.json`} download>
                                {t('Download JSON', '下载 JSON')}
                            </a>
                        </div>
                        <div className="table-wrap" tabIndex={0} role="region" aria-label={provider.config.displayName}>
                            <table className="models-table">
                                <thead>
                                    <tr>
                                        <th scope="col">{t('Model', '模型')}</th>
                                        <th scope="col">{t('Input / Output', '输入 / 输出上限')}</th>
                                        <th scope="col">{t('Tools', '工具')}</th>
                                        <th scope="col">{t('Vision', '视觉')}</th>
                                        <th scope="col">{t('Reasoning', '推理')}</th>
                                        <th scope="col">{t('Price / 1M tokens', '价格 / 百万 tokens')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {models.map(model => {
                                        const pricing = getTokenPricing(model);
                                        return (
                                            <tr key={model.id} title={model.tooltip}>
                                                <td>
                                                    <div className="model-name">{model.name}</div>
                                                    <div className="model-id">{model.id}</div>
                                                </td>
                                                <td>
                                                    {formatTokens(model.maxInputTokens)} /{' '}
                                                    {formatTokens(model.maxOutputTokens)}
                                                </td>
                                                <td>{model.capabilities?.toolCalling ? t('Yes', '支持') : '—'}</td>
                                                <td>{model.capabilities?.imageInput ? t('Yes', '支持') : '—'}</td>
                                                <td>
                                                    {model.thinking?.length || model.reasoningEffort?.length ?
                                                        t('Yes', '支持')
                                                    :   '—'}
                                                </td>
                                                <td className="model-price">
                                                    {pricing?.RMB && (
                                                        <div>
                                                            ¥{pricing.RMB[0]} / ¥{pricing.RMB[1]}
                                                        </div>
                                                    )}
                                                    {pricing?.USD && (
                                                        <div>
                                                            ${pricing.USD[0]} / ${pricing.USD[1]}
                                                        </div>
                                                    )}
                                                    {!pricing?.RMB && !pricing?.USD && '—'}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </details>
                ))}
                {results.length === 0 && (
                    <div className="models-empty">
                        <h2>{t('No matching models', '没有匹配的模型')}</h2>
                        <button className="btn-secondary" type="button" onClick={resetFilters}>
                            {t('Reset filters', '重置筛选')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
