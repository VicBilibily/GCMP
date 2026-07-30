export const CustomDataPartMimeTypes = {
    CacheControl: 'cache_control',
    StatefulMarker: 'stateful_marker',
    ThinkingData: 'thinking',
    ContextManagement: 'context_management',
    Usage: 'usage'
} as const;

export const CacheType = 'ephemeral';

/**
 * GCMP 系统提示词消息的 name 标记。
 * 用于在 User role 消息上标识"此消息应被 handler 转换层转为 system/instructions"，
 * 绕开 languageModelSystem proposal 在 stable 构建中被禁用的限制。
 */
export const GCMP_SYSTEM_MESSAGE_NAME = 'gcmp-system';
