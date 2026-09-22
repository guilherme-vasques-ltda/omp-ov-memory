import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { createHash, randomUUID } from "node:crypto";
import { canonicalVikingUri as parseVikingUri, insideVikingRoot, isManagedVikingUri, downloadPublicText } from "./security.ts";
const StringEnum = (values: readonly string[], options = {}) => Type.Union(values.map(value => Type.Literal(value)), options);
import type { OVClient } from "./client.ts";
import type { SyncManager } from "./sync.ts";
import { observation, type Observation } from "./shared/observe.mjs";
import { eventTokenWeight } from "./shared/context-weight.mjs";
import { recordedEventBytes } from "./shared/recorded-event.mjs";
import { ensureDirectoryChain } from "./shared/content-objects.mjs";

/** 已注册的工具名，供系统提示引用；集合的事实源在本模块。 */
export const VIKING_TOOL_NAMES = [
  "viking_search",
  "viking_read",
  "viking_browse",
  "viking_remember",
  "viking_forget",
  "viking_add_resource",
  "viking_archive_expand",
  "viking_tree",
  "viking_write",
  "viking_edit",
  "viking_health",
] as const;

function boundedIndexField(value: unknown, maxChars = 80): string {
  const flat = String(value ?? "unknown").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 事件索引行的种类标签：entry 类型加上消息角色或工具名。 */
function describeEventKind(event: any): string {
  const entry = event?.payload?.entry ?? {};
  const kind = event?.source?.entryType ?? entry.type ?? "unknown";
  const detail = entry.message?.role ?? entry.message?.toolName ?? entry.customType;
  return boundedIndexField(detail ? `${kind}/${detail}` : kind);
}

/** 单行摘要：取 part 文本的前 100 字符；非文本部分只描述形状。 */
function eventExcerpt(event: any): string {
  const value = event?.payload?.part?.value;
  const text = typeof value === "string" ? value
    : typeof value?.text === "string" ? value.text
      : typeof value?.thinking === "string" ? value.thinking
        : null;
  if (text === null) return `(${boundedIndexField(event?.payload?.part?.form ?? "no")} part, no text)`;
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > 100 ? `${flat.slice(0, 100)}…` : flat);
}
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  prepareArguments?: (args: unknown) => unknown;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
  [key: string]: any;
}

export function createTools(client: OVClient, sync: SyncManager | null, observe: Observation = observation): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  registerTools({ registerTool: (tool: ToolDefinition) => tools.push(tool) }, client, sync, observe);
  return tools;
}

const failure = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
const success = (text: string, details?: any) => ({ content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) });

/** Only omitted fields get defaults; invalid values and unknown keys remain for validation. */
function withArgumentDefaults(args: unknown, defaults: Record<string, unknown>): unknown {
  if (args === undefined) args = {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const prepared: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(defaults)) {
    if (prepared[key] === undefined) prepared[key] = value;
  }
  return prepared;
}

function prepareBrowseArguments(args: unknown): unknown {
  if (typeof args === "string") args = args.startsWith("viking://") ? { uri: args } : { action: args };
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const prepared: Record<string, unknown> = { ...args };
    // Recover positional object fields without hiding conflicting named values.
    for (const [position, field] of [["0", "action"], ["1", "uri"]] as const) {
      if (Object.hasOwn(prepared, position) && !Object.hasOwn(prepared, field)) {
        prepared[field] = prepared[position];
        delete prepared[position];
      }
    }
    args = prepared;
  }
  return withArgumentDefaults(args, { action: "list", uri: "viking://" });
}

