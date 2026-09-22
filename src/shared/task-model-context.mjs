/**
 * 读取只有 Pi lifecycle 拥有的任务模型上下文事实。
 * system prompt 或工具 API 任一不可读时显式标记为不完整，调用方不得用空值接管。
 */
export function readTaskModelContext(pi, ctx, onError = () => {}) {
  const model = ctx?.model;
  const capacity = Number.isFinite(model?.contextWindow) && Number.isFinite(model?.maxTokens)
    ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
    : null;
  try {
    if (typeof ctx?.getSystemPrompt !== "function" ||
        typeof pi?.getActiveTools !== "function" || typeof pi?.getAllTools !== "function") {
      throw new Error("Pi task model context API unavailable");
    }
    const systemPrompt = String(ctx.getSystemPrompt() ?? "");
    const active = new Set(pi.getActiveTools());
    const allTools = pi.getAllTools();
    if (!Array.isArray(allTools)) throw new Error("Pi tool definitions unavailable");
    return {
      capacity,
      factsAvailable: true,
      systemPrompt,
      toolDefinitions: JSON.stringify(allTools.filter((tool) => active.has(tool?.name))),
    };
  } catch (error) {
    onError(error);
    return { capacity, factsAvailable: false, systemPrompt: "", toolDefinitions: "" };
  }
}
