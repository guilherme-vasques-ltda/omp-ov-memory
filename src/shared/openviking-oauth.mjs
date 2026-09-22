/**
 * OpenViking VLM OAuth provider 注册表。
 *
 * OpenViking 的 OAuth/订阅凭证 store 按 provider 各自定义（store 文件名、pin 环境变量、
 * bootstrap 源、就绪探测）；本模块把每个 provider 的上游事实收敛为一条注册项，消费方
 * （scripts/dev.mjs、scripts/cli.mjs、shared/managed-server-state.mjs）只按
 * credentialKind=oauth + provider 查表，不各自硬编码 provider 细节。上游新增 auth 来源时
 * 在此增加一条注册项；上游能力边界以安装中的 models/vlm/backends/ auth 实现为准。
 * store 位置约定与凭证边界见 docs/models.md 的 Codex OAuth 一节。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENVIKING_OAUTH_PROVIDERS = {
  "openai-codex": {
    label: "Codex OAuth",
    storeFile: "codex_auth.json",
    authPathEnv: "OPENVIKING_CODEX_AUTH_PATH",
    bootstrapPathEnv: "OPENVIKING_CODEX_BOOTSTRAP_PATH",
    bootstrapPath: () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
    // 锁定本仓库 pin 的 OpenViking 安装执行；stdout 不输出凭证。
    readinessProbe: [
      "from openviking.models.vlm.backends.codex_auth import has_codex_auth_available",
      "raise SystemExit(0 if has_codex_auth_available() else 1)",
    ].join("; "),
  },
};

/** 返回 provider 的 OAuth 注册项；该 provider 无 OAuth 机制时返回 null。 */
export function openVikingOAuthProvider(provider) {
  return OPENVIKING_OAUTH_PROVIDERS[provider] ?? null;
}
