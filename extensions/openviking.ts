// Copyright 2026 omp-ov-memory contributors. SPDX-License-Identifier: Apache-2.0
import { loadConfig, type OVConfig } from "../src/config.ts";
import { OVClient } from "../src/client.ts";
import { SyncManager } from "../src/sync.ts";
import { MemoryRuntime } from "../src/runtime.ts";
import { createTools, type ToolDefinition } from "../src/tools.ts";
import { resolveWorkspace, isBypassed } from "../src/workspace.ts";
import { within } from "../src/deadline.ts";
import { preservesRecentTurns, compactionKeepsRecentTurns } from "../src/takeover.ts";
import { findVikingUri } from "../src/shared/uri-guard.mjs";
import { readTaskModelContext } from "../src/shared/task-model-context.mjs";
import { snapshotSessionSource } from "../src/shared/pi-session-source.mjs";
import { renderCompactionPointer } from "../src/shared/active-context.mjs";

/** Structural public Extension API shared by OMP and Pi, without runtime coupling. */
export interface MemoryExtensionAPI {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, command: {description: string; handler: (args: string, ctx: any) => Promise<void>}): void;
  getActiveTools?(): string[];
  getAllTools?(): any[];
}

export interface ExtensionOptions {
  config?: OVConfig;
  dependencies?: { Client: typeof OVClient; Sync: typeof SyncManager };
}

