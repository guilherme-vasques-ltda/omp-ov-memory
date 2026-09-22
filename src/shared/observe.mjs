import { createHash, randomUUID } from "node:crypto";
import {
  close as closeFd,
  fstatSync,
  openSync,
  write as writeFd,
  writeSync,
} from "node:fs";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import { OPENVIKING_API_PREFIX, openVikingApiPath } from "./openviking-api.mjs";

export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVATION_IDENTITY_VERSION = 1;
export const OBSERVATION_SESSION_DOMAIN = "pi-openviking/observation-session";
export const OBSERVATION_QUEUE_CAPACITY = 1024;

const ENUM = (values) => ({ type: "string", enum: values });
const STRING = (maxLength, pattern) => ({ type: "string", maxLength, ...(pattern ? { pattern } : {}) });
const INTEGER = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: "integer", min, max });
const NUMBER = (min = 0) => ({ type: "number", min });
const BOOLEAN = Object.freeze({ type: "boolean" });
const NULLABLE_HASH = { type: "string", nullable: true, pattern: "^[0-9a-f]{64}$", maxLength: 64 };
const NULLABLE_INTEGER = { type: "integer", nullable: true, min: 0, max: Number.MAX_SAFE_INTEGER };
// 容量余量按定义可以为负：非正余量正是 capacity mismatch 的判据。
const NULLABLE_SIGNED_INTEGER = { type: "integer", nullable: true, min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
const HASH = STRING(64, "^[0-9a-f]{64}$");
const PHASE_BEGIN = ENUM(["begin"]);
const PHASE_END = ENUM(["end"]);
const MODE_SNAPSHOT = ENUM(["snapshot"]);
const MODE_CHANGE = ENUM(["change"]);

const schema = (required, optional = {}) => ({ required, optional });
const variants = (field, choices) => ({ variantField: field, variants: choices });
const stage = (owner, kind, data) => ({ owner, kind, data });

const HOOKS = [
  "session_start",
  "before_agent_start",
  "context",
  "tool_call",
  "turn_end",
  "session_before_compact",
  "session_compact",
  "session_tree",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_shutdown",
  "agent_end",
];
const HOOK_REASONS = ["startup", "reload", "new", "resume", "fork", "quit", "manual", "threshold", "overflow", "none"];
const SYNC_TRIGGERS = [
  "session_start",
  "turn_end",
  "session_compact",
  "session_tree",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_shutdown",
  "command",
];
const HTTP_ROUTES = [
  "/health",
  ...[
    "/content/abstract",
    "/content/batch-write",
    "/content/download",
    "/content/overview",
    "/content/read",
    "/fs",
    "/fs/ls",
    "/fs/mkdir",
    "/fs/stat",
    "/resources",
    "/search/find",
    "/search/search",
    "/sessions",
    "/sessions/{id}",
    "/sessions/{id}/commit",
    "/sessions/{id}/context",
    "/sessions/{id}/messages",
    "/tasks",
    "/tasks/{id}",
    "/system/status",
  ].map(openVikingApiPath),
  "other",
];
const TOOLS = [
  "viking_search",
  "viking_read",
  "viking_browse",
  "viking_remember",
  "viking_forget",
  "viking_add_resource",
  "viking_archive_expand",
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "other",
];
const ERROR_CLASSES = ["aborted", "filesystem", "http", "integrity", "protocol", "source", "timeout", "transport", "other"];
const FILESYSTEM_ERROR_CODES = new Set([
  "EACCES", "EBADF", "EEXIST", "EFBIG", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "EXDEV",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);
const DISPOSITIONS = ["degrade", "retry", "ignore", "abort_operation"];
// 活动上下文的判定结果是单一枚举：可接管，或说明为什么还不能接管。
const ACTIVE_CONTEXT_STATES = [
  "capacity_mismatch", "capacity_unknown", "checkpoint_over_budget", "eligible", "facts_unavailable",
  "no_context", "takeover_disabled",
];
const FAILURE_BASE = {
  errorClass: ENUM(ERROR_CLASSES),
  errorCode: STRING(64, "^[a-z0-9_]+$"),
  disposition: ENUM(DISPOSITIONS),
  messageBytes: INTEGER(),
};
const FAILURE_OPTIONAL = { status: INTEGER(0, 599) };

export const OBSERVATION_STAGE_REGISTRY = deepFreeze({
  observe_run_start: stage("shared/observe.mjs", "state", schema({
    mode: MODE_SNAPSHOT,
    status: ENUM(["ready"]),
  })),
  observe_run_end: stage("shared/observe.mjs", "state", schema({
    mode: MODE_SNAPSHOT,
    status: ENUM(["ready"]),
    accepted: INTEGER(),
    dropped: INTEGER(),
  })),
  pi_lifecycle: stage("index.ts", "boundary", variants("phase", {
    begin: schema({ phase: PHASE_BEGIN, hook: ENUM(HOOKS), reason: ENUM(HOOK_REASONS) }),
    end: schema({
      phase: PHASE_END,
      hook: ENUM(HOOKS),
      reason: ENUM(HOOK_REASONS),
      outcome: ENUM(["success", "skipped", "error"]),
      durationMs: NUMBER(),
    }),
  })),
  pi_entry_append: stage("index.ts", "boundary", variants("phase", {
    begin: schema({
      phase: PHASE_BEGIN,
      operation: ENUM(["profile_injection", "recall_injection", "compaction_pointer"]),
      entryType: ENUM(["ov-observation"]),
    }),
    end: schema({
      phase: PHASE_END,
      operation: ENUM(["profile_injection", "recall_injection", "compaction_pointer"]),
      entryType: ENUM(["ov-observation"]),
      outcome: ENUM(["appended", "error"]),
      durationMs: NUMBER(),
    }),
  })),
  memory_namespace: stage("index.ts", "decision", schema({
    sessionScoped: BOOLEAN,
    configuredUser: BOOLEAN,
    branch: ENUM(["session", "shared_configured", "shared_resolved"]),
  })),
  sync_schedule: stage("index.ts", "decision", schema({
    trigger: ENUM(SYNC_TRIGGERS),
    connected: BOOLEAN,
    branch: ENUM(["sync", "observe", "skip_bypassed", "skip_current", "skip_disabled"]),
  })),
  profile_result: stage("index.ts", "decision", schema({
    branch: ENUM(["inject", "omit"]),
    chars: INTEGER(),
  })),
  index_failure: stage("index.ts", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["health_refresh", "observation_append", "profile_load", "sync_schedule", "task_model_context"]),
    branch: ENUM(["continue_pi", "omit_profile"]),
  }, FAILURE_OPTIONAL)),
  tool_uri_guard: stage("lib/uri-guard-adapter.mjs", "decision", schema({
    tool: ENUM(TOOLS),
    branch: ENUM(["block"]),
  })),
  client_http: stage("client.ts", "boundary", variants("phase", {
    begin: schema({
      phase: PHASE_BEGIN,
      method: ENUM(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      route: ENUM(HTTP_ROUTES),
      timeoutMs: INTEGER(0),
    }),
    end: schema({
      phase: PHASE_END,
      outcome: ENUM(["success", "http_error", "network_error", "aborted"]),
      durationMs: NUMBER(),
    }, {
      status: INTEGER(0, 599),
      traceId: STRING(128, "^[A-Za-z0-9._:-]+$"),
    }),
  })),
  client_connection: stage("client.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: BOOLEAN }),
    change: schema({ mode: MODE_CHANGE, from: BOOLEAN, to: BOOLEAN }),
  })),
  client_namespace: stage("client.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: NULLABLE_HASH, bound: BOOLEAN }),
    change: schema({ mode: MODE_CHANGE, from: NULLABLE_HASH, to: NULLABLE_HASH, bound: BOOLEAN }),
  })),
  sync_source: stage("sync.ts", "decision", schema({
    branch: ENUM(["persistent_jsonl", "pending_persistence", "in_memory"]),
    entries: INTEGER(),
  })),
  shutdown_grace: stage("sync.ts", "decision", schema({
    timeoutMs: INTEGER(),
    branch: ENUM(["drained", "deadline"]),
  })),
  sync_capability: stage("sync.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: ENUM(["unknown", "ready", "mismatch"]) }),
    change: schema({ mode: MODE_CHANGE, from: ENUM(["unknown", "ready", "mismatch"]), to: ENUM(["unknown", "ready", "mismatch"]) }),
  })),
  sync_ack: stage("sync.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: HASH, count: INTEGER(), pending: INTEGER() }),
    change: schema({
      mode: MODE_CHANGE,
      from: HASH,
      to: HASH,
      fromCount: INTEGER(),
      toCount: INTEGER(),
      fromPending: INTEGER(),
      toPending: INTEGER(),
    }),
  })),
  sync_ack_advance: stage("sync.ts", "decision", schema({
    projected: INTEGER(),
    accepted: INTEGER(),
    capabilityVerified: BOOLEAN,
    branch: ENUM(["advance"]),
  })),
  sync_failure: stage("sync.ts", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["ack_persist", "ack_read", "capability", "delivery", "not_initialized", "projection", "source"]),
    branch: ENUM(["pending_replay", "replay_all"]),
    added: INTEGER(),
    pending: INTEGER(),
  }, FAILURE_OPTIONAL)),
  event_representation: stage("shared/recorded-event-adapter.mjs", "decision", schema({
    direct: INTEGER(),
    chunked: INTEGER(),
    branch: ENUM(["direct", "chunked", "mixed", "empty"]),
  })),
  archive_plan: stage("shared/archive-store.mjs", "decision", schema({
    planned: INTEGER(),
    pending: INTEGER(),
    events: INTEGER(),
    branch: ENUM(["form", "idle"]),
  })),
  archive_commit: stage("shared/archive-store.mjs", "decision", schema({
    branch: ENUM(["already_committed", "proof_reused", "created", "repaired_residue"]),
    eventCount: INTEGER(),
  })),
  archive_state: stage("shared/archive-store.mjs", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: NULLABLE_HASH, committed: INTEGER(), pending: INTEGER() }),
    change: schema({
      mode: MODE_CHANGE,
      from: NULLABLE_HASH,
      to: NULLABLE_HASH,
      fromCommitted: INTEGER(),
      toCommitted: INTEGER(),
      fromPending: INTEGER(),
      toPending: INTEGER(),
    }),
  })),
  archive_failure: stage("shared/archive-store.mjs", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["commit", "manifest_integrity"]),
    branch: ENUM(["pending_retry", "skip_archive"]),
    committed: INTEGER(),
    pending: INTEGER(),
  }, FAILURE_OPTIONAL)),
  checkpoint_request: stage("shared/checkpoint-store.mjs", "decision", schema({
    branch: ENUM(["submit", "resume", "complete", "obsolete"]),
    attempt: INTEGER(1, 3),
    pending: INTEGER(),
  })),
  checkpoint_process: stage("shared/checkpoint-processor.mjs", "boundary", variants("phase", {
    begin: schema({ phase: PHASE_BEGIN, events: INTEGER(), media: INTEGER() }),
    end: schema({
      phase: PHASE_END,
      outcome: ENUM(["completed", "processing", "failed"]),
      durationMs: NUMBER(),
    }),
  })),
  checkpoint_state: stage("shared/checkpoint-store.mjs", "state", variants("mode", {
    snapshot: schema({
      mode: MODE_SNAPSHOT,
      status: ENUM(["caught_up", "processing", "lagging", "failed"]),
      currentArchive: NULLABLE_HASH,
      checkpoint: NULLABLE_HASH,
      consumed: INTEGER(),
      pending: INTEGER(),
      backlogTokens: INTEGER(),
    }),
    change: schema({
      mode: MODE_CHANGE,
      fromStatus: ENUM(["caught_up", "processing", "lagging", "failed"]),
      toStatus: ENUM(["caught_up", "processing", "lagging", "failed"]),
      fromCurrentArchive: NULLABLE_HASH,
      toCurrentArchive: NULLABLE_HASH,
      fromCheckpoint: NULLABLE_HASH,
      toCheckpoint: NULLABLE_HASH,
      fromConsumed: INTEGER(),
      toConsumed: INTEGER(),
      fromPending: INTEGER(),
      toPending: INTEGER(),
      fromBacklogTokens: INTEGER(),
      toBacklogTokens: INTEGER(),
    }),
  })),
  checkpoint_failure: stage("shared/checkpoint-store.mjs", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM([
      "cleanup", "empty_output", "invalid_output", "media_prepare", "message_add", "reconcile", "session_commit", "session_create",
      "session_read", "task_cancelled", "task_failed", "task_list", "task_missing", "task_read", "task_timeout",
    ]),
    branch: ENUM(["pending_retry", "retry_attempt", "retry_exhausted", "retain_fact"]),
    pending: INTEGER(),
    backlogTokens: INTEGER(),
  }, FAILURE_OPTIONAL)),
  active_context_select: stage("shared/active-context.mjs", "decision", schema({
    branch: ENUM(["reused", "selected", "invalidated", "unavailable"]),
    archives: INTEGER(),
    events: INTEGER(),
  })),
  active_context_eligibility: stage("shared/active-context.mjs", "decision", schema({
    branch: ENUM(ACTIVE_CONTEXT_STATES),
    capacity: NULLABLE_INTEGER,
    usable: NULLABLE_INTEGER,
    payload: NULLABLE_INTEGER,
    headroom: NULLABLE_SIGNED_INTEGER,
  })),
  active_context_takeover: stage("index.ts", "decision", schema({
    branch: ENUM(["replace_context", "reuse_context", "below_high_water", "keep_full_context"]),
    eligibility: ENUM(ACTIVE_CONTEXT_STATES),
    usageTokens: NULLABLE_INTEGER,
    highWaterTokens: NULLABLE_INTEGER,
    messages: INTEGER(),
  })),
  active_context_compaction: stage("index.ts", "decision", schema({
    branch: ENUM(["provide_context", "native_compaction"]),
    eligibility: ENUM(ACTIVE_CONTEXT_STATES),
  })),
  active_context_state: stage("shared/active-context.mjs", "state", variants("mode", {
    snapshot: schema({
      mode: MODE_SNAPSHOT,
      status: ENUM(ACTIVE_CONTEXT_STATES),
      checkpoint: NULLABLE_HASH,
      rawTailStart: NULLABLE_HASH,
      rawTailEvents: INTEGER(),
      headroom: NULLABLE_SIGNED_INTEGER,
    }),
    change: schema({
      mode: MODE_CHANGE,
      fromStatus: ENUM(ACTIVE_CONTEXT_STATES),
      toStatus: ENUM(ACTIVE_CONTEXT_STATES),
      fromCheckpoint: NULLABLE_HASH,
      toCheckpoint: NULLABLE_HASH,
      fromRawTailStart: NULLABLE_HASH,
      toRawTailStart: NULLABLE_HASH,
      fromRawTailEvents: INTEGER(),
      toRawTailEvents: INTEGER(),
      fromHeadroom: NULLABLE_SIGNED_INTEGER,
      toHeadroom: NULLABLE_SIGNED_INTEGER,
    }),
  })),
  active_context_failure: stage("shared/active-context.mjs", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["compaction", "materialize", "persist"]),
    branch: ENUM(["keep_full_context", "native_compaction"]),
  }, FAILURE_OPTIONAL)),
  recall_request: stage("recall.ts", "decision", schema({
    queryChars: INTEGER(),
    branch: ENUM(["cache", "skip_short", "search"]),
  })),
  recall_source: stage("shared/recall-core.mjs", "decision", schema({
    branch: ENUM(["context_face", "raw_find"]),
    resultCount: INTEGER(),
  })),
  recall_filter: stage("shared/recall-core.mjs", "decision", schema({
    branch: ENUM(["safe", "filter_internal", "unproven"]),
    accepted: INTEGER(),
    rejected: INTEGER(),
  })),
  recall_result: stage("recall.ts", "decision", schema({
    operation: ENUM(["search", "inject"]),
    branch: ENUM(["available", "empty", "injected", "unchanged"]),
    chars: INTEGER(),
  })),
  recall_failure: stage("shared/recall-core.mjs", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["context_error", "context_unsupported"]),
    branch: ENUM(["raw_find"]),
  }, FAILURE_OPTIONAL)),
  tool_availability: stage("tools.ts", "decision", schema({
    tool: ENUM(TOOLS),
    connected: BOOLEAN,
    branch: ENUM(["proceed", "unavailable"]),
  })),
  tool_scope: stage("tools.ts", "decision", schema({
    tool: ENUM(TOOLS),
    operation: ENUM(["archive", "browse", "delete", "read", "resource_add", "search_request", "search_result"]),
    scoped: BOOLEAN,
    branch: ENUM(["allow", "deny", "clamp", "filter"]),
    accepted: INTEGER(),
    rejected: INTEGER(),
  })),
});

