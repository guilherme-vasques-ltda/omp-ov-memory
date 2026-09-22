// Archive 的身份、manifest 与范围选择。
//
// Archive 把一段已确认的 immutable 事件绑定为一个可校验对象。事件本身已经由同步层
// 持久化，因此这里既不复制事件也不接触传输：只决定“哪一段事件构成一个 Archive”，
// 以及“这段事件的身份、顺序和内容如何被一份 manifest 复算出来”。

import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import { eventTokenWeight } from "./context-weight.mjs";
import { recordedEventBytes } from "./recorded-event.mjs";

const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_IDENTITY_VERSION = 1;

const ARCHIVE_DOMAIN = "pi-openviking/archive";
const ARCHIVE_ID_PATTERN = /^arc_[0-9a-f]{64}$/;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{64}$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** manifest 无法复算出自己声明的身份或内容：该字节不是一个 Archive。 */
export class ArchiveIntegrityError extends Error {
  constructor(message, archiveId) {
    super(message);
    this.name = "ArchiveIntegrityError";
    this.archiveId = archiveId;
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function archiveId(sessionId, firstEventId, lastEventId, eventCount) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("archiveId requires a non-empty sessionId");
  }
  if (!EVENT_ID_PATTERN.test(firstEventId) || !EVENT_ID_PATTERN.test(lastEventId)) {
    throw new TypeError("archiveId requires RecordedEvent boundary ids");
  }
  if (!Number.isSafeInteger(eventCount) || eventCount <= 0) {
    throw new TypeError("archiveId requires a positive event count");
  }
  const identity = [ARCHIVE_DOMAIN, ARCHIVE_IDENTITY_VERSION, sessionId, firstEventId, lastEventId, eventCount];
  return `arc_${sha256Hex(canonicalJsonBytes(identity))}`;
}

/** 聚合 hash 覆盖每个事件的完整规范字节及其顺序。 */
export function archiveContentHash(events) {
  const digests = events.map((event) => `sha256:${sha256Hex(recordedEventBytes(event))}`);
  return `sha256:${sha256Hex(canonicalJsonBytes([ARCHIVE_DOMAIN, ARCHIVE_IDENTITY_VERSION, "content", digests]))}`;
}

export function buildArchiveManifest(sessionId, events) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError("Archive requires at least one event");
  for (const event of events) {
    if (event?.source?.sessionId !== sessionId) throw new TypeError(`Archive event session mismatch: ${event?.eventId}`);
  }
  const first = events[0];
  const last = events.at(-1);
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    type: "archive-manifest",
    sessionId,
    archiveId: archiveId(sessionId, first.eventId, last.eventId, events.length),
    firstEventId: first.eventId,
    lastEventId: last.eventId,
    eventCount: events.length,
    contentHash: archiveContentHash(events),
  };
}

export function archiveManifestBytes(manifest) {
  return canonicalJsonBytes(manifest);
}

/**
 * 从字节复原 manifest，并要求它自证。
 *
 * Archive 的原子可见性不能依赖服务端写入语义：崩溃可以在目标 URI 上留下 0 字节或
 * 截断内容。因此“存在”不是接受证明，只有能解析、能复算出同一 `archiveId`、且规范
 * 字节与读到的字节完全一致的内容才是 Archive；其余一律不是。
 */
