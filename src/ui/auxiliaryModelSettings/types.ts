/**
 * Auxiliary Model Settings WebView 消息类型
 */

/**
 * 后端 → 前端消息
 */
export type HostMessage =
    | { command: 'init'; providers: AuxiliaryProviderData[]; initialValues: InitialValues }
    | { command: 'saved'; success: true }
    | { command: 'savedPartial'; skippedAgent: true }
    | { command: 'saveError'; error: string };

/**
 * 前端 → 后端消息
 */
export type WebViewMessage =
    | { command: 'getInitialData' }
    | {
          command: 'save';
          values: FormValues;
      }
    | { command: 'cancel' };

/**
 * 后端返回的提供商数据
 */
export interface AuxiliaryProviderData {
    key: string;
    displayName: string;
    models: AuxiliaryModelOption[];
}

/**
 * 单个模型选项
 */
export interface AuxiliaryModelOption {
    id: string;
    name: string;
    hasToolCalling: boolean;
    hasImageInput: boolean;
}

/**
 * 表单初始值
 */
export interface InitialValues {
    commit?: { provider: string; model: string };
    vision?: { provider: string; model: string };
    utility?: { provider: string; model: string };
    utilitySmall?: { provider: string; model: string };
    agent?: { provider: string; model: string };
}

/**
 * 表单提交值
 */
export interface FormValues {
    commit: { provider: string; model: string } | null;
    vision: { provider: string; model: string } | null;
    utility: { provider: string; model: string } | null;
    utilitySmall: { provider: string; model: string } | null;
    agent: { provider: string; model: string } | null;
}
