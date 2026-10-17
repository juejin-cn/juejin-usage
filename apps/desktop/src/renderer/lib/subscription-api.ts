/** Keep IPC access at the Desktop renderer boundary. */
export const subscriptionApi = {
  getCodexSubscription: (...args: Parameters<typeof window.tud.getCodexSubscription>) => window.tud.getCodexSubscription(...args),
  getClaudeSubscription: (...args: Parameters<typeof window.tud.getClaudeSubscription>) => window.tud.getClaudeSubscription(...args),
  getCursorSubscription: (...args: Parameters<typeof window.tud.getCursorSubscription>) => window.tud.getCursorSubscription(...args),
  getCopilotSubscription: (...args: Parameters<typeof window.tud.getCopilotSubscription>) => window.tud.getCopilotSubscription(...args),
  getGrokSubscription: (...args: Parameters<typeof window.tud.getGrokSubscription>) => window.tud.getGrokSubscription(...args),
  getKimiSubscription: (...args: Parameters<typeof window.tud.getKimiSubscription>) => window.tud.getKimiSubscription(...args),
  getZcodeSubscription: (...args: Parameters<typeof window.tud.getZcodeSubscription>) => window.tud.getZcodeSubscription(...args),
  getAntigravitySubscription: (...args: Parameters<typeof window.tud.getAntigravitySubscription>) => window.tud.getAntigravitySubscription(...args),
  getQoderSubscription: (...args: Parameters<typeof window.tud.getQoderSubscription>) => window.tud.getQoderSubscription(...args),
  getMiniMaxSubscription: (...args: Parameters<typeof window.tud.getMiniMaxSubscription>) => window.tud.getMiniMaxSubscription(...args),
  getOpenCodeSubscription: (...args: Parameters<typeof window.tud.getOpenCodeSubscription>) => window.tud.getOpenCodeSubscription(...args),
  getDeepSeekSubscription: (...args: Parameters<typeof window.tud.getDeepSeekSubscription>) => window.tud.getDeepSeekSubscription(...args),
};