export function parseArchiveManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ArchiveIntegrityError("Archive manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ArchiveIntegrityError("Archive manifest is not an object");
  }
  const { schemaVersion, type, sessionId, firstEventId, lastEventId, eventCount, contentHash } = manifest;
  if (schemaVersion !== ARCHIVE_SCHEMA_VERSION || type !== "archive-manifest") {
    throw new ArchiveIntegrityError("Archive manifest schema is not supported", manifest.archiveId);
  }
  if (typeof sessionId !== "string" || sessionId.length === 0 ||
      !EVENT_ID_PATTERN.test(firstEventId) || !EVENT_ID_PATTERN.test(lastEventId) ||
      !Number.isSafeInteger(eventCount) || eventCount <= 0 ||
      !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new ArchiveIntegrityError("Archive manifest fields are not well formed", manifest.archiveId);
  }
  if (!ARCHIVE_ID_PATTERN.test(manifest.archiveId) ||
      manifest.archiveId !== archiveId(sessionId, firstEventId, lastEventId, eventCount)) {
    throw new ArchiveIntegrityError("Archive manifest does not recompute its own archiveId", manifest.archiveId);
  }
  // 只用已知字段重建规范字节：既拒绝未知字段，也拒绝非规范编码。
  const normalized = {
    schemaVersion,
    type,
    sessionId,
    archiveId: manifest.archiveId,
    firstEventId,
    lastEventId,
    eventCount,
    contentHash,
  };
  if (!archiveManifestBytes(normalized).equals(Buffer.from(bytes))) {
    throw new ArchiveIntegrityError("Archive manifest bytes are not canonical", manifest.archiveId);
  }
  return normalized;
}

/** 沿事件链累加的上下文压力；由构造单调不减。 */
function pressureSeries(events) {
  const series = new Array(events.length);
  let total = 0;
  for (let index = 0; index < events.length; index++) {
    total += eventTokenWeight(events[index]);
    series[index] = total;
  }
  return series;
}

function lastIndexAtOrBelow(series, target) {
  let low = 0;
  let high = series.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (series[middle] <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** 把候选边界退回到完整 entry/step 之前，使 Pi message 与 assistant/tool step 都不被拆开。 */
function snapToAtomicBoundary(events, endIndex) {
  let index = endIndex;
  while (index >= 0) {
    const current = events[index];
    const next = events[index + 1];
    if (!next) return index;
    const splitEntry = typeof current?.source?.entryId === "string"
      && current.source.entryId === next?.source?.entryId;
    const splitStep = typeof current?.stepId === "string" && current.stepId === next?.stepId;
    if (!splitEntry && !splitStep) return index;
    const entryId = splitEntry ? current.source.entryId : null;
    const stepId = splitStep ? current.stepId : null;
    do {
      index--;
    } while (index >= 0 && (
      (entryId !== null && events[index]?.source?.entryId === entryId)
      || (stepId !== null && events[index]?.stepId === stepId)
    ));
  }
  return index;
}

/**
 * 在一条事件链上确定所有 Archive 边界。
 *
 * 第 k 个 Archive 的目标压力是 `rawTailTokenBudget + k * chunkTokenBudget`，边界落在
 * 压力轴的绝对位置 `k * chunkTokenBudget` 上。该位置只取决于事件自身的权重，后续事件
 * 增长不会移动已有边界，同一条链重复计算得到同一组 Archive。
 */
export function planArchives(events, { chunkTokenBudget, rawTailTokenBudget }) {
  if (!Array.isArray(events) || events.length === 0) return [];
  if (!Number.isFinite(chunkTokenBudget) || chunkTokenBudget <= 0) throw new TypeError("chunkTokenBudget must be positive");
  if (!Number.isFinite(rawTailTokenBudget) || rawTailTokenBudget <= 0) throw new TypeError("rawTailTokenBudget must be positive");

  const series = pressureSeries(events);
  const total = series.at(-1);
  const plans = [];
  let start = 0;
  for (let index = 1; rawTailTokenBudget + index * chunkTokenBudget <= total; index++) {
    const candidate = lastIndexAtOrBelow(series, index * chunkTokenBudget);
    if (candidate < start) continue;
    const end = snapToAtomicBoundary(events, candidate);
    if (end < start) continue;
    plans.push({ startIndex: start, endIndex: end });
    start = end + 1;
  }
  return plans;
}

/** 同一条事件链的 Archive descriptor；生产规划只由这一处构造。 */
export function describeArchives(sessionId, events, budgets) {
  return planArchives(events, budgets).map((plan) => {
    const range = events.slice(plan.startIndex, plan.endIndex + 1);
    return {
      ...plan,
      manifest: buildArchiveManifest(sessionId, range),
      tokenCount: range.reduce((sum, event) => sum + eventTokenWeight(event), 0),
    };
  });
}
