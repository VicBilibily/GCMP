/*---------------------------------------------------------------------------------------------
 *  ChatGPT 订阅席位名称映射（纯逻辑，无宿主依赖）
 *  对齐 Codex TUI plan_type_display_name（codex-rs/tui/src/status/helpers.rs）
 *--------------------------------------------------------------------------------------------*/

/**
 * Codex / ChatGPT usage 接口返回的 plan_type → TUI 标准化席位名。
 * 未收录的值原样返回，避免未知套餐被吞掉。
 */
const CHATGPT_PLAN_TYPE_DISPLAY_NAMES: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Business',
    self_serve_business_usage_based: 'Business',
    self_serve_business_prolite: 'Business Premium',
    business: 'Enterprise',
    ent26: 'Enterprise',
    enterprise: 'Enterprise',
    hc: 'Enterprise',
    enterprise_cbp_usage_based: 'Enterprise',
    enterprise_cbp_automation: 'Enterprise (Automation)',
    edu: 'Edu',
    education: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro'
};

/**
 * 将 ChatGPT `plan_type` 转为 Codex TUI 标准化席位名。
 * 例如 `team` / `self_serve_business_usage_based` → `Business`。
 */
export function formatChatGPTPlanType(planType: string | undefined | null): string {
    if (!planType) {
        return '';
    }
    const key = planType.trim().toLowerCase();
    return CHATGPT_PLAN_TYPE_DISPLAY_NAMES[key] ?? planType;
}
