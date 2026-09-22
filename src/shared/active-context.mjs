// 活动上下文：任务模型当前使用的 checkpoint 与 raw-tail 起点。
//
// 目标机制见 docs/spec.md 的“活动上下文与 prompt cache 稳定性”。本模块回答三个问题：
// 当前分支上应当固定哪一段上下文，这段上下文在 Pi 报告的任务模型容量内是否装得下，
// 以及接管阶段如何把该段上下文渲染为 Pi context hook 可返回的 provider messages。

import { readFile, rm } from "node:fs/promises";

// omp-ov-memory adaptation: the reusable engine must not load either agent runtime.
import { sessionEntryToContextMessages } from "./context-messages.mjs";

import {
  checkpointEventIdFor,
  checkpointId as deriveCheckpointId,
  parseCheckpointEventById,
  renderCheckpointBlock,
} from "./checkpoint.mjs";
import { contextTokenWeight, eventTokenWeight } from "./context-weight.mjs";
import { observation as processObservation } from "./observe.mjs";
import { reconstructPiEntry } from "./recorded-event.mjs";
import { stateFileKey, writeStateFile } from "./state-file.mjs";

const ACTIVE_CONTEXT_IDENTITY_VERSION = 1;
const ACTIVE_CONTEXT_DOMAIN = "pi-openviking/active-context";
const CHECKPOINT_ID_PATTERN = /^chk_[0-9a-f]{64}$/;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{64}$/;

export function activeContextFileKey(target, sessionId) {
  return stateFileKey(ACTIVE_CONTEXT_DOMAIN, ACTIVE_CONTEXT_IDENTITY_VERSION, target, sessionId);
}

/**
 * 只接受 `docs/spec.md` 定义的两个字段。
 *
 * 该文件不是事实源：任何无法自证的内容都等价于“没有活动上下文”，随后从 Archive 与
 * checkpoint 事实重新选择，因此这里不抛错、只返回 null。
 */
export function normalizeActiveContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "checkpointId,rawTailStartEventId") return null;
  if (!CHECKPOINT_ID_PATTERN.test(value.checkpointId) || !EVENT_ID_PATTERN.test(value.rawTailStartEventId)) return null;
  return { checkpointId: value.checkpointId, rawTailStartEventId: value.rawTailStartEventId };
}

