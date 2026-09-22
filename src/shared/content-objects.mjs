// OpenViking Content API 的对象写入契约：请求限制、目录准备与响应判定。
//
// 事件与 Archive 都通过该 API 持久化，但各自的收录规则不同，因此本模块只负责
// 协议层事实——请求怎么拆、目录是否就绪、响应是否可信、失败属于哪一类——
// 收录规则（例如事件命名空间是否允许 updated）留在各自的领域模块。

import { setTimeout as delay } from "node:timers/promises";

export const BATCH_MAX_OPERATIONS = 128;
export const BATCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const BATCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export const CREATE_IF_ABSENT = Object.freeze({ kind: "create_if_absent" });

export function replaceIfHash(baseHash) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(baseHash))) {
    throw new TypeError(`replace_if_hash requires a sha256 base hash: ${baseHash}`);
  }
  return { kind: "replace_if_hash", base_hash: baseHash };
}

/** 目标 URI 已存在且字节不同：不可覆盖的完整性错误。 */
export class ContentConflictError extends Error {
  constructor(message, uri) {
    super(message);
    this.name = "ContentConflictError";
    this.uri = uri;
  }
}

/**
 * 目标路径被服务端正在进行的操作占用。
 *
 * OpenViking 用同一个 409 表达“字节冲突”和“路径占用”，只有 `details.conflict_type`
 * 能区分：前者不可重试且意味着完整性问题，后者重试同一请求即可成功。把两者混为
 * 一谈会把语义刷新期间的正常争用报成事实源损坏。
 */
export class ContentBusyError extends Error {
  constructor(message, uri) {
    super(message);
    this.name = "ContentBusyError";
    this.uri = uri;
    this.retryable = true;
  }
}
export class ContentWriteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ContentWriteError";
    Object.assign(this, details);
  }
}

/**
 * busy 重试的默认退避序列。语义刷新的争用窗口实测为秒级；预算刻意保持在数秒量级，
 * 更长的争用仍交给调用方的整组重放，避免 shutdown 等生命周期被长睡眠阻塞。
 */
export const BUSY_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);

/**
 * 对同一操作做有界 busy 重试：只有 ContentBusyError 触发重试，其余错误立即抛出。
 * 每次重试前经 `onRetry` 上报；重试耗尽或 signal 中止时保留最后一次 busy 错误，
 * 是否中止仍由调用方决定。
 */
export async function withBusyRetry(operation, { onRetry, delaysMs = BUSY_RETRY_DELAYS_MS, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ContentBusyError) || attempt >= delaysMs.length || signal?.aborted) throw error;
      onRetry?.(error, attempt + 1);
      try {
        await delay(delaysMs[attempt], undefined, { signal });
      } catch (delayError) {
        if (signal?.aborted) throw error;
        throw delayError;
      }
    }
  }
}

function raiseBatchFailure(response, fallbackUri) {
  if (response?.status === 409) {
    const details = response.error?.details;
    const uri = details?.resource || response.error?.resource || fallbackUri;
    const conflictType = details?.conflict_type;
    if (conflictType === "path_busy" || (conflictType == null && details?.retryable === true)) {
      throw new ContentBusyError("OpenViking path is busy; retry the same request", uri);
    }
    throw new ContentConflictError("OpenViking object bytes conflict with an existing object", uri);
  }
  throw new ContentWriteError("OpenViking batch-write failed", {
    status: Number(response?.status || 0),
    error: response?.error,
  });
}

/**
 * 严格核对 batch-write 响应，返回按结果分组的 URI 集合。
 *
 * 只断言协议层事实：响应形状合法、无重复、被接受的 URI 集合与请求完全一致。
 * 是否允许 `updated` 由调用方的收录规则决定。
 */
export function acceptBatchResult(response, rootUri, expectedUris) {
  if (!response?.ok) raiseBatchFailure(response, expectedUris[0]);
  const result = response.result;
  if (!result || result.root_uri !== rootUri || !Array.isArray(result.created) ||
      !Array.isArray(result.updated) || !Array.isArray(result.unchanged)) {
    throw new ContentWriteError("OpenViking batch-write returned an invalid result");
  }
  const accepted = [...result.created, ...result.updated, ...result.unchanged];
  if (new Set(accepted).size !== accepted.length || accepted.some((uri) => typeof uri !== "string")) {
    throw new ContentWriteError("OpenViking batch-write returned duplicate or invalid URIs");
  }
  const expected = [...expectedUris].sort();
  const actual = [...accepted].sort();
  if (expected.length !== actual.length || expected.some((uri, index) => uri !== actual[index])) {
    throw new ContentWriteError("OpenViking batch-write did not confirm every requested URI");
  }
  return {
    created: new Set(result.created),
    updated: new Set(result.updated),
    unchanged: new Set(result.unchanged),
  };
}

/** 按操作数和总字节拆分请求，单个对象超出文件上限直接拒绝。 */
export function planContentBatches(objects) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const object of objects) {
    if (object.bytes.length > BATCH_MAX_FILE_BYTES) {
      throw new ContentWriteError(`OpenViking object exceeds 8 MiB: ${object.uri}`);
    }
    if (current.length >= BATCH_MAX_OPERATIONS || bytes + object.bytes.length > BATCH_MAX_TOTAL_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(object);
    bytes += object.bytes.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 幂等建立 `resources` 到目标目录之间的每一层目录。 */
export async function ensureDirectoryChain(transport, resourceRoot, directoryUri, created = new Set()) {
  const root = resourceRoot.replace(/\/+$/, "");
  if (!directoryUri.startsWith(`${root}/`)) {
    throw new ContentWriteError(`directory is outside the bound resource root: ${directoryUri}`);
  }
  let current = root;
  for (const segment of directoryUri.slice(root.length).split("/").filter(Boolean)) {
    current = `${current}/${segment}`;
    if (created.has(current)) continue;
    const status = await transport.statUri(current);
    if (status?.ok && status.exists) {
      if (!status.isDir) throw new ContentConflictError("OpenViking directory path is a file", current);
      created.add(current);
      continue;
    }
    const result = await transport.mkdirUri(current);
    if (!result?.ok) {
      const raced = await transport.statUri(current);
      if (!raced?.ok || !raced.exists || !raced.isDir) {
        throw new ContentWriteError(`OpenViking mkdir failed: ${current}`, {
          status: Number(result?.status || 0),
          error: result?.error,
        });
      }
    }
    created.add(current);
  }
}

/**
 * 在同一 root 下写出一组对象，逐批严格核对响应。
 *
 * `precondition` 缺省为 `create_if_absent`；调用方通过对象上的 `precondition`
 * 表达自己的收录规则。返回合并后的结果分组。
 */
export async function writeContentObjects(transport, rootUri, objects, onBatchAccepted) {
  const created = new Set();
  const updated = new Set();
  const unchanged = new Set();
  for (const batch of planContentBatches(objects)) {
    const response = await transport.batchWrite({
      root_uri: rootUri,
      operations: batch.map((object) => ({
        uri: object.uri,
        content_base64: object.bytes.toString("base64"),
        precondition: object.precondition ?? CREATE_IF_ABSENT,
      })),
      wait: false,
    });
    const result = acceptBatchResult(response, rootUri, batch.map((object) => object.uri));
    // 调用方的收录规则在每批之后立即生效：违约后继续写入后续批次会削弱 fail-fast。
    onBatchAccepted?.(result);
    for (const uri of result.created) created.add(uri);
    for (const uri of result.updated) updated.add(uri);
    for (const uri of result.unchanged) unchanged.add(uri);
  }
  return { created, updated, unchanged };
}
