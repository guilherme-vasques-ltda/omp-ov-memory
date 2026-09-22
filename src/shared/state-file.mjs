// 本地最小状态文件的键派生与原子写入。
//
// `SyncAck` 与 `ActiveContext` 都是"绑定到某个端点/账号/用户与会话的本地最小状态"，都必须
// 私有权限、原子替换、失败不留临时文件。这些是安全相关的不变量，复制一份就意味着以后只会
// 修好其中一处，因此由本模块单点维护。
//
// 读路径不在这里：`SyncAck` 是权威状态，损坏必须报错；`ActiveContext` 不是事实源，损坏等价
// 于"没有活动上下文"。两者的语义差异属于各自模块。

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJsonBytes } from "./canonical-json.mjs";

export function stateFileKey(domain, version, target, sessionId) {
  return createHash("sha256")
    .update(canonicalJsonBytes([domain, version, target, sessionId]))
    .digest("hex");
}

export async function writeStateFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return value;
}