/** index.ts 的注入种类到白名单 operation 的映射；未知名种不允许静默归入他类。 */
function piEntryAppendOperation(kind) {
  if (kind === "profile-injection") return "profile_injection";
  if (kind === "recall-injection") return "recall_injection";
  if (kind === "compaction-pointer") return "compaction_pointer";
  throw new TypeError(`unknown pi_entry_append kind: ${kind}`);
}

const ENCODERS = Object.freeze({
  observe_run_start: () => ({ mode: "snapshot", status: "ready" }),
  observe_run_end: (accepted, dropped) => ({ mode: "snapshot", status: "ready", accepted, dropped }),
  pi_lifecycle: {
    begin: (hook, reason = "none") => ({ phase: "begin", hook, reason: normalizeHookReason(reason) }),
    end: (hook, reason = "none", outcome = "success", durationMs = 0) => ({
      phase: "end", hook, reason: normalizeHookReason(reason), outcome, durationMs,
    }),
  },
  pi_entry_append: {
    begin: (kind) => ({
      phase: "begin",
      operation: piEntryAppendOperation(kind),
      entryType: "ov-observation",
    }),
    end: (kind, outcome, durationMs) => ({
      phase: "end",
      operation: piEntryAppendOperation(kind),
      entryType: "ov-observation",
      outcome,
      durationMs,
    }),
  },
  memory_namespace: (sessionScoped, configuredUser) => ({
    sessionScoped: Boolean(sessionScoped),
    configuredUser: Boolean(configuredUser),
    branch: sessionScoped ? "session" : configuredUser ? "shared_configured" : "shared_resolved",
  }),
  sync_schedule: (trigger, connected, branch) => ({
    trigger,
    connected: Boolean(connected),
    branch: branch ?? (connected ? "sync" : "observe"),
  }),
  profile_result: (value) => ({ branch: value ? "inject" : "omit", chars: safeLength(value) }),
  index_failure: (error, errorCode, disposition, branch) => failureData(error, errorCode, disposition, branch),
  tool_uri_guard: (tool) => ({ tool: normalizeTool(tool), branch: "block" }),
  client_http: {
    begin: (path, method = "GET", timeoutMs = 0) => ({
      phase: "begin",
      method: normalizeMethod(method),
      route: routeTemplate(path),
      timeoutMs: safeInteger(timeoutMs),
    }),
    end: (outcome, status, traceId, durationMs) => ({
      phase: "end",
      outcome,
      durationMs,
      ...(Number.isInteger(status) && status >= 0 && status <= 599 ? { status } : {}),
      ...(validTraceId(traceId) ? { traceId } : {}),
    }),
  },
  client_connection: (mode, from, to) => mode === "snapshot"
    ? { mode, current: Boolean(from) }
    : { mode, from: Boolean(from), to: Boolean(to) },
  client_namespace: (mode, from, to) => mode === "snapshot"
    ? { mode, current: namespaceHash(from), bound: Boolean(from) }
    : { mode, from: namespaceHash(from), to: namespaceHash(to), bound: Boolean(to) },
  sync_source: (branch, entries) => ({ branch, entries: safeInteger(entries) }),
  shutdown_grace: (timeoutMs, drained) => ({ timeoutMs: safeInteger(timeoutMs), branch: drained ? "drained" : "deadline" }),
  sync_capability: (mode, from, to) => mode === "snapshot"
    ? { mode, current: from }
    : { mode, from, to },
  sync_ack: (mode, from, to, fromPending, toPending) => mode === "snapshot"
    ? { mode, current: ackHash(from), count: leafCount(from), pending: safeInteger(fromPending) }
    : {
        mode,
        from: ackHash(from),
        to: ackHash(to),
        fromCount: leafCount(from),
        toCount: leafCount(to),
        fromPending: safeInteger(fromPending),
        toPending: safeInteger(toPending),
      },
  sync_ack_advance: (projected, accepted, capabilityVerified) => ({
    projected: safeInteger(projected),
    accepted: safeInteger(accepted),
    capabilityVerified: Boolean(capabilityVerified),
    branch: "advance",
  }),
  sync_failure: (error, errorCode, disposition, branch, added, pending) => ({
    ...failureData(error, errorCode, disposition, branch),
    added: safeInteger(added),
    pending: safeInteger(pending),
  }),
  event_representation: (direct, chunked) => {
    const directCount = safeInteger(direct?.length);
    const chunkedCount = safeInteger(chunked?.length);
    const branch = directCount > 0 && chunkedCount > 0 ? "mixed"
      : directCount > 0 ? "direct"
        : chunkedCount > 0 ? "chunked"
          : "empty";
    return { direct: directCount, chunked: chunkedCount, branch };
  },
  archive_plan: (planned, pending, events) => ({
    planned: safeInteger(planned),
    pending: safeInteger(pending),
    events: safeInteger(events),
    branch: safeInteger(pending) > 0 ? "form" : "idle",
  }),
  archive_commit: (branch, eventCount) => ({ branch, eventCount: safeInteger(eventCount) }),
  archive_state: (mode, from, to) => mode === "snapshot"
    ? {
        mode,
        current: archiveDigest(from?.lastArchiveId),
        committed: safeInteger(from?.committed),
        pending: safeInteger(from?.pending),
      }
    : {
        mode,
        from: archiveDigest(from?.lastArchiveId),
        to: archiveDigest(to?.lastArchiveId),
        fromCommitted: safeInteger(from?.committed),
        toCommitted: safeInteger(to?.committed),
        fromPending: safeInteger(from?.pending),
        toPending: safeInteger(to?.pending),
      },
  archive_failure: (error, errorCode, disposition, branch, committed, pending) => ({
    ...failureData(error, errorCode, disposition, branch),
    committed: safeInteger(committed),
    pending: safeInteger(pending),
  }),
  checkpoint_request: (branch, attempt, pending) => ({
    branch,
    attempt: safeInteger(attempt),
    pending: safeInteger(pending),
  }),
  checkpoint_process: {
    begin: (events, media) => ({
      phase: "begin",
      events: safeInteger(events),
      media: safeInteger(media),
    }),
    end: (outcome, durationMs) => ({ phase: "end", outcome, durationMs }),
  },
  checkpoint_state: (mode, from, to) => mode === "snapshot"
    ? {
        mode,
        status: from?.mode ?? "caught_up",
        currentArchive: archiveDigest(from?.currentArchiveId),
        checkpoint: checkpointDigest(from?.lastCheckpointId),
        consumed: safeInteger(from?.consumed),
        pending: safeInteger(from?.pending),
        backlogTokens: safeInteger(from?.backlogTokens),
      }
    : {
        mode,
        fromStatus: from?.mode ?? "caught_up",
        toStatus: to?.mode ?? "caught_up",
        fromCurrentArchive: archiveDigest(from?.currentArchiveId),
        toCurrentArchive: archiveDigest(to?.currentArchiveId),
        fromCheckpoint: checkpointDigest(from?.lastCheckpointId),
        toCheckpoint: checkpointDigest(to?.lastCheckpointId),
        fromConsumed: safeInteger(from?.consumed),
        toConsumed: safeInteger(to?.consumed),
        fromPending: safeInteger(from?.pending),
        toPending: safeInteger(to?.pending),
        fromBacklogTokens: safeInteger(from?.backlogTokens),
        toBacklogTokens: safeInteger(to?.backlogTokens),
      },
  checkpoint_failure: (error, errorCode, disposition, branch, pending, backlogTokens) => ({
    ...failureData(error, errorCode, disposition, branch),
    pending: safeInteger(pending),
    backlogTokens: safeInteger(backlogTokens),
  }),
  active_context_select: (branch, archives, events) => ({
    branch,
    archives: safeInteger(archives),
    events: safeInteger(events),
  }),
  active_context_eligibility: (eligibility, capacity, usable, payload, headroom) => ({
    branch: eligibility,
    capacity: nullableInteger(capacity),
    usable: nullableInteger(usable),
    payload: nullableInteger(payload),
    headroom: nullableInteger(headroom),
  }),
  active_context_takeover: (branch, eligibility, usageTokens, highWaterTokens, messages) => ({
    branch,
    eligibility: ACTIVE_CONTEXT_STATES.includes(eligibility) ? eligibility : "no_context",
    usageTokens: nullableInteger(usageTokens),
    highWaterTokens: nullableInteger(highWaterTokens),
    messages: safeInteger(messages),
  }),
  active_context_compaction: (branch, eligibility) => ({
    branch,
    eligibility: ACTIVE_CONTEXT_STATES.includes(eligibility) ? eligibility : "no_context",
  }),
  active_context_state: (mode, from, to) => mode === "snapshot"
    ? {
        mode,
        status: from?.eligibility ?? "no_context",
        checkpoint: checkpointDigest(from?.checkpointId),
        rawTailStart: eventDigest(from?.rawTailStartEventId),
        rawTailEvents: safeInteger(from?.rawTailEvents),
        headroom: nullableInteger(from?.headroomTokens),
      }
    : {
        mode,
        fromStatus: from?.eligibility ?? "no_context",
        toStatus: to?.eligibility ?? "no_context",
        fromCheckpoint: checkpointDigest(from?.checkpointId),
        toCheckpoint: checkpointDigest(to?.checkpointId),
        fromRawTailStart: eventDigest(from?.rawTailStartEventId),
        toRawTailStart: eventDigest(to?.rawTailStartEventId),
        fromRawTailEvents: safeInteger(from?.rawTailEvents),
        toRawTailEvents: safeInteger(to?.rawTailEvents),
        fromHeadroom: nullableInteger(from?.headroomTokens),
        toHeadroom: nullableInteger(to?.headroomTokens),
      },
  active_context_failure: (error, errorCode, disposition, branch) => failureData(error, errorCode, disposition, branch),
  recall_request: (branch, query) => ({ branch, queryChars: safeLength(query) }),
  recall_source: (branch, resultCount) => ({ branch, resultCount: safeInteger(resultCount) }),
  recall_filter: (branch, accepted, rejected) => ({ branch, accepted: safeInteger(accepted), rejected: safeInteger(rejected) }),
  recall_result: (operation, state, value) => ({
    operation,
    branch: operation === "search"
      ? state ? "available" : "empty"
      : state ? "injected" : "unchanged",
    chars: safeLength(operation === "search" ? state : value),
  }),
  recall_failure: (error, errorCode, disposition, branch, status) => ({
    ...failureData(error ?? (Number.isInteger(status) ? { status } : null), errorCode, disposition, branch),
  }),
  tool_availability: (tool, connected) => ({
    tool: normalizeTool(tool),
    connected: Boolean(connected),
    branch: connected ? "proceed" : "unavailable",
  }),
  tool_scope: (tool, operation, scoped, branch, accepted = 0, rejected = 0) => ({
    tool: normalizeTool(tool),
    operation,
    scoped: Boolean(scoped),
    branch,
    accepted: safeInteger(accepted),
    rejected: safeInteger(rejected),
  }),
});

