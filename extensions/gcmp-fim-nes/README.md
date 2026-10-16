# AI Chat Models - FIM/NES Completion

GCMP 主扩展的**可选代码补全扩展**，提供 FIM 行内补全与 NES 下一编辑建议。

## 安装与启用

1. 使用 VS Code **1.138.0 或更高版本**，安装主扩展 [AI Chat Models](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp)。
2. 在扩展视图搜索 `vicanent.gcmp-fim-nes`，手动点击「安装」。主扩展不会自动安装本扩展。
3. 在主扩展中配置提供商 API Key，并按需配置补全模型及启用 `gcmp.fimCompletion.enabled` 或 `gcmp.nesCompletion.enabled`。两种模式默认关闭。

不安装、禁用或卸载本扩展均不影响主扩展的聊天功能。本扩展使用主扩展管理的 API Key 与代理服务，无需重复录入密钥。

## 从旧版升级

从 GCMP **0.29.0** 起，FIM / NES 不再包含在主扩展中。如需继续使用补全，请另行安装本扩展。已有 `gcmp.fimCompletion.*` 与 `gcmp.nesCompletion.*` 设置保持不变，安装后可继续使用。

模型配置、代理、手动触发和熔断器设置见[完整配置说明](https://github.com/VicBilibily/GCMP/blob/main/README.md#-fim--nes-内联补全建议功能)。调试日志位于输出通道 `GitHub Copilot Inline Completion via GCMP`。

---

## English

An **optional code completion companion** for GCMP, providing FIM inline completion and NES next edit suggestions.

### Install and Enable

1. Use **VS Code 1.138.0 or later** and install the main [AI Chat Models](https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp) extension.
2. Search for `vicanent.gcmp-fim-nes` in the Extensions view, then click **Install**. The main extension does not install this companion automatically.
3. Configure the provider API key in the main extension, choose completion models, and enable `gcmp.fimCompletion.enabled` or `gcmp.nesCompletion.enabled` as needed. Both modes are disabled by default.

Chat in the main extension remains available if this companion is not installed, disabled, or uninstalled. This extension reuses API keys and proxy services from the main extension; keys do not need to be entered again.

### Upgrade

Starting with GCMP **0.29.0**, FIM / NES is no longer bundled with the main extension. Install this companion to continue using completion. Existing `gcmp.fimCompletion.*` and `gcmp.nesCompletion.*` settings keep their names and can be reused.

See the [full configuration guide](https://github.com/VicBilibily/GCMP/blob/main/README.en.md#-fim--nes-inline-completion-suggestions) for model, proxy, manual trigger, and circuit breaker settings. Logs are available in the `GitHub Copilot Inline Completion via GCMP` output channel.
