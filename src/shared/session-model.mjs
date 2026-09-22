/**
 * OpenViking session id derivation for a Pi session.
 */

/**
 * `<prefix><sessionId>`，可选 `__<suffix>` 后缀。
 *
 * 前缀和后缀都必须显式传入：调用方决定命名空间，本模块只负责规范化。
 */
export function deriveHarnessSessionId(prefix, sessionId, suffix = "") {
  if (!prefix || typeof prefix !== "string") {
    throw new Error("deriveHarnessSessionId requires a non-empty prefix");
  }
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("deriveHarnessSessionId requires a non-empty sessionId");
  }
  const base = `${prefix}${sessionId}`;
  if (!suffix) return base;
  const normalized = String(suffix).replace(/:/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
  return `${base}__${normalized}`;
}