const DISABLED_STATUS = Object.freeze({
  state: "disabled",
  reason: "not_requested",
  run: null,
  accepted: 0,
  dropped: 0,
});

/**
 * 未请求观察与观察已失效共用同一个零工作实现：两者对调用方的契约完全相同，只有
 * `getStatus` 报告的原因不同。合成一处后，`Observation` 接口新增方法只需改这里。
 */
function stubObservation(status) {
  return Object.freeze({
    emit() {},
    begin() { return 0; },
    end() {},
    bindSession() {},
    createProducer() { return this; },
    release() {},
    abandon() {},
    getStatus() { return status; },
    beginDrainDeadline() { return 0; },
    finishRemaining() { return Promise.resolve(); },
    finish() { return Promise.resolve(); },
  });
}

const DISABLED_OBSERVATION = stubObservation(DISABLED_STATUS);

function incompleteObservation(reason) {
  return stubObservation(Object.freeze({ state: "incomplete", reason, run: null, accepted: 0, dropped: 0 }));
}

export function createObservation(options = {}) {
  const env = options.env ?? process.env;
  const pathConfigured = Object.prototype.hasOwnProperty.call(env, "OV_OBSERVE");
  const fdConfigured = Object.prototype.hasOwnProperty.call(env, "OV_OBSERVE_FD");
  if (!pathConfigured && !fdConfigured) return DISABLED_OBSERVATION;
  if (pathConfigured && fdConfigured) return incompleteObservation("env_conflict");

  const deps = dependencies(options.dependencies);
  let fd;
  try {
    if (pathConfigured) {
      const path = String(env.OV_OBSERVE ?? "");
      if (!path) return incompleteObservation("invalid_path");
      fd = deps.open(path, "wx", 0o600);
      const stat = deps.fstat(fd);
      if (!validPrivateFile(stat, deps.uid())) {
        safeCloseSync(fd, deps);
        return incompleteObservation("invalid_path");
      }
    } else {
      const raw = String(env.OV_OBSERVE_FD ?? "");
      if (!/^[0-9]+$/.test(raw)) return incompleteObservation("invalid_fd");
      fd = Number(raw);
      if (!Number.isSafeInteger(fd) || fd < 3) return incompleteObservation("invalid_fd");
      const stat = deps.fstat(fd);
      if (!validPrivateFile(stat, deps.uid())) return incompleteObservation("invalid_fd");
      deps.probeWritable(fd);
    }
  } catch {
    if (pathConfigured && fd !== undefined) safeCloseSync(fd, deps);
    return incompleteObservation(pathConfigured ? "open_failed" : "invalid_fd");
  }

  try {
    return new ObservationRuntime(fd, deps, {
      autoFinalize: options.autoFinalize !== false,
      queueCapacity: options.queueCapacity ?? OBSERVATION_QUEUE_CAPACITY,
    });
  } catch {
    safeCloseSync(fd, deps);
    return incompleteObservation("initialization_failed");
  }
}