export default function openviking(pi: MemoryExtensionAPI, options: ExtensionOptions = {}): void {
  let config: OVConfig;
  try { config = options.config ?? loadConfig(); }
  catch {
    pi.registerCommand("ov", {description: "OpenViking configuration diagnostics", handler: async (_args, ctx) => {
      ctx.ui?.notify?.("OpenViking disabled: invalid configuration. Check ~/.openviking/omp-ov-memory.jsonc and credential settings.", "warning");
    }});
    return;
  }
  if (!config.enabled) return;
  let current: MemoryRuntime | null = null;
  let currentKey = "";
  let unavailable = "OpenViking session is not initialized.";
  const toolsFor = new WeakMap<MemoryRuntime, ToolDefinition[]>();

  const ensure = (ctx: any): MemoryRuntime | null => {
    try {
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const cwd = ctx?.cwd ?? process.cwd();
      if (typeof sessionId !== "string" || !sessionId) return null;
      const key = `${cwd}\0${sessionId}`;
      if (key === currentKey && current && !current.closed) return current;
      if (current) { const previous = current; current = null; void previous.shutdown().catch(() => {}); }
      currentKey = key;
      if (isBypassed(cwd, config.bypassPatterns)) { unavailable = "OpenViking is bypassed for this workspace."; return null; }
      const route = resolveWorkspace(cwd, config);
      current = new MemoryRuntime(config, route, sessionId, ctx, options.dependencies);
      return current;
    } catch {
      unavailable = "OpenViking disabled for this session: workspace routing or configuration is invalid.";
      return null;
    }
  };

  const definitions = (runtime: MemoryRuntime): ToolDefinition[] => {
    let tools = toolsFor.get(runtime);
    if (!tools) { tools = createTools(runtime.client, runtime.sync, runtime.observation); toolsFor.set(runtime, tools); }
    return tools;
  };
  // Register immediately, including offline starts. Tools resolve the active session at execution.
  const metadataClient = new OVClient(config);
  for (const tool of createTools(metadataClient, null)) {
    pi.registerTool({ ...tool, async execute(id, args, signal, onUpdate, ctx) {
      const runtime = ctx ? ensure(ctx) : current;
      if (!runtime) return {isError: true, content: [{type: "text", text: unavailable}]};
      await within(runtime.ready, 1900, undefined);
      if (runtime.closed || runtime !== current) return {isError: true, content: [{type: "text", text: "Session changed; retry in the active session."}]};
      return definitions(runtime).find(candidate => candidate.name === tool.name)!.execute(id, args, signal, onUpdate, ctx);
    }});
  }

  const taskModel = (ctx: any) => readTaskModelContext({
    getActiveTools: () => pi.getActiveTools?.() ?? [],
    getAllTools: () => pi.getAllTools?.() ?? [],
  }, ctx);
  const guarded = (event: string, handler: (event: any, ctx: any, runtime: MemoryRuntime) => any) => {
    pi.on(event, (payload, ctx) => {
      const runtime = ensure(ctx);
      if (!runtime) return;
      try {
        const result = handler(payload, ctx, runtime);
        if (result && typeof result.then === "function") return result.catch(() => { runtime.lastFailure = `${event}_degraded`; });
        return result;
      } catch { runtime.lastFailure = `${event}_degraded`; return; }
    });
  };

  guarded("session_start", (_event, ctx, runtime) => {
    runtime.postHook("session-start", {event: "session-start"});
    runtime.scheduleSync(ctx, taskModel(ctx), true);
    // All startup I/O continues in the background; OMP stays interactive.
  });

  guarded("before_agent_start", (event, _ctx, runtime) => {
    runtime.recall.queueSearch(String(event.prompt ?? ""));
    runtime.postHook("user-prompt", {prompt: String(event.prompt ?? "")});
    if (runtime.handoffBlock) {
      const content = runtime.handoffBlock; runtime.handoffBlock = "";
      return { message: {customType: "ai-memory-handoff", content, display: false} };
    }
  });

  guarded("context", async (event, ctx, runtime) => {
    const deadline = Date.now() + 1950;
    // Only use readiness already available or a small bounded part of the hook budget.
    await within(runtime.ready, Math.min(150, config.requestTimeoutMs), undefined);
    let messages = Array.isArray(event.messages) ? event.messages : [];
    await runtime.recall.searchPending(messages, Math.max(0, deadline - Date.now()));
    if (runtime !== current || runtime.closed) return;
    if (config.takeover.enabled && runtime.sync.status.activeContext.eligibility === "eligible") {
      const usage = ctx.getContextUsage?.()?.tokens;
      if (Number.isFinite(usage) && usage >= config.takeover.tokenThreshold) {
        const replacement = await within(runtime.sync.takeoverMessages(snapshotSessionSource(ctx.sessionManager), taskModel(ctx)), Math.max(0, deadline - Date.now()), null);
        if (replacement && preservesRecentTurns(messages, replacement, config.takeover.keepRecentTurns)) messages = replacement;
      }
    }
    messages = runtime.recall.injectRecall(messages).messages;
    if (runtime.rehydration) {
      messages = [...messages, {role: "custom", customType: "openviking-rehydration", content: runtime.rehydration, display: false, timestamp: 0}];
      runtime.rehydration = "";
    }
    // A late handoff is emitted by the next before_agent_start, where the harness persists it.
    return {messages};
  });

  guarded("tool_call", (event, _ctx, runtime) => {
    runtime.postHook("tool-call", event);
    const name = String(event.toolName ?? "").toLowerCase();
    if (!["read", "bash", "glob", "grep", "find", "ls"].includes(name)) return;
    const uri = findVikingUri(event.input ?? event.args ?? {});
    if (!uri) return;
    const tool = ["grep", "glob", "find"].includes(name) ? "viking_search" : "viking_read";
    // The Extension API cannot change the tool name; block local execution and route the model.
    return {block: true, reason: `This is an OpenViking virtual URI. Use ${tool} for ${uri}; do not pass viking:// to local filesystem or shell tools.`};
  });
  guarded("tool_result", (event, _ctx, runtime) => { runtime.postHook("tool-result", event); });
  for (const event of ["turn_end", "agent_end", "session_tree", "session_info_changed", "model_select", "thinking_level_select"]) {
    guarded(event, (_payload, ctx, runtime) => {
      runtime.scheduleSync(ctx, taskModel(ctx), event === "agent_end");
      if (event === "agent_end") {
        runtime.postHook("stop", {event: "stop"});
        runtime.maybeCommit(ctx);
        void within(runtime.saveHandoff(ctx), 1900, false);
        runtime.recall.invalidate();
      }
    });
  }
  guarded("session_before_compact", async (event, ctx, runtime) => {
    runtime.postHook("pre-compact", {event: "pre-compact"});
    runtime.scheduleSync(ctx, taskModel(ctx), true);
    if (config.takeover.enabled) {
      const compaction = await within(runtime.sync.activeContextCompaction(snapshotSessionSource(ctx.sessionManager), Number(event.preparation?.tokensBefore) || 0), 1800, null);
      if (compaction && compactionKeepsRecentTurns(ctx.sessionManager.getBranch?.() ?? [], compaction.firstKeptEntryId, config.takeover.keepRecentTurns)) return {compaction};
    }
    // Commit is advisory. Native OMP compaction remains the safe fallback.
    void runtime.commit().catch(() => {});
    runtime.rehydration = renderCompactionPointer(runtime.sync.listArchives());
  });
  guarded("session_compact", (_event, ctx, runtime) => {
    runtime.scheduleSync(ctx, taskModel(ctx), true);
    runtime.rehydration = renderCompactionPointer(runtime.sync.listArchives());
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const runtime = current;
    if (!runtime) return;
    current = null; currentKey = "";
    await runtime.shutdown(ctx);
  });

  const command = { description: "OpenViking: status, health, sync, commit, flush or handoff", handler: async (args: string, ctx: any) => {
    const runtime = ensure(ctx);
    if (!runtime) { ctx.ui?.notify?.(unavailable, "warning"); return; }
    const action = args.trim() || "status";
    let message: string;
    if (["commit", "flush"].includes(action)) {
      runtime.scheduleSync(ctx, taskModel(ctx), true);
      const committed = await within(runtime.commit(), 1900, false);
      message = committed ? "OpenViking commit accepted." : "OpenViking commit not confirmed; pending capture is retained. Check status before retrying.";
    } else if (action === "sync") {
      runtime.scheduleSync(ctx, taskModel(ctx), true);
      const drained = await runtime.queue.drain(1900);
      message = drained ? "OpenViking pending queue drained." : "OpenViking sync pending; durable records will replay.";
    } else if (action === "handoff") {
      message = await within(runtime.saveHandoff(ctx), 1900, false) ? "Workspace handoff saved." : "Workspace handoff not confirmed.";
    } else if (["status", "health"].includes(action)) {
      await runtime.client.health();
      message = JSON.stringify({healthy: runtime.client.connected, sessionId: runtime.sync.sessionId, workspace: runtime.route.workspace, project: runtime.route.project,
        pending: runtime.queue.status, sync: runtime.sync.status, nativeMirror: runtime.mirror?.status ?? null, failure: runtime.lastFailure}, null, 2);
    } else message = "Usage: /ov [status|health|sync|commit|flush|handoff]";
    runtime.renderStatus();
    ctx.ui?.notify?.(message, runtime.client.connected ? "info" : "warning");
  }};
  pi.registerCommand("ov", command);
  pi.registerCommand("viking", command);
}