export function registerTools(api: any, client: OVClient, sync: SyncManager | null, observe: Observation = observation): void {
  const pi = { registerTool(tool: ToolDefinition) {
    const mutates = ["viking_remember", "viking_forget", "viking_add_resource", "viking_write", "viking_edit"].includes(tool.name);
    tool.approval = mutates ? "write" : "read";
    tool.annotations = { readOnlyHint: !mutates, destructiveHint: ["viking_forget", "viking_write", "viking_edit"].includes(tool.name), idempotentHint: !mutates, openWorldHint: true };
    const execute = tool.execute;
    (tool.parameters as any).additionalProperties = false;
    api.registerTool({ ...tool, async execute(id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
      // OMP validates the schema before execute and has no prepareArguments hook.
      // Positional/bare-string recovery is for direct/MCP callers at this boundary.
      if (tool.prepareArguments) params = tool.prepareArguments(params);
      if (!Value.Check(tool.parameters, params)) return failure("Invalid tool arguments; follow the tool's input schema.");
      if (signal?.aborted) return failure("Tool call cancelled.");
      if (client.cfg.sessionScopedMemory && tool.name !== "viking_health" && !parseVikingUri(client.userRoot)) return failure("Session memory namespace has not been bound yet.");
      try { return await execute(id, params, signal, onUpdate, ctx); }
      catch { return failure("OpenViking operation failed; inspect connection health and retry only after checking mutation state."); }
    } });
  } };
  const editLocks = new Map<string, Promise<unknown>>();
  // Session-scoped memory confines the model to its own namespace. The server
  // applies the user header to memory-semantic calls only, so every tool that
  // takes or returns a viking:// URI is clamped here as well.
  const scoped = (): string =>
    client.cfg.sessionScopedMemory ? client.userRoot : "";

  const unavailable = (tool: string): boolean => {
    observe.emit("tool_availability", tool, client.connected);
    return !client.connected;
  };

  const readTree = async (uri: string, depth = 3, limit = 100) => {
    const result = await client.tree(uri, { depth, nodeLimit: limit });
    return result.ok ? success(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2)) : failure("Could not read directory tree.");
  };

  const canonicalVikingUri = (input: unknown): string | null => parseVikingUri(input, client.userRoot);
  const insideCanonical = insideVikingRoot;

  const authorizeUri = (
    input: unknown, tool: string, operation: "read" | "browse", root = scoped(),
  ): { uri: string | null; error: string | null } => {
    const raw = String(input ?? "");
    const uri = canonicalVikingUri(raw);
    const allowed = uri !== null && insideCanonical(uri, root);
    observe.emit("tool_scope", tool, operation, Boolean(root), allowed ? "allow" : "deny", allowed ? 1 : 0, allowed ? 0 : 1);
    if (allowed) return { uri, error: null };
    return {
      uri: null,
      error: uri === null
        ? `Refused: ${raw} is not a valid viking URI.`
        : `Refused: ${raw} is outside this session's memory namespace (${root}).`,
    };
  };

  /** Mutations are additionally forbidden for adapter-owned immutable facts. */
  const authorizeMutation = (input: unknown, tool: string, operation: "delete" | "write", root = scoped()): { uri: string | null; error: string | null } => {
    const raw = String(input ?? "");
    const uri = canonicalVikingUri(raw);
    const internal = Boolean(uri && (isManagedVikingUri(uri) || uri === root || uri === "viking://"));
    const allowed = uri !== null && insideCanonical(uri, root) && !internal;
    observe.emit("tool_scope", tool, operation, Boolean(root), allowed ? "allow" : "deny", allowed ? 1 : 0, allowed ? 0 : 1);
    if (allowed) return { uri, error: null };
    if (!uri) return { uri: null, error: `Refused: ${raw} is not a valid viking URI.` };
    return {
      uri: null,
      error: internal
        ? `Refused: ${raw} is managed by the memory engine and cannot be modified through memory tools.`
        : `Refused: ${raw} is outside this session's memory namespace (${root}).`,
    };
  };

  /** Search scope: invalid input is rejected; only a valid out-of-scope URI is clamped. */
  const resolveSearchScope = (
    tool: string, requested?: string, root = scoped(),
  ): { targetUri: string | undefined; error: string | null } => {
    const raw = String(requested ?? "").trim();
    if (!raw) {
      observe.emit("tool_scope", tool, "search_request", Boolean(root), "allow", 1, 0);
      return { targetUri: root || undefined, error: null };
    }
    const uri = canonicalVikingUri(raw);
    if (!uri) {
      observe.emit("tool_scope", tool, "search_request", Boolean(root), "deny", 0, 1);
      return { targetUri: undefined, error: `Refused: ${raw} is not a valid viking URI.` };
    }
    const allowed = insideCanonical(uri, root);
    const branch = allowed ? "allow" : "clamp";
    observe.emit("tool_scope", tool, "search_request", Boolean(root), branch, 1, 0);
    return { targetUri: allowed ? uri : root, error: null };
  };

  // --- viking_search ---
  pi.registerTool({
    name: "viking_search",
    label: "Viking Search",
    description: "Semantic search over the OpenViking knowledge base. Returns ranked results with viking:// URIs and abstracts. Use to recall past decisions, user preferences, project-specific knowledge, or earlier parts of THIS session that were compacted or replaced out of current context.",
    promptSnippet: "Search OpenViking for past decisions, preferences, project knowledge, and compacted earlier context of this session",
    promptGuidelines: [
      "Use viking_search when you need information from previous sessions not in MEMORY.md.",
      "Use viking_search when current work references earlier session context you can no longer see (compacted or checkpoint-replaced); follow hits up with viking_read or viking_archive_expand.",
      "Use viking_search before making decisions that might conflict with past decisions.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 16000, description: "Search query" }),
      scope: Type.Optional(Type.String({ description: "Viking URI prefix to scope search (e.g., 'viking://user/memories/')" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default: 10)" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_search")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      // 请求范围与回读核验都做：范围表达意图，核验保证返回给模型的 URI 确实
      // 落在绑定命名空间内，不依赖服务端对 target_uri 的执行。
      const root = scoped();
      const searchScope = resolveSearchScope("viking_search", params.scope, root);
      if (searchScope.error) return failure(searchScope.error);
      const found = await client.find(params.query, {
        targetUri: searchScope.targetUri,
        topK: params.limit ?? 10,
      });
      const results = found.flatMap((result) => {
        const uri = canonicalVikingUri(result.uri);
        return uri && insideCanonical(uri, root) ? [{ ...result, uri }] : [];
      });
      observe.emit(
        "tool_scope",
        "viking_search",
        "search_result",
        Boolean(root),
        results.length === found.length ? "allow" : "filter",
        results.length,
        found.length - results.length,
      );
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const maxChars = client.cfg.recallMaxContentChars;
      const lines = results.map(r => {
        const abs = r.abstract.length > maxChars
          ? r.abstract.slice(0, maxChars) + "..."
          : r.abstract;
        return `[${r.score.toFixed(2)}] ${r.uri}\n  ${abs}`; }
      );
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { results },
      };
    },
  });

  // --- viking_read ---
  pi.registerTool({
    name: "viking_read",
    label: "Viking Read",
    description: "Read content at a viking:// URI. Three detail levels: 'abstract' (~100 tokens, default), 'overview' (~2k tokens), 'full' (complete). Start with abstract, escalate when needed.",
    promptSnippet: 'Read OpenViking content with {"uri":"viking://...","level":"abstract"}',
    promptGuidelines: [
      'Use viking_read with {"uri":"viking://...","level":"abstract"}; uri is required and level may be "abstract", "overview", or "full".',
      'Omit level to read the abstract first, then request overview or full if needed.',
    ],
    prepareArguments: args => withArgumentDefaults(typeof args === "string" ? { uri: args } : args, { level: "abstract" }),
    parameters: Type.Object({
      uri: Type.String({ description: "viking:// URI to read" }),
      level: Type.Optional(StringEnum(["abstract", "overview", "full"], { default: "abstract", description: "Detail level (default: abstract)" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_read")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      const root = scoped();
      const read = authorizeUri(params.uri, "viking_read", "read", root);
      if (read.error) return failure(read.error);
      const uri = read.uri!;
      let content: string | null = null;
      switch (params.level) {
        case "abstract": content = await client.abstract(uri); break;
        case "overview": content = await client.overview(uri); break;
        case "full":     content = await client.readContent(uri); break;
      }
      if (content === null) {
        return { content: [{ type: "text", text: `No content at ${uri}` }] };
      }
      return { content: [{ type: "text", text: content }] };
    },
  });

  // --- viking_browse ---
  pi.registerTool({
    name: "viking_browse",
    label: "Viking Browse",
    description: "Browse the OpenViking knowledge store like a filesystem. List directory contents, get metadata, or inspect a bounded tree. Defaults to listing the active root.",
    promptSnippet: 'Browse OpenViking with {"action":"list","uri":"viking://"}',
    promptGuidelines: [
      'Use viking_browse with {"action":"list","uri":"viking://..."}; action must be "list", "stat", or "tree". Omit action for list and uri for the active root.',
      'In session-scoped mode, "viking://" means the active session root.',
      'The tree action uses depth 3 and limit 100; use viking_tree to customize those bounds.',
    ],
    prepareArguments: prepareBrowseArguments,
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["list", "stat", "tree"], { default: "list", description: "Directory operation (default: list); use viking_tree for custom tree depth/limit" })),
      uri: Type.Optional(Type.String({ default: "viking://", description: "viking:// URI; defaults to the active root" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_browse")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      // Browsing defaults to the namespace root so the model cannot enumerate
      // sibling sessions from `viking://`.
      const root = scoped();
      const requested = params.uri === "viking://" ? (root || "viking://") : params.uri;
      const browse = authorizeUri(requested, "viking_browse", "browse", root);
      if (browse.error) return failure(browse.error);
      const uri = browse.uri!;
      if (params.action === "tree") return readTree(uri);
      if (params.action === "stat") {
        const info = await client.stat(uri);
        if (!info) return { content: [{ type: "text", text: `Not found: ${uri}` }] };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      // list
      const entries = await client.ls(uri);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: `Empty directory: ${uri}` }] };
      }
      const lines = entries.map(e => `${e.isDir ? "📁" : "📄"} ${e.name}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // --- viking_remember ---
  pi.registerTool({
    name: "viking_remember",
    label: "Viking Remember",
    description: "Store a fact or memory in OpenViking. Scoped mode saves a create-only content-addressed note inside this session namespace. Unscoped mode stores a session message and requests session-wide extraction without archiving live turns. Use for important information the agent should remember: preferences, decisions, gotchas, lessons learned.",
    promptSnippet: "Store a durable fact in the active OpenViking memory namespace",
    promptGuidelines: [
      "Use viking_remember for facts that should survive context resets and session resumes but don't belong in MEMORY.md.",
      "Good for: user preferences, architectural decisions, gotchas, environment details.",
    ],
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 100000, description: "The fact or observation to store" }),
      category: Type.Optional(Type.String({ pattern: "^[a-z][a-z_-]{0,31}$", description: "Category hint: 'preference', 'entity', 'event', 'case', 'pattern'" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_remember")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      // Store as a tagged message directly in OV — the extractor picks up [Remember — ...] prefix
      const category = params.category ?? "general";
      const tagged = `[Remember — ${category}] ${params.content}`;

      let stored = false;
      const root = scoped();
      if (root) {
        const directory = `${root}/memories/${category}`;
        const uri = `${directory}/${createHash("sha256").update(tagged).digest("hex")}.md`;
        await ensureDirectoryChain(client, client.baseUserRoot || root, directory);
        if (_signal?.aborted) return failure("Tool call cancelled.");
        const result = await client.writeContent(uri, tagged, { mode: "create", wait: false });
        stored = result.ok || (result.status === 409 && await client.readContent(uri) === tagged);
        return { ...success(stored ? `Remembered: ${uri}` : "Memory storage was not confirmed; inspect the note before retrying.", { stored, category, uri, scope: "session" }), isError: !stored };
      }
      // Unscoped extraction intentionally writes the authenticated user's long-term memories.
      if (sync?.sessionId && await client.createSession(sync.sessionId)) {
        if (_signal?.aborted) return failure("Tool call cancelled.");
        const added = await client.addMessage(sync.sessionId, "user", tagged);
        if (_signal?.aborted) return failure("Tool call cancelled; the session message may already have been stored.");
        stored = added && await client.commitRememberedMessage(sync.sessionId);
      }

      return {
        isError: !stored,
        content: [{ type: "text", text: stored ? `Remembered in OpenViking: "${params.content}" (${category})` : `OpenViking could not store: "${params.content}" (${category})` }],
        details: { stored, category, tagged },
      };
    },
  });

  // --- viking_forget ---
  pi.registerTool({
    name: "viking_forget",
    label: "Viking Forget",
    description: "Delete a memory by URI, or search for a specific memory and remove it. Use to correct outdated or wrong information.",
    promptSnippet: "Delete a memory from OpenViking by URI or query",
    parameters: Type.Object({
      uri: Type.Optional(Type.String({ description: "Exact viking:// URI to delete" })),
      query: Type.Optional(Type.String({ description: "Search query — deletes the strongest match if score > 0.8" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_forget")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      if (Boolean(params.uri) === Boolean(params.query)) return failure("Provide exactly one of 'uri' or 'query'.");
      if (params.uri) {
        const root = scoped();
        const deletion = authorizeMutation(params.uri, "viking_forget", "delete", root);
        if (deletion.error) return failure(deletion.error);
        const uri = deletion.uri!;
        const ok = await client.delete(uri);
        return {
          isError: !ok,
          content: [{ type: "text", text: ok ? `Deleted: ${uri}` : `Failed to delete: ${uri}` }],
        };
      }
      if (params.query) {
        // 搜索限定在绑定命名空间内，命中结果在删除前仍逐条复核归属：
        // 删除不可逆，不能只依赖搜索范围。
        const root = scoped();
        const searchScope = resolveSearchScope("viking_forget", undefined, root);
        const results = await client.find(params.query, { targetUri: searchScope.targetUri, topK: 1 });
        if (results.length > 0 && results[0].score > 0.8) {
          const deletion = authorizeMutation(results[0].uri, "viking_forget", "delete", root);
          if (deletion.error) return failure(deletion.error);
          const uri = deletion.uri!;
          if (_signal?.aborted) return failure("Tool call cancelled.");
          const ok = await client.delete(uri);
          return {
            isError: !ok,
            content: [{ type: "text", text: ok ? `Deleted: ${uri}` : `Failed: ${uri}` }],
          };
        }
        return { content: [{ type: "text", text: "No strong match found (score > 0.8 required)." }] };
      }
      return { content: [{ type: "text", text: "Provide either 'uri' or 'query'." }] };
    },
  });

  // --- viking_add_resource ---
  pi.registerTool({
    name: "viking_add_resource",
    label: "Viking Add Resource",
    description: "Ingest a URL into OpenViking. The page is auto-processed into L0/L1/L2 tiers and indexed for semantic search. Public HTTP(S) text only, 2 MiB maximum. Downloads are DNS-pinned; redirects are checked. Uploaded as plain text so embedded URLs cannot be fetched.",
    promptSnippet: "Ingest a URL into OpenViking for indexed retrieval",
    parameters: Type.Object({
      url: Type.String({ maxLength: 8192, description: "Public HTTP(S) text URL to ingest, no file paths" }),
      reason: Type.Optional(Type.String({ maxLength: 4000, description: "Why this resource is relevant (improves indexing)" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_add_resource")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      const root = scoped();
      const downloaded = await downloadPublicText(params.url, { signal: _signal });
      if (_signal?.aborted) return failure("Tool call cancelled.");
      const filename = `resource-${createHash("sha256").update(downloaded.sourceUrl).digest("hex").slice(0, 20)}.txt`;
      const target = `${root || "viking://resources"}${root ? "/resources" : ""}/imported-${randomUUID()}`;
      const source = new URL(downloaded.sourceUrl);
      source.search = ""; source.hash = ""; // Do not persist signed URL query credentials in source metadata.
      const uploaded = await client.uploadResource(downloaded.bytes, filename, { sourceUrl: source.href, reason: params.reason, to: target });
      const result = uploaded.result;
      if (!uploaded.ok || !result) return failure("Resource upload or ingestion failed; check server state before retrying.");
      const uri = canonicalVikingUri(result.root_uri);
      observe.emit("tool_scope", "viking_add_resource", "resource_add", false, uri ? "allow" : "deny", uri ? 1 : 0, uri ? 0 : 1);
      if (!uri || !insideCanonical(uri, root) || uri !== target) return failure("Ingestion did not return the requested target; inspect server state before retrying.");
      return {
        content: [{ type: "text", text: `Ingested: ${uri}` }],
        details: { ...result, root_uri: uri },
      };
    },
  });

  // --- viking_archive_expand ---
  pi.registerTool({
    name: "viking_archive_expand",
    label: "Viking Archive Expand",
    description:
      "List committed archives currently known in this session process, or page through one archive's event index" +
      " (event ids, roles, context weights, short excerpts, and direct-representation read URIs when available)." +
      " Use to recover earlier context of THIS session that was compacted or replaced by a checkpoint; use" +
      " viking_read when the index exposes a read URI. Never dumps full event payloads.",
    promptSnippet: "List this session's archives or inspect one archive's event index to recover compacted earlier context",
    promptGuidelines: [
      "Call viking_archive_expand without archive_id to list committed archives currently known in this session process when earlier context is no longer visible.",
      "Page large archives with offset/limit instead of fetching everything at once.",
    ],
    parameters: Type.Object({
      archive_id: Type.Optional(Type.String({
        description: "Archive ID (arc_<64 hex>) produced by this session; omit to list committed archives currently known in this process",
      })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Event index offset for paging (default 0)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max events per page (default 50)" })),
    }),
    async execute(
      _id: string, params: any, _signal?: AbortSignal,
      _onUpdate?: any, _ctx?: any,
    ) {
      if (unavailable("viking_archive_expand")) {
        return failure("OpenViking server is not reachable; use viking_health to reconnect.");
      }
      if (!sync) return failure("Archive expansion needs an initialized engine session; configure OPENVIKING_SESSION_ID in the MCP fallback.");
      const archiveId = String(params.archive_id ?? "").trim();
      // 无 archive_id 时是发现路径：列出当前进程在本会话已验证的 Archive，模型据此选择要检查的 archive。
      if (!archiveId) {
        observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "allow", 1, 0);
        const archives = sync.listArchives();
        if (archives.length === 0) {
          return { content: [{ type: "text", text: "No committed archives are currently known in this session process." }] };
        }
        const offset = Math.min(archives.length, Math.max(0, Math.floor(Number(params.offset) || 0)));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit) || 50)));
        const page = archives.slice(offset, offset + limit);
        const pageRange = page.length > 0 ? `${offset + 1}-${offset + page.length}` : "none";
        const lines = page.map((descriptor: any, index: number) => {
          const manifest = descriptor.manifest;
          return `- [${offset + index + 1}] ${manifest.archiveId} — ${manifest.eventCount} events,` +
            ` ≈${descriptor.tokenCount} context tokens, ${manifest.firstEventId} → ${manifest.lastEventId}`;
        });
        return {
          content: [{
            type: "text",
            text: `This session process currently knows ${archives.length} committed archive(s); showing ${pageRange}:\n${lines.join("\n")}` +
              "\n\nPage with offset/limit, or call viking_archive_expand with one archive_id for its event index.",
          }],
        };
      }
      // Archive 位置由当前 Pi session 推导，跨会话展开在命名空间层面不可寻址；
      // 这里只需要拒绝形状非法的标识，避免把任意字符串带进 URI 组合。
      if (!/^arc_[0-9a-f]{64}$/.test(archiveId)) {
        observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "deny", 0, 1);
        return failure("Refused: archive_id must match arc_<64 lowercase hexadecimal characters>.");
      }
      observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "allow", 1, 0);
      try {
        const { manifest, events } = await sync.expandArchive(archiveId);
        const offset = Math.min(events.length, Math.max(0, Math.floor(Number(params.offset) || 0)));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit) || 50)));
        const page = events.slice(offset, offset + limit);
        const pageRange = page.length > 0 ? `${offset + 1}-${offset + page.length}` : "none";
        const header = [
          `archive ${manifest.archiveId}`,
          `events ${manifest.eventCount} (${manifest.firstEventId} → ${manifest.lastEventId})`,
          `content ${manifest.contentHash}`,
          `showing ${pageRange} of ${events.length}; page with offset/limit.`,
          "This is an index, not full content: use viking_read when an entry exposes a read URI; oversized chunked entries have no single read URI.",
        ].join("\n");
        const body = page.map((event: any, index: number) => {
          const uri = sync.eventStorageUri(event.eventId, recordedEventBytes(event).length);
          const lines = [
            `[${offset + index + 1}] ${event.eventId} ${event.occurredAt} ${describeEventKind(event)}` +
              ` weight≈${eventTokenWeight(event)} tokens`,
            `    excerpt: ${eventExcerpt(event)}`,
          ];
          if (uri) lines.push(`    read: ${uri}`);
          return lines.join("\n");
        });
        return { content: [{ type: "text", text: `${header}\n\n${body.join("\n")}` }] };
      } catch (error: any) {
        return failure(`Archive not available: ${error?.name || "Error"}`);
      }
    },
  });
  pi.registerTool({
    name: "viking_tree", label: "Viking Tree",
    description: "Inspect the OpenViking directory tree with bounded depth and node count.",
    promptSnippet: 'Inspect an OpenViking tree with {"uri":"viking://","depth":3,"limit":100}',
    promptGuidelines: [
      'Use viking_tree with {"uri":"viking://...","depth":3,"limit":100}; {} uses the active root and these defaults.',
      'Depth must be an integer from 1 to 10 and limit an integer from 1 to 1000. In session-scoped mode, "viking://" means the active session root.',
    ],
    prepareArguments: args => withArgumentDefaults(typeof args === "string" ? { uri: args } : args, { uri: "viking://", depth: 3, limit: 100 }),
    parameters: Type.Object({
      uri: Type.Optional(Type.String({ default: "viking://", description: "viking:// URI; defaults to the active root" })),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3, description: "Maximum directory depth (default: 3)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 100, description: "Maximum tree nodes (default: 100)" })),
    }),
    async execute(_id: string, params: any) {
      if (unavailable("viking_tree")) return failure("OpenViking server is not reachable.");
      const access = authorizeUri(params.uri === "viking://" ? (scoped() || "viking://") : params.uri, "viking_tree", "browse");
      if (access.error) return failure(access.error);
      return readTree(access.uri!, params.depth, params.limit);
    },
  });

  pi.registerTool({
    name: "viking_write", label: "Viking Write",
    description: "Create, replace or append text in OpenViking. Defaults to create to avoid overwriting existing content. Engine-owned event/archive files cannot be modified.",
    parameters: Type.Object({
      uri: Type.String(), content: Type.String({ maxLength: 1000000 }),
      mode: Type.Optional(StringEnum(["create", "replace", "append"])),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      if (unavailable("viking_write")) return failure("OpenViking server is not reachable.");
      const access = authorizeMutation(params.uri, "viking_write", "write");
      if (access.error) return failure(access.error);
      const directory = access.uri!.slice(0, access.uri!.lastIndexOf("/"));
      const base = /^viking:\/\/user\/[^/]+/.exec(access.uri!)?.[0] ?? /^viking:\/\/[^/]+/.exec(access.uri!)![0];
      if (directory !== base) await ensureDirectoryChain(client, base, directory);
      if (signal?.aborted) return failure("Tool call cancelled.");
      const result = await client.writeContent(access.uri!, params.content, { mode: params.mode ?? "create", wait: false });
      return result.ok ? success(`Written: ${access.uri}`, { uri: access.uri, mode: params.mode ?? "create" }) : failure("Write was not confirmed; inspect content before retrying.");
    },
  });

  pi.registerTool({
    name: "viking_edit", label: "Viking Edit",
    description: "Replace exactly one occurrence of old_text. Rejects missing/ambiguous matches. Calls are serialized in this process and content is rechecked before writing. The server has no compare-and-swap: external concurrent edits may race; this operation is not atomic across processes.",
    parameters: Type.Object({
      uri: Type.String(), old_text: Type.String({ minLength: 1, maxLength: 1000000 }),
      new_text: Type.String({ maxLength: 1000000 }),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      if (unavailable("viking_edit")) return failure("OpenViking server is not reachable.");
      const access = authorizeMutation(params.uri, "viking_edit", "write");
      if (access.error) return failure(access.error);
      const uri = access.uri!;
      const previous = editLocks.get(uri) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        if (signal?.aborted) return failure("Tool call cancelled.");
        const original = await client.readContent(uri);
        if (original === null) return failure("Cannot edit unreadable or missing content.");
        const index = original.indexOf(params.old_text);
        if (index < 0) return failure("old_text does not occur in the current content.");
        if (original.indexOf(params.old_text, index + 1) >= 0) return failure("old_text is ambiguous; provide a unique larger excerpt.");
        const updated = original.slice(0, index) + params.new_text + original.slice(index + params.old_text.length);
        if (await client.readContent(uri) !== original) return failure("Content changed while preparing the edit; reread it before retrying.");
        if (signal?.aborted) return failure("Tool call cancelled.");
        const written = await client.writeContent(uri, updated, { mode: "replace", wait: false });
        if (!written.ok) return failure("Edit was not confirmed; inspect content before retrying.");
        return success(`Edited: ${uri}. This was a best-effort edit; the server does not provide cross-process atomicity.`, { uri, atomic: false });
      });
      editLocks.set(uri, operation);
      try { return await operation; }
      finally { if (editLocks.get(uri) === operation) editLocks.delete(uri); }
    },
  });

  pi.registerTool({
    name: "viking_health", label: "Viking Health",
    description: "Probe the OpenViking health endpoint and refresh connection availability. Health alone does not prove authenticated memory access.",
    parameters: Type.Object({}),
    async execute() {
      const healthy = await client.health();
      return { ...success(JSON.stringify({ healthy, connected: client.connected, authenticatedAccessVerified: false })), isError: !healthy };
    },
  });

}