class ObservationRuntime {
  constructor(fd, deps, { autoFinalize, queueCapacity }) {
    this.fd = fd;
    this.deps = deps;
    this.capacity = Math.max(1, safeInteger(queueCapacity));
    this.run = deps.uuid();
    this.session = null;
    this.seq = 0;
    this.nextOp = 1;
    this.accepted = 0;
    this.dropped = 0;
    this.state = "ready";
    this.reason = "ready";
    this.sinkWritable = true;
    this.queue = [];
    this.writing = false;
    this.openOperations = new Map();
    this.waiters = [];
    this.finishPromise = null;
    this.closed = false;
    this.producers = new Set();
    this.#enqueue("state", "observe_run_start", ENCODERS.observe_run_start());
    if (autoFinalize) {
      this.beforeExit = () => { void this.finish(500); };
      process.once("beforeExit", this.beforeExit);
    }
  }

  emit(stageName, ...values) {
    this.emitFor(this.session, stageName, ...values);
  }

  emitFor(session, stageName, ...values) {
    if (this.closed) return;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return;
    }
    const descriptor = OBSERVATION_STAGE_REGISTRY[stageName];
    const encoder = ENCODERS[stageName];
    if (!descriptor || descriptor.kind === "boundary" || typeof encoder !== "function") {
      this.reject("schema_rejected");
      return;
    }
    try {
      this.#enqueue(descriptor.kind, stageName, encoder(...values), { session });
    } catch {
      this.reject("schema_rejected");
    }
  }

  begin(stageName, ...values) {
    return this.beginFor(this.session, stageName, ...values);
  }

  beginFor(session, stageName, ...values) {
    if (this.closed) return 0;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return 0;
    }
    const descriptor = OBSERVATION_STAGE_REGISTRY[stageName];
    const encoder = ENCODERS[stageName];
    if (!descriptor || descriptor.kind !== "boundary" || typeof encoder?.begin !== "function") {
      this.reject("schema_rejected");
      return 0;
    }
    try {
      const op = this.nextOp++;
      const started = this.deps.monotonicNow();
      const data = encoder.begin(...values);
      if (!this.#enqueue("boundary", stageName, data, { op, session })) return 0;
      this.openOperations.set(op, { stageName, started, session, values });
      return op;
    } catch {
      this.reject("schema_rejected");
      return 0;
    }
  }

  end(stageName, op, ...values) {
    if (!op) return;
    if (this.closed) return;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return;
    }
    const opened = this.openOperations.get(op);
    const encoder = ENCODERS[stageName];
    if (!opened || opened.stageName !== stageName || typeof encoder?.end !== "function") {
      this.reject("operation_mismatch");
      return;
    }
    this.openOperations.delete(op);
    try {
      const durationMs = Math.max(0, this.deps.monotonicNow() - opened.started);
      const data = encoder.end(...values, durationMs);
      this.#enqueue("boundary", stageName, data, { op, session: opened.session });
    } catch {
      this.reject("schema_rejected");
    }
  }

  #enqueue(kind, stageName, data, relation = {}) {
    if (this.closed) return false;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return false;
    }
    if (this.pendingCount() >= this.capacity) {
      this.reject("queue_full");
      return false;
    }
    const candidate = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      ts: new Date(this.deps.wallNow()).toISOString(),
      run: this.run,
      seq: this.seq + 1,
      session: Object.prototype.hasOwnProperty.call(relation, "session") ? relation.session : this.session,
      kind,
      stage: stageName,
      ...(relation.op ? { op: relation.op } : {}),
      data,
    };
    const checked = validateObservationRecord(candidate);
    if (!checked.ok) {
      this.reject("schema_rejected");
      return false;
    }
    let bytes;
    try {
      bytes = Buffer.concat([canonicalJsonBytes(candidate), Buffer.from("\n")]);
    } catch {
      this.reject("serialization_failed");
      return false;
    }
    this.seq++;
    this.accepted++;
    this.queue.push(bytes);
    this.pump();
    return true;
  }

  bindSession(piSessionId) {
    if (this.state !== "ready" || this.closed) return;
    if (piSessionId === null || piSessionId === undefined || piSessionId === "") {
      this.session = null;
      return;
    }
    try {
      this.session = this.deps.sessionHash(String(piSessionId));
    } catch {
      this.reject("session_hash_failed");
    }
  }

  createProducer() {
    if (this.closed) return DISABLED_OBSERVATION;
    const producer = new ObservationProducer(this);
    this.producers.add(producer);
    return producer;
  }

  releaseProducer(producer, deadline) {
    if (!this.producers.delete(producer) || this.producers.size > 0) return Promise.resolve();
    return this.finishRemaining(deadline);
  }

  unregisterProducer(producer) {
    this.producers.delete(producer);
  }

  abandon() {
    if (this.state === "ready" && !this.closed) this.markIncomplete("producer_deadline");
  }

  getStatus() {
    return Object.freeze({
      state: this.state,
      reason: this.reason,
      run: this.run,
      accepted: this.accepted,
      dropped: this.dropped,
    });
  }

  #flush() {
    if (!this.writing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  beginDrainDeadline(timeoutMs) {
    if (this.state !== "ready" || this.closed) return 0;
    return this.deps.monotonicNow() + Math.max(0, safeInteger(timeoutMs));
  }

  finishRemaining(deadline) {
    const absoluteDeadline = Number.isFinite(deadline) && deadline > 0
      ? deadline
      : this.deps.monotonicNow();
    return this.finish({ deadline: absoluteDeadline });
  }

  finish(budget) {
    if (this.finishPromise) return this.finishPromise;
    if (this.beforeExit) {
      process.removeListener("beforeExit", this.beforeExit);
      this.beforeExit = null;
    }
    this.finishPromise = this.finishNow(budget);
    return this.finishPromise;
  }

  async finishNow(budget) {
    const deadline = Number.isFinite(budget?.deadline)
      ? budget.deadline
      : Number.isFinite(budget) && budget >= 0
        ? this.deps.monotonicNow() + budget
        : null;
    if (this.state === "ready" && this.openOperations.size > 0) {
      this.markIncomplete("operation_unfinished");
    } else if (this.state === "ready" && !this.closed) {
      this.#enqueue("state", "observe_run_end", ENCODERS.observe_run_end(this.accepted, this.dropped));
    }
    const flushed = await this.#waitUntil(this.#flush(), deadline);
    if (!flushed || this.writing || this.queue.length > 0) this.markIncomplete("flush_timeout", false);
    const closed = await this.#waitUntil(this.#closeSink(), deadline);
    if (!closed) this.markIncomplete("close_timeout", false);
  }

  async #waitUntil(promise, deadline) {
    if (deadline === null) {
      await promise;
      return true;
    }
    const remaining = Math.max(0, deadline - this.deps.monotonicNow());
    if (remaining === 0) return false;
    let timer;
    const completed = await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  pendingCount() {
    return this.queue.length + (this.writing ? 1 : 0);
  }

  pump() {
    if (this.writing || !this.sinkWritable || this.queue.length === 0) {
      this.resolveWaitersIfIdle();
      return;
    }
    const bytes = this.queue.shift();
    this.writing = true;
    this.deps.write(this.fd, bytes, (error, written) => {
      this.writing = false;
      if (error) {
        this.markIncomplete("write_failed", false);
        return;
      }
      if (written !== bytes.length) {
        this.markIncomplete("partial_write", false);
        return;
      }
      this.pump();
    });
  }

  reject(reason) {
    this.dropped++;
    this.markIncomplete(reason);
  }

  markIncomplete(reason, sinkUsable = true) {
    if (this.state !== "incomplete") {
      this.state = "incomplete";
      this.reason = reason;
    }
    if (!sinkUsable) {
      this.sinkWritable = false;
      this.queue.length = 0;
    } else {
      this.pump();
    }
    this.resolveWaitersIfIdle();
  }

  resolveWaitersIfIdle() {
    if (this.writing || this.queue.length > 0) return;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #closeSink() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      try {
        this.deps.close(this.fd, (error) => {
          if (error) this.markIncomplete("close_failed");
          resolve();
        });
      } catch {
        this.markIncomplete("close_failed");
        resolve();
      }
    });
  }
}

