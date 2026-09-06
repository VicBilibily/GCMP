import { providers } from '../../src/data';
import manifest from '../../public/configs/index.json';
import { formatTokens, getTokenPricing } from '../../src/data/types';
import { useT } from '../../src/i18n';
import './models.css';

// 按提供商分组渲染全部模型；数据来自 public/configs/（同步自扩展 src/providers/config）
export default function Page() {
    const t = useT();
    return (
        <>
            <h1>{t('Models', '模型列表')}</h1>
            <p className="muted">
                {t(
                    `${providers.length} providers, ${providers.reduce((n, p) => n + p.config.models.length, 0)} models (GCMP v${manifest.gcmpVersion} config). Prices in CNY/million tokens, for reference only — check each provider's official site for current pricing.`,
                    `共 ${providers.length} 家提供商、${providers.reduce((n, p) => n + p.config.models.length, 0)} 个模型（GCMP v${manifest.gcmpVersion} 配置）。价格单位为人民币/百万 tokens，仅供参考，以各提供商官网为准。`
                )}
            </p>
            {providers.map(provider => (
                <details key={provider.id} className="provider-section">
                    <summary>
                        {provider.config.displayName}
                        <span className="chip-count">
                            {provider.config.models.length} {t('models', '个模型')} · {provider.id}
                        </span>
                    </summary>
                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>{t('Model', '模型')}</th>
                                    <th>{t('Input/Output Limits', '输入/输出上限')}</th>
                                    <th>{t('Tool Calling', '工具调用')}</th>
                                    <th>{t('Image Input', '图像输入')}</th>
                                    <th>{t('Price (¥/M tokens)', '价格（¥/百万 tokens）')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {provider.config.models.map(model => {
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
                                            <td>{model.capabilities?.toolCalling ? '✓' : '—'}</td>
                                            <td>{model.capabilities?.imageInput ? '✓' : '—'}</td>
                                            <td>
                                                {pricing?.RMB ?
                                                    `¥${pricing.RMB[0]} / ¥${pricing.RMB[1]}`
                                                : pricing?.USD ?
                                                    `$${pricing.USD[0]} / $${pricing.USD[1]}`
                                                : model.name.includes('Free') ?
                                                    t('Free', '免费')
                                                :   '—'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </details>
            ))}
        </>
    );
}
