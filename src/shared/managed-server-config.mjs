import { join } from "node:path";

/** 生成最终用户首次 setup 使用的受管 OpenViking 配置。 */
export function createManagedServerConfig(home) {
  return {
    storage: { workspace: join(home, "data") },
    server: { host: "127.0.0.1", port: 1933 },
    embedding: {
      dense: { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 },
    },
    vlm: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      temperature: 0.0,
      max_retries: 2,
    },
  };
}