class ObservationProducer {
  constructor(runtime) {
    this.runtime = runtime;
    this.session = null;
    this.released = false;
  }

  emit(stageName, ...values) {
    if (!this.released) this.runtime.emitFor(this.session, stageName, ...values);
  }

  begin(stageName, ...values) {
    return this.released ? 0 : this.runtime.beginFor(this.session, stageName, ...values);
  }

  end(stageName, op, ...values) {
    if (!this.released) this.runtime.end(stageName, op, ...values);
  }

  bindSession(piSessionId) {
    if (this.released) return;
    if (piSessionId === null || piSessionId === undefined || piSessionId === "") {
      this.session = null;
      return;
    }
    try {
      this.session = this.runtime.deps.sessionHash(String(piSessionId));
    } catch {
      this.runtime.reject("session_hash_failed");
    }
  }

  createProducer() {
    return this.runtime.createProducer();
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.runtime.unregisterProducer(this);
  }

  abandon() {
    if (!this.released) this.runtime.abandon();
  }

  getStatus() {
    return this.runtime.getStatus();
  }

  beginDrainDeadline(timeoutMs) {
    return this.runtime.beginDrainDeadline(timeoutMs);
  }

  finishRemaining(deadline) {
    if (this.released) return Promise.resolve();
    this.released = true;
    return this.runtime.releaseProducer(this, deadline);
  }