export async function readActiveContext(path) {
  try {
    return normalizeActiveContext(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function writeActiveContext(path, context) {
  const normalized = normalizeActiveContext(context);
  if (!normalized) throw new TypeError("ActiveContext requires a checkpointId and a rawTailStartEventId");
  return writeStateFile(path, normalized);
}

export async function clearActiveContext(path) {
  await rm(path, { force: true });
}

/**
 * 当前分支上的候选活动上下文。
 *
 * 来源是最后一个已消费的 Archive：checkpoint 替换的正是它绑定的已归档前缀，因此 raw tail
 * 从该 Archive 的最后一个事件之后开始，并自然覆盖“已归档但尚未消费”与“尚未归档”的全部
 * 事件。归档前缀之后还没有事件时没有可接管的上下文。
 */
export function selectActiveContext(branchEvents, archives, lastCheckpointId) {
  if (!CHECKPOINT_ID_PATTERN.test(lastCheckpointId ?? "")) return null;
  const source = (archives ?? []).find((descriptor) => {
    try {
      return deriveCheckpointId(descriptor?.manifest) === lastCheckpointId;
    } catch {
      return false;
    }
  });
  if (!source) return null;
  const position = branchEvents.findIndex((event) => event.eventId === source.manifest.lastEventId);
  const next = position < 0 ? undefined : branchEvents[position + 1];
  return next ? { checkpointId: lastCheckpointId, rawTailStartEventId: next.eventId } : null;
}

/**
 * 复用条件：raw tail 起点仍在当前分支的事件链上。
 *
 * raw tail 起点是来源 Archive 边界的直接后继，因此它在祖先链上等价于来源边界在祖先链上；
 * 该判定只依赖本地分支投影，分支变化时不需要网络即可决定能否复用。
 */
export function activeContextOnBranch(context, branchEvents) {
  return Boolean(context) && branchEvents.some((event) => event.eventId === context.rawTailStartEventId);
}

function sameActiveContext(left, right) {
  return Boolean(left) && Boolean(right) && left.checkpointId === right.checkpointId &&
    left.rawTailStartEventId === right.rawTailStartEventId;
}

/**
 * 原始用户指令 anchor：建立 raw tail 所属 turn 的 user entry 的全部事件。
 *
 * anchor 因此不需要成为持久化字段——turn 身份由不可变事件固定，同一 raw tail 起点恒得同一
 * anchor。anchor 本身已经落在 raw tail 内时返回空，避免同一指令注入两次。
 */
export function anchorEvents(branchEvents, rawTailStartEventId) {
  const start = branchEvents.findIndex((event) => event.eventId === rawTailStartEventId);
  if (start < 0) return [];
  const turnId = branchEvents[start].turnId;
  if (typeof turnId !== "string") return [];
  // turnId 来自 raw tail 起点自身，因此 find 至少会命中它：只需判断 anchor 是否就是起点。
  const first = branchEvents.find((event) => event.turnId === turnId);
  if (first.eventId === rawTailStartEventId) return [];
  return branchEvents.filter((event, index) => index < start && event.source?.entryId === first.source?.entryId);
}

function contextEntryGroups(events) {
  const groups = [];
  for (const event of events ?? []) {
    const previous = groups.at(-1);
    if (previous && previous[0]?.source?.entryId === event?.source?.entryId) previous.push(event);
    else groups.push([event]);
  }
  return groups.map((group) => {
    const entry = reconstructPiEntry(group);
    const messages = entry?.type === "compaction" && entry.details?.type === "openviking-active-context"
      ? []
      : sessionEntryToContextMessages(entry);
    return { events: group, messages };
  });
}

function sumWeight(events) {
  return contextEntryGroups(events).reduce((total, group) => group.messages.length === 0
    ? total
    : total + group.events.reduce((sum, event) => sum + eventTokenWeight(event), 0), 0);
}

/**
 * dry-run：把候选上下文 materialize 成任务模型将会看到的有序分段。
 *
 * 每一段都由不可变来源重算——checkpoint 由自身身份自证，anchor 与 raw tail 直接引用源事件
 * 对象——因此可以逐项对照源事件校验，而不需要另存一份副本。
 *
 * 装不装得下不在这里判定：checkpoint 正文只有完整或不用两种形态，是否超出
 * `checkpointTokenBudget` 与容量一样是候选的适配问题，由 `evaluateEligibility` 单点回答。
 */
export function materializeActiveContext({ context, checkpoint, branchEvents, systemPrompt = "", toolDefinitions = "" }) {
  const start = branchEvents.findIndex((event) => event.eventId === context?.rawTailStartEventId);
  if (start < 0) throw new Error("raw tail start is not on the current branch");
  const rawTail = branchEvents.slice(start);
  const anchor = anchorEvents(branchEvents, context.rawTailStartEventId);
  const checkpointBlock = renderCheckpointBlock(checkpoint);
  const tokens = {
    system: contextTokenWeight(systemPrompt),
    tools: contextTokenWeight(toolDefinitions),
    checkpoint: contextTokenWeight(checkpointBlock),
    anchor: sumWeight(anchor),
    rawTail: sumWeight(rawTail),
  };
  tokens.payload = tokens.system + tokens.tools + tokens.checkpoint + tokens.anchor + tokens.rawTail;
  return {
    segments: [
      { kind: "system", text: systemPrompt },
      { kind: "checkpoint", text: checkpointBlock },
      { kind: "anchor", events: anchor },
      { kind: "raw-tail", events: rawTail },
    ],
    tokens,
  };
}

export function payloadSegment(payload, kind) {
  return payload?.segments.find((segment) => segment.kind === kind) ?? null;
}

function messagesFromEvents(events) {
  return contextEntryGroups(events).flatMap((group) => group.messages);
}

export function renderActiveContextMessages(payload) {
  const checkpoint = payloadSegment(payload, "checkpoint");
  const anchor = payloadSegment(payload, "anchor");
  const rawTail = payloadSegment(payload, "raw-tail");
  if (!checkpoint || typeof checkpoint.text !== "string" || !rawTail || !Array.isArray(rawTail.events)) {
    throw new Error("ActiveContext payload is not renderable");
  }
  const firstEvent = anchor?.events?.[0] ?? rawTail.events[0];
  const timestamp = Number.isFinite(Date.parse(firstEvent?.occurredAt)) ? Date.parse(firstEvent.occurredAt) : 0;
  return [
    {
      role: "custom",
      customType: "openviking-checkpoint",
      content: checkpoint.text,
      display: false,
      timestamp,
    },
    ...messagesFromEvents(anchor?.events ?? []),
    ...messagesFromEvents(rawTail.events),
  ];
}

/**
 * Pi 原生压缩后的恢复指引块。原生压缩的摘要不含归档指针；该块把“早期上下文已被压缩、
 * 完整历史仍可按身份找回”表达为模型可执行的下一步。takeover 激活时 checkpoint 块已携带
 * 同类指引，调用方只在没有 takeover 替换时注入本块。清单最多列最近 5 个 Archive，
 * 避免长会话的清单本身成为上下文负担。
 */
export function renderCompactionPointer(archives) {
  const lines = [
    "<openviking-compaction>",
    "Pi compacted the earlier context of this session. The full history remains archived in OpenViking and is recoverable:",
  ];
  if (archives.length === 0) {
    lines.push("- No committed archives are currently known to this process; use viking_search or the compaction summary above.");
  } else {
    lines.push(`- ${archives.length} committed archive(s) currently known in this session process:`);
    for (const descriptor of archives.slice(-5)) {
      lines.push(`  - ${descriptor.manifest.archiveId} (${descriptor.manifest.eventCount} events)`);
    }
  }
  lines.push(
    "- Recover details with viking_search (keywords), viking_archive_expand (an archive id above, or omit it to list archives known now), or viking_read (when an event index exposes a read URI).",
    "</openviking-compaction>",
  );
  return lines.join("\n");
}

/**
 * takeover eligibility。
 *
 * 容量与安全余量都取自 Pi 报告的任务模型元数据：`contextWindow` 是可用窗口，`maxTokens` 是
 * 必须为模型输出保留的容量，任何接管后的请求都不能占用它。`contextTokenThreshold` 是
 * context hook 的触发高水位，不改变候选 payload 是否装得下；余量为正表示候选上下文能在安全余量内完整装载。
 */
export function evaluateEligibility({ capacity, takeover, payloadTokens, checkpointTokens }) {
  const inactive = (eligibility) => ({
    eligibility,
    capacityTokens: Number.isFinite(capacity?.contextWindow) ? capacity.contextWindow : null,
    reserveTokens: Number.isFinite(capacity?.maxTokens) ? capacity.maxTokens : null,
    usableTokens: null,
    payloadTokens: Number.isFinite(payloadTokens) ? payloadTokens : null,
    headroomTokens: null,
  });
  if (takeover?.enabled === false) return inactive("takeover_disabled");
  if (!Number.isFinite(capacity?.contextWindow) || !Number.isFinite(capacity?.maxTokens)) return inactive("capacity_unknown");
  if (!Number.isFinite(payloadTokens)) return inactive("no_context");

  const usableTokens = Math.max(0, capacity.contextWindow - capacity.maxTokens);
  const headroomTokens = usableTokens - payloadTokens;
  // checkpoint 正文只有完整装载一种可用形态。配置了独立预算时，缺少 checkpoint 权重
  // 不能证明候选适配；超出预算与任务模型余量不足仍保留为两个可诊断成因。
  const budget = takeover?.checkpointTokenBudget;
  const budgetConfigured = Number.isSafeInteger(budget) && budget > 0;
  const checkpointFactsUnavailable = budgetConfigured && !Number.isFinite(checkpointTokens);
  const overBudget = budgetConfigured && Number.isFinite(checkpointTokens) && checkpointTokens > budget;
  const eligibility = checkpointFactsUnavailable
    ? "facts_unavailable"
    : overBudget
      ? "checkpoint_over_budget"
      : headroomTokens > 0 ? "eligible" : "capacity_mismatch";
  return {
    eligibility,
    capacityTokens: capacity.contextWindow,
    reserveTokens: capacity.maxTokens,
    usableTokens,
    payloadTokens,
    headroomTokens,
  };
}

/**
 * 当前 provider epoch 固定时始终渲染同一 ActiveContext；活动 payload 再次越过高水位时允许推进。
 * 旧候选容量失配或 checkpoint 超预算但存在更新 checkpoint 时，也允许尝试原子推进：新候选仍不适配则保持完整 Pi 上下文。
 */
export function evaluateTakeoverTrigger({
  enabled, eligibility, currentCheckpointId, nextCheckpointId = null, appliedCheckpointId,
  piUsageTokens, payloadTokens, highWaterTokens, activeHighWaterTokens = highWaterTokens,
}) {
  const epochActive = Boolean(
    currentCheckpointId && appliedCheckpointId && currentCheckpointId === appliedCheckpointId,
  );
  const usageTokens = epochActive ? payloadTokens : piUsageTokens;
  const selectedHighWaterTokens = epochActive ? activeHighWaterTokens : highWaterTokens;
  const aboveHighWater = Number.isFinite(usageTokens) && Number.isFinite(selectedHighWaterTokens) &&
    usageTokens >= selectedHighWaterTokens;
  const enabledForTakeover = enabled !== false;
  const eligible = enabledForTakeover && eligibility === "eligible";
  const recoverableMismatch = Boolean(
    enabledForTakeover && ["capacity_mismatch", "checkpoint_over_budget"].includes(eligibility) && currentCheckpointId &&
    nextCheckpointId && nextCheckpointId !== currentCheckpointId,
  );
  return {
    render: (eligible && (epochActive || aboveHighWater)) || recoverableMismatch,
    allowAdvance: (eligible && aboveHighWater) || recoverableMismatch,
    epochActive,
    usageTokens: Number.isFinite(usageTokens) ? usageTokens : null,
    highWaterTokens: Number.isFinite(selectedHighWaterTokens) ? selectedHighWaterTokens : null,
  };
}

const initialState = () => ({
  checkpointId: null,
  rawTailStartEventId: null,
  rawTailEvents: 0,
  eligibility: "no_context",
  capacityTokens: null,
  reserveTokens: null,
  usableTokens: null,
  payloadTokens: null,
  headroomTokens: null,
  lastFailure: null,
});

const errorMessage = (error) => `${error?.name || "Error"}: ${error?.message || String(error)}`;

/**
 * 活动上下文的选择、持久化与状态。
 *
 * 一经形成即保持固定，直到来源边界离开当前分支祖先链，或 lifecycle 层确认当前 provider epoch
 * 再次越过高水位并显式允许原子推进。
 */
export class ActiveContextManager {
  constructor({ path, adapter, takeover, observation = processObservation }) {
    this.path = path;
    this.adapter = adapter;
    this.takeover = takeover ?? { enabled: true, contextTokenThreshold: 0 };
    this.observe = observation;
    this.sessionId = null;
    this.context = null;
    this.loaded = false;
    this.checkpointCache = null;
    this.roundFailure = null;
    this.state = initialState();
    this.observe.emit("active_context_state", "snapshot", this.state, null);
  }

  get status() {
    return { ...this.state };
  }

  get current() {
    return this.context ? { ...this.context } : null;
  }

  observeFinalState() {
    this.observe.emit("active_context_state", "snapshot", this.state, null);
  }

  async update(sessionId, { branchEvents = [], archives = [], lastCheckpointId = null, capacity = null, systemPrompt = "", toolDefinitions = null, factsAvailable = true } = {}) {
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.context = null;
      this.loaded = false;
      this.checkpointCache = null;
    }
    if (!this.loaded) {
      this.context = this.path ? await readActiveContext(this.path) : null;
      this.loaded = true;
    }
    this.roundFailure = null;

    const branch = await this.resolveContext(branchEvents, archives, lastCheckpointId);
    this.observe.emit("active_context_select", branch, archives.length, branchEvents.length);
    await this.publish({ branchEvents, capacity, systemPrompt, toolDefinitions, factsAvailable });
    return this.status;
  }

  /** 选择或复用当前分支上的活动上下文；失效的持久化选择在此清除。 */
  async resolveContext(branchEvents, archives, lastCheckpointId) {
    if (activeContextOnBranch(this.context, branchEvents)) return "reused";
    const candidate = selectActiveContext(branchEvents, archives, lastCheckpointId);
    const invalidated = this.context !== null;
    this.checkpointCache = null;
    try {
      if (this.path) {
        if (candidate) await writeActiveContext(this.path, candidate);
        else if (invalidated) await clearActiveContext(this.path);
      }
      this.context = candidate;
    } catch (error) {
      this.recordFailure(error, "persist", "degrade");
      if (!candidate) this.context = null;
      return candidate ? "unavailable" : invalidated ? "invalidated" : "unavailable";
    }
    return candidate ? "selected" : invalidated ? "invalidated" : "unavailable";
  }

  async publish({ branchEvents, capacity, systemPrompt, toolDefinitions, factsAvailable }) {
    let candidate = null;
    let missing = !factsAvailable || this.roundFailure ? "facts_unavailable" : "no_context";
    if (this.context && factsAvailable) {
      try {
        candidate = await this.materialize(branchEvents, { systemPrompt, toolDefinitions });
      } catch (error) {
        this.recordFailure(error, "materialize", "degrade");
        missing = "facts_unavailable";
      }
    }

    const verdict = evaluateEligibility({
      capacity,
      takeover: this.takeover,
      payloadTokens: candidate ? candidate.tokens.payload : null,
      checkpointTokens: candidate ? candidate.tokens.checkpoint : null,
    });
    // 没有候选时，"为什么没有"比"没有"本身更有诊断价值：区分尚未形成与来源事实不可读。
    if (!factsAvailable || (!candidate && verdict.eligibility === "no_context")) verdict.eligibility = missing;
    this.applyState({
      checkpointId: this.context?.checkpointId ?? null,
      rawTailStartEventId: this.context?.rawTailStartEventId ?? null,
      rawTailEvents: candidate ? payloadSegment(candidate, "raw-tail").events.length : 0,
      ...verdict,
      lastFailure: this.roundFailure,
    });
  }

  /**
   * state 的唯一写入点。
   *
   * eligibility 决定与状态迁移必须成对发出：只发决定会让观察记录出现"判定变了但状态没变"的
   * 缺口，诊断者只能从决定反推状态，而状态本来就是本模块自己承担的观察职责。
   */
  applyState(next) {
    const previous = this.state;
    this.state = next;
    this.observe.emit(
      "active_context_eligibility", this.state.eligibility,
      this.state.capacityTokens, this.state.usableTokens, this.state.payloadTokens, this.state.headroomTokens,
    );
    if (JSON.stringify(previous) !== JSON.stringify(this.state)) {
      this.observe.emit("active_context_state", "change", previous, this.state);
    }
  }

  /** checkpoint 正文不可变：同一身份只读取一次。 */
  async loadCheckpoint(context = this.context) {
    const checkpointId = context?.checkpointId;
    if (!checkpointId) throw new Error("ActiveContext checkpoint is unavailable");
    if (this.checkpointCache?.checkpointId === checkpointId) return this.checkpointCache.checkpoint;
    const stored = await this.adapter.readEvent(this.sessionId, checkpointEventIdFor(checkpointId));
    const checkpoint = parseCheckpointEventById(stored.event, checkpointId);
    this.checkpointCache = { checkpointId, checkpoint, contentHash: stored.event?.contentHash ?? null };
    return checkpoint;
  }

  async materializeFor(context, branchEvents, { systemPrompt = "", toolDefinitions = null } = {}) {
    if (!context) return null;
    return materializeActiveContext({
      context,
      checkpoint: await this.loadCheckpoint(context),
      branchEvents,
      systemPrompt,
      toolDefinitions,
    });
  }

  /** dry-run：materialize 候选 payload，不改变任何产品状态。 */
  async materialize(branchEvents, options = {}) {
    return this.materializeFor(this.context, branchEvents, options);
  }

  /** 接管渲染：用当前任务模型事实重新判定 eligible 后，给 Pi context hook 提供替换消息。 */
  async takeoverMessages(branchEvents, {
    archives = [], lastCheckpointId = null, systemPrompt = "", toolDefinitions = null, capacity = null,
    factsAvailable = true, allowAdvance = true, advanceHighWaterTokens = null,
  } = {}) {
    if (!factsAvailable) {
      this.applyState({
        ...this.state,
        eligibility: "facts_unavailable",
        lastFailure: "Pi task model context facts unavailable",
      });
      return null;
    }
    try {
      // ActiveContext status may precede the user/assistant/tool entries appended since the last hook.
      // Recompute the current payload from this exact branch before deciding whether the epoch may advance.
      let currentPayload = null;
      let advance = allowAdvance;
      if (!advance && this.context && Number.isFinite(advanceHighWaterTokens)) {
        currentPayload = await this.materializeFor(this.context, branchEvents, { systemPrompt, toolDefinitions });
        advance = Boolean(currentPayload && currentPayload.tokens.payload >= advanceHighWaterTokens);
      }
      const latest = advance ? selectActiveContext(branchEvents, archives, lastCheckpointId) : null;
      const candidate = latest ?? this.context;
      const candidateIsCurrent = sameActiveContext(candidate, this.context);
      if (!activeContextOnBranch(candidate, branchEvents)) return null;

      const payload = candidateIsCurrent && currentPayload
        ? currentPayload
        : await this.materializeFor(candidate, branchEvents, { systemPrompt, toolDefinitions });
      const verdict = evaluateEligibility({
        capacity,
        takeover: this.takeover,
        payloadTokens: payload.tokens.payload,
        checkpointTokens: payload.tokens.checkpoint,
      });

      let rendered = null;
      if (verdict.eligibility === "eligible") {
        rendered = renderActiveContextMessages(payload);
        if (latest && !candidateIsCurrent) {
          if (this.path) await writeActiveContext(this.path, latest);
          this.context = latest;
        }
      }

      let statusContext = candidate;
      let statusPayload = payload;
      let statusVerdict = verdict;
      if (verdict.eligibility !== "eligible" && this.context && !candidateIsCurrent) {
        statusContext = this.context;
        statusPayload = currentPayload ?? await this.materializeFor(
          this.context, branchEvents, { systemPrompt, toolDefinitions },
        );
        statusVerdict = evaluateEligibility({
          capacity,
          takeover: this.takeover,
          payloadTokens: statusPayload.tokens.payload,
          checkpointTokens: statusPayload.tokens.checkpoint,
        });
      }
      this.applyState({
        checkpointId: statusContext.checkpointId,
        rawTailStartEventId: statusContext.rawTailStartEventId,
        rawTailEvents: payloadSegment(statusPayload, "raw-tail").events.length,
        ...statusVerdict,
        lastFailure: null,
      });
      return rendered;
    } catch (error) {
      this.recordFailure(error, "materialize", "degrade");
      this.applyState({ ...this.state, eligibility: "facts_unavailable", lastFailure: this.roundFailure });
      return null;
    }
  }

  /** Pi compaction 的自包含 checkpoint；事实不可读时返回 null，由 Pi 使用原生 compaction。 */
  async compaction(branchEvents, tokensBefore) {
    try {
      if (this.state.eligibility !== "eligible" || !activeContextOnBranch(this.context, branchEvents)) return null;
      const checkpoint = await this.loadCheckpoint();
      const start = branchEvents.find((event) => event.eventId === this.context.rawTailStartEventId);
      if (!start?.source?.entryId) return null;
      const summary = renderCheckpointBlock(checkpoint);
      return {
        summary,
        firstKeptEntryId: start.source.entryId,
        tokensBefore,
        details: {
          schemaVersion: 1,
          type: "openviking-active-context",
          checkpointId: checkpoint.checkpointId,
          checkpointHash: this.checkpointCache?.contentHash ?? null,
          sourceArchiveId: checkpoint.sourceArchiveId,
          sourceArchiveHash: checkpoint.sourceArchiveHash,
          rawTailStartEventId: this.context.rawTailStartEventId,
        },
      };
    } catch (error) {
      this.recordFailure(error, "compaction", "degrade", "native_compaction");
      return null;
    }
  }

  /** 活动上下文失败只影响诊断与 eligibility：事件、Archive 与 checkpoint 保持不变。 */
  recordFailure(error, errorCode, disposition, branch = "keep_full_context") {
    // `applyState` 是 state 的唯一写者；这里只记录本轮失败原因与产品降级分支。
    this.roundFailure = errorMessage(error);
    this.observe.emit("active_context_failure", error, errorCode, disposition, branch);
  }
}