  finish(timeoutMs) {
    if (this.released) return Promise.resolve();
    const deadline = Number.isFinite(timeoutMs)
      ? this.runtime.deps.monotonicNow() + Math.max(0, safeInteger(timeoutMs))
      : undefined;
    return this.finishRemaining(deadline);
  }
}

export function validateObservationRecord(record) {
  try {
    if (!plainObject(record)) return invalid("record_type");
    const top = new Set(["schemaVersion", "ts", "run", "seq", "session", "kind", "stage", "op", "data"]);
    if (Object.keys(record).some((key) => !top.has(key))) return invalid("unknown_top_field");
    if (record.schemaVersion !== OBSERVATION_SCHEMA_VERSION) return invalid("schema_version");
    if (typeof record.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.ts)) return invalid("timestamp");
    if (typeof record.run !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.run)) return invalid("run");
    if (!Number.isSafeInteger(record.seq) || record.seq < 1) return invalid("seq");
    if (record.session !== null && (typeof record.session !== "string" || !/^[0-9a-f]{64}$/.test(record.session))) return invalid("session");
    const descriptor = OBSERVATION_STAGE_REGISTRY[record.stage];
    if (!descriptor || record.kind !== descriptor.kind) return invalid("stage_kind");
    if (record.kind === "boundary") {
      if (!Number.isSafeInteger(record.op) || record.op < 1) return invalid("op");
    } else if (record.op !== undefined && (!Number.isSafeInteger(record.op) || record.op < 1)) {
      return invalid("op");
    }
    const selected = selectSchema(descriptor.data, record.data);
    if (!selected) return invalid("data_variant");
    return validateData(selected, record.data);
  } catch {
    return invalid("validation_error");
  }
}

function validateData(definition, data) {
  if (!plainObject(data)) return invalid("data_type");
  const required = definition.required || {};
  const optional = definition.optional || {};
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return invalid("unknown_data_field");
  }
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(data, key) || !validValue(data[key], rule)) return invalid("required_data_field");
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.prototype.hasOwnProperty.call(data, key) && !validValue(data[key], rule)) return invalid("optional_data_field");
  }
  return { ok: true, reason: null };
}

function validValue(value, rule) {
  if (value === null) return rule.nullable === true;
  if (rule.type === "boolean") return typeof value === "boolean";
  if (rule.type === "integer") return Number.isSafeInteger(value) && value >= rule.min && value <= rule.max;
  if (rule.type === "number") return typeof value === "number" && Number.isFinite(value) && value >= rule.min;
  if (rule.type !== "string" || typeof value !== "string") return false;
  if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  return !rule.pattern || new RegExp(rule.pattern).test(value);
}

function selectSchema(definition, data) {
  if (!definition.variantField) return definition;
  if (!plainObject(data)) return null;
  return definition.variants[data[definition.variantField]] || null;
}

function dependencies(overrides = {}) {
  return {
    open: overrides.open ?? openSync,
    fstat: overrides.fstat ?? fstatSync,
    probeWritable: overrides.probeWritable ?? ((fd) => { writeSync(fd, Buffer.alloc(0)); }),
    write: overrides.write ?? ((fd, bytes, callback) => writeFd(fd, bytes, 0, bytes.length, null, callback)),
    close: overrides.close ?? closeFd,
    closeSync: overrides.closeSync,
    uuid: overrides.uuid ?? randomUUID,
    wallNow: overrides.wallNow ?? Date.now,
    monotonicNow: overrides.monotonicNow ?? (() => Number(process.hrtime.bigint()) / 1_000_000),
    uid: overrides.uid ?? (() => typeof process.getuid === "function" ? process.getuid() : null),
    sessionHash: overrides.sessionHash ?? observationSessionHash,
  };
}

export function observationSessionHash(piSessionId) {
  return createHash("sha256")
    .update(canonicalJsonBytes([OBSERVATION_SESSION_DOMAIN, OBSERVATION_IDENTITY_VERSION, String(piSessionId)]))
    .digest("hex");
}

function namespaceHash(value) {
  if (!value) return null;
  return createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/observation-namespace", OBSERVATION_IDENTITY_VERSION, String(value)]))
    .digest("hex");
}

function ackHash(value) {
  const leaves = Array.isArray(value?.acknowledgedLeaves) ? value.acknowledgedLeaves : [];
  return createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/observation-ack", OBSERVATION_IDENTITY_VERSION, leaves]))
    .digest("hex");
}

function leafCount(value) {
  return Array.isArray(value?.acknowledgedLeaves) ? value.acknowledgedLeaves.length : 0;
}

/** `archiveId` 的 digest 已经是协议自身的域分隔 hash，可原样记录。 */
function archiveDigest(value) {
  return /^arc_[0-9a-f]{64}$/.test(String(value ?? "")) ? String(value).slice(4) : null;
}

function checkpointDigest(value) {
  return /^chk_[0-9a-f]{64}$/.test(String(value ?? "")) ? String(value).slice(4) : null;
}

function eventDigest(value) {
  return /^evt_[0-9a-f]{64}$/.test(String(value ?? "")) ? String(value).slice(4) : null;
}

/** 未知或不可用的计量记录为 null，而不是伪造成 0。 */
function nullableInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function failureData(error, errorCode, disposition, branch) {
  const status = Number(error?.status || 0);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return {
    errorClass: classifyError(error, status),
    errorCode,
    disposition,
    branch,
    messageBytes: Buffer.byteLength(message),
    ...(Number.isInteger(status) && status > 0 && status <= 599 ? { status } : {}),
  };
}

function classifyError(error, status) {
  const name = String(error?.name || "").toLowerCase();
  const code = String(error?.code || "").toUpperCase();
  if (name.includes("abort") || code === "ABORT_ERR" || code === "UND_ERR_ABORTED") return "aborted";
  if (name.includes("timeout") || TIMEOUT_ERROR_CODES.has(code)) return "timeout";
  // 服务端用同一个 409 表达路径占用和字节冲突；只有前者可重试，因此先于完整性判定。
  if (name.includes("busy")) return "http";
  if (name.includes("conflict") || name.includes("integrity") || status === 409) return "integrity";
  if (status >= 400) return "http";
  if (name.includes("contentwrite")) return "protocol";
  if (name.includes("syntax") || name.includes("type")) return "source";
  if (FILESYSTEM_ERROR_CODES.has(code)) return "filesystem";
  if (error) return "transport";
  return "other";
}

function routeTemplate(path) {
  const raw = String(path || "");
  const pathname = raw.split("?", 1)[0] || "";
  const sessionPrefix = `${OPENVIKING_API_PREFIX}/sessions/`;
  if (pathname.startsWith(sessionPrefix)) {
    const parts = pathname.slice(sessionPrefix.length).split("/");
    if (parts.length === 1 && parts[0]) return openVikingApiPath("/sessions/{id}");
    if (parts.length === 2 && parts[0] && parts[1] === "messages") {
      return openVikingApiPath("/sessions/{id}/messages");
    }
    if (parts.length === 2 && parts[0] && parts[1] === "commit") {
      return openVikingApiPath("/sessions/{id}/commit");
    }
    if (parts.length === 2 && parts[0] && parts[1] === "context") {
      return openVikingApiPath("/sessions/{id}/context");
    }
  }
  const taskPrefix = `${OPENVIKING_API_PREFIX}/tasks/`;
  if (pathname.startsWith(taskPrefix)) {
    const parts = pathname.slice(taskPrefix.length).split("/");
    if (parts.length === 1 && parts[0]) return openVikingApiPath("/tasks/{id}");
  }
  return HTTP_ROUTES.includes(pathname) ? pathname : "other";
}

function normalizeMethod(value) {
  const method = String(value || "GET").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method) ? method : "GET";
}

function normalizeHookReason(value) {
  const reason = String(value || "none");
  return HOOK_REASONS.includes(reason) ? reason : "none";
}

function normalizeTool(value) {
  const tool = String(value || "").trim().toLowerCase();
  return TOOLS.includes(tool) ? tool : "other";
}

function validTraceId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function safeInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function safeLength(value) {
  return typeof value === "string" || Array.isArray(value) ? value.length : 0;
}

function validPrivateFile(stat, uid) {
  return Boolean(stat?.isFile?.()) && stat.size === 0 && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);
}

function safeCloseSync(fd, deps) {
  try {
    if (typeof deps.closeSync === "function") deps.closeSync(fd);
    else closeFd(fd, () => {});
  } catch { /* observation setup failure is diagnostic-only */ }
}

function invalid(reason) {
  return { ok: false, reason };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PROCESS_OBSERVATION = Symbol.for("pi-openviking.observation.v1");
export const observation = globalThis[PROCESS_OBSERVATION] ||= createObservation();
