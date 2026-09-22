// Apache-2.0; derived from pi-openviking 0.4.4, adapted to OV 0.4.20.
import { isLoopbackHost, validateEndpoint, type OVConfig } from "./config.ts";
import { Agent, request as undiciRequest } from "undici";
import { observation, type Observation } from "./shared/observe.mjs";
import { openVikingApiPath } from "./shared/openviking-api.mjs";

// pi installs a proxying global dispatcher (undici EnvHttpProxyAgent) when
// settings.httpProxy is set, and it only honors NO_PROXY captured at startup.
// Loopback endpoints must never traverse a proxy, so they get a direct agent.


// --- OV API Response Shapes ---
// All OV responses wrap in: { status: "ok"|"error", result: T, error?: {...}, ... }
// This client normalizes to { ok, result } internally.

export interface OVSearchResult {
  uri: string;
  context_type: string;   // "memory" | "resource" | "skill"
  score: number;
  abstract: string;
  overview: string | null;
  level: number;          // 0=L0, 1=L1, 2=L2
  category: string;
  match_reason: string;
}

export interface OVDirEntry {
  uri: string;
  name: string;
  isDir: boolean;
  size: number;
  mode: number;
  modTime: string;
  abstract: string;
}

export interface OVStatInfo {
  name: string;
  size: number;
  mode: number;
  modTime: string;
  isDir: boolean;
  isLocked: boolean;
  uri?: string;
  count?: number;         // directories only
}


export interface OVResponse<T> {
  ok: boolean;
  result: T | null;
  error?: any;
  status?: number;
  traceId?: string;
}

export interface OVBatchWriteOperation {
  uri: string;
  content_base64: string;
  precondition: { kind: "create_if_absent" } | { kind: "replace_if_hash"; base_hash: string };
}

export interface OVBatchWriteRequest {
  root_uri: string;
  operations: OVBatchWriteOperation[];
  wait: false;
}

export interface OVBatchWriteResult {
  root_uri: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  queue_status?: unknown;
}

export interface OVUriStatus {
  ok: boolean;
  exists: boolean;
  isDir: boolean;
  status: number;
  error?: unknown;
}

export interface OVBytesResponse {
  ok: boolean;
  bytes: Buffer | null;
  status: number;
  error?: unknown;
}

export class OVClient {
  private baseUrl: string;
  private apiKey: string;
  private account: string;
  private user: string;
  private peerId: string;
  private scopeKey = "";
  private readonly loopback: boolean;
  private directAgent?: Agent;
  private lifecycleAbort = new AbortController();
  private readonly observe: Observation;
  connected: boolean = false;

  /** Read-only access to config (for value access across modules). */
  readonly cfg: OVConfig;

  constructor(config: OVConfig, observe: Observation = observation) {
    this.cfg = config;
    this.observe = observe;
    this.baseUrl = validateEndpoint(config.endpoint, config.apiKey);
    this.apiKey = config.apiKey;
    this.account = config.account;
    this.user = config.user;
    this.peerId = config.peerId;
    this.loopback = isLoopbackHost(new URL(this.baseUrl).hostname);
    this.observe.emit("client_connection", "snapshot", false);
    this.observe.emit("client_namespace", "snapshot", this.user);
  }

  /**
   * Rebind the memory namespace this client reads and writes.
   *
   * Must be called before the first request that touches memory, otherwise
   * earlier calls land in the shared user space and leak across sessions.
   */
  bindUser(user: string): void {
    if (!user || user === this.user) return;
    const previous = this.user;
    this.user = user;
    this.observe.emit("client_namespace", "change", previous, user);
  }

  /**
   * Root of the bound memory namespace, or "" when none is bound.
   *
   * The user header only scopes memory-semantic operations; direct viking://
   * URI access stays global. Callers that expose URIs to the model use this
   * to keep the model inside its own namespace.
   */
  /** Session isolation is a storage subpath, never an impersonated auth user. */
  bindScope(scopeKey: string): void {
    if (scopeKey && !/^[a-f0-9]{24,64}$/.test(scopeKey)) throw new Error("OpenViking scope must be a safe hexadecimal digest");
    this.scopeKey = scopeKey;
  }

  get authenticatedUser(): string { return this.user; }
  get baseUserRoot(): string { return this.user ? `viking://user/${this.user}` : ""; }

  get userRoot(): string {
    if (!this.baseUserRoot) return "";
    return this.scopeKey ? `${this.baseUserRoot}/omp-ov-memory/sessions/${this.scopeKey}` : this.baseUserRoot;
  }

  get recordedEventTarget(): { endpoint: string; account: string; user: string; scope: string } {
    return { endpoint: this.baseUrl, account: this.account, user: this.user, scope: this.scopeKey };
  }

  /**
   * 记忆空间名：profile 注入和 recall 展开 `viking://user/<reserved>/...` 时使用。
   *
   * 与 `userRoot` 和 `recordedEventTarget` 同源，都是 `this.user`：读取必须落在
   * 写入所在的命名空间，否则扩展会写进一处、读另一处。因此这里不做任何回退或
   * 服务端查询——身份只由已绑定的凭证决定。
   *
   * 未绑定用户时返回 ""，调用方跳过 profile 与 URI 展开。
   */
  get memorySpace(): string {
    return this.userRoot ? this.userRoot.slice("viking://user/".length) : "";
  }

  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), this.lifecycleAbort.signal]);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.account) h["X-OpenViking-Account"] = this.account;
    if (this.user) h["X-OpenViking-User"] = this.user;
    if (this.peerId) h["X-OpenViking-Actor-Peer"] = this.peerId;
    if (this.cfg.userAgent) h["User-Agent"] = this.cfg.userAgent;
    return h;
  }

  /** Bounded request; retries only reads, and never follows credential-bearing redirects. */
  async fetchJSON<T>(path: string, init?: RequestInit, timeoutMs = this.cfg.requestTimeoutMs): Promise<OVResponse<T>> {
    const method = (init?.method ?? "GET").toUpperCase();
    if (!path.startsWith("/") || path.startsWith("//")) return { ok: false, result: null, status: 0, error: { code: "INVALID_PATH", message: "Expected a relative API path" } };
    const timeout = Math.max(1, Math.min(2_000, this.cfg.requestTimeoutMs || 2_000, timeoutMs || 2_000));
    const op = this.observe.begin("client_http", path.split("?")[0], method, timeout);
    const signal = AbortSignal.any([this.requestSignal(timeout), ...(init?.signal ? [init.signal] : [])]);
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(this.headers())) headers.set(key, value);
    const retryable = method === "GET" || method === "HEAD" || (method === "POST" && /^\/api\/v1\/search\/(?:find|search|glob|grep|recall)(?:\?|$)/.test(path));
    for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt++) {
      try {
        signal.throwIfAborted();
        let status: number, body: any;
        if (this.loopback) {
          this.directAgent ??= new Agent();
          const response = await undiciRequest(`${this.baseUrl}${path}`, {
            method: method as "GET" | "POST" | "PUT" | "DELETE" | "HEAD",
            headers: Object.fromEntries(headers),
            body: init?.body as string | undefined,
            signal,
            dispatcher: this.directAgent,
          });
          status = response.statusCode;
          try { body = await response.body.json(); }
          catch { body = undefined; }
        } else {
          const response = await fetch(`${this.baseUrl}${path}`, { ...init, method, headers, signal, redirect: "manual" });
          status = response.status;
          try { body = await response.json(); }
          catch { body = undefined; }
        }
        if (retryable && attempt === 0 && [429, 502, 503, 504].includes(status) && !signal.aborted) continue;
        const traceValue = body?.result?.trace_id || body?.error?.trace_id || body?.trace_id;
        const traceId = typeof traceValue === "string" && /^[\w-]{1,128}$/.test(traceValue) ? traceValue : undefined;
        if (status < 200 || status >= 300 || body?.status === "error" || body === undefined || body === null) {
          this.observe.end("client_http", op, "http_error", status, traceId);
          // Do not reflect server messages: they can echo input text or credentials.
          const code = typeof body?.error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(body.error.code) ? body.error.code : "HTTP_ERROR";
          return { ok: false, result: null, status, error: { code, message: body === undefined ? "Invalid JSON response" : `OpenViking request failed (HTTP ${status})` }, traceId };
        }
        this.observe.end("client_http", op, "success", status, traceId);
        return { ok: true, result: (Object.hasOwn(body, "result") ? body.result : body) as T, status, traceId };
      } catch {
        if (retryable && attempt === 0 && !signal.aborted) continue;
        const aborted = signal.aborted;
        this.observe.end("client_http", op, aborted ? "aborted" : "network_error", 0, undefined);
        return { ok: false, result: null, status: 0, error: { code: aborted ? "ABORTED" : "NETWORK_ERROR", message: aborted ? "OpenViking request timed out or was closed" : "OpenViking request failed; write outcome may be unknown" } };
      }
    }
    return { ok: false, result: null, status: 0, error: { code: "REQUEST_FAILED", message: "OpenViking request failed" } };
  }

  // ========== Health ==========

  async health(): Promise<boolean> {
    const previous = this.connected;
    const res = await this.fetchJSON<any>("/health", undefined, 1000);
    this.connected = res.ok && res.result?.healthy === true;
    if (previous !== this.connected) this.observe.emit("client_connection", "change", previous, this.connected);
    return this.connected;
  }

  // ========== Sessions ==========

  /** Create or reuse a session. */
  async createSession(sessionId: string): Promise<boolean> {
    const res = await this.fetchJSON<any>(openVikingApiPath("/sessions"), {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    });
    // OV returns 409 for an existing explicit ID. Verify that the caller can
    // read that session; a conflict alone is not proof of successful reuse.
    return res.ok || (res.status === 409 && (await this.getSession(sessionId)).ok);
  }


  /** Add a message in simple text mode, scoped to the active workspace peer. */
  async addMessage(sessionId: string, role: string, content: string): Promise<boolean> {
    const body: Record<string, string> = { role, content };
    if (this.peerId) body.peer_id = this.peerId;
    const res = await this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}/messages`),
      { method: "POST", body: JSON.stringify(body) },
      2000,
    );
    return res.ok;
  }

  /** Commit only an explicit viking_remember message for memory extraction. */
  async commitRememberedMessage(sessionId: string): Promise<boolean> {
    const response = await this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}/commit`),
      { method: "POST", body: JSON.stringify({ keep_recent_count: 0 }) },
      2000,
    );
    return response.ok;
  }

  async getSession(sessionId: string): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}`),
      undefined,
      2000,
    );
  }

  async commitSession(sessionId: string): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}/commit`),
      { method: "POST", body: JSON.stringify({ keep_recent_count: 0 }) },
      2000,
    );
  }

  async getTask(taskId: string): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/tasks/${encodeURIComponent(taskId)}`),
      undefined,
      2000,
    );
  }

  async cancelTask(taskId: string): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/tasks/${encodeURIComponent(taskId)}/cancel`),
      { method: "POST", body: JSON.stringify({}) },
      2000,
    );
  }

  async listTasks(resourceId: string): Promise<OVResponse<any[]>> {
    return this.fetchJSON<any[]>(
      openVikingApiPath(`/tasks?task_type=session_commit&resource_id=${encodeURIComponent(resourceId)}&limit=20`),
      undefined,
      2000,
    );
  }


  async getSessionContext(sessionId: string, tokenBudget = 16000): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${Math.max(0, Math.floor(tokenBudget))}`),
      undefined,
      2000,
    );
  }

  async deleteSession(sessionId: string): Promise<OVResponse<any>> {
    return this.fetchJSON<any>(
      openVikingApiPath(`/sessions/${encodeURIComponent(sessionId)}`),
      { method: "DELETE" },
      2000,
    );
  }

  // ========== Search ==========

  /** Basic vector search. */
  async find(
    query: string,
    opts?: { targetUri?: string; topK?: number; scoreThreshold?: number; timeoutMs?: number },
  ): Promise<OVSearchResult[]> {
    const body: Record<string, unknown> = { query };
    if (opts?.targetUri) body.target_uri = opts.targetUri;
    if (opts?.topK) body.limit = opts.topK;
    if (opts?.scoreThreshold !== undefined) body.score_threshold = opts.scoreThreshold;

    const res = await this.fetchJSON<any>(openVikingApiPath("/search/find"), {
      method: "POST", body: JSON.stringify(body),
    }, opts?.timeoutMs ?? 2000);
    if (!res.ok || !res.result) return [];

    // OV returns { memories: [...], resources: [...], skills: [...], total }
    const all: OVSearchResult[] = [];
    for (const bucket of ["memories", "resources", "skills"]) {
      const items = res.result[bucket];
      if (Array.isArray(items)) {
        for (const m of items) {
          all.push({
            uri: m.uri ?? "",
            context_type: m.context_type ?? (bucket === "memories" ? "memory" : bucket === "skills" ? "skill" : "resource"),
            score: m.score ?? 0,
            abstract: m.abstract ?? "",
            overview: m.overview ?? null,
            level: m.level ?? 0,
            category: m.category ?? "",
            match_reason: m.match_reason ?? "",
          });
        }
      }
    }
    return all;
  }

  // ========== Content ==========

  /** L0 content summary. */
  async abstract(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      openVikingApiPath(`/content/abstract?uri=${encodeURIComponent(uri)}`),
      undefined, 2000,
    );
    return res.ok ? res.result : null;
  }

  /** L1 directory overview. */
  async overview(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      openVikingApiPath(`/content/overview?uri=${encodeURIComponent(uri)}`),
      undefined, 2000,
    );
    return res.ok ? res.result : null;
  }

  /** L2 full file content. */
  async readContent(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      openVikingApiPath(`/content/read?uri=${encodeURIComponent(uri)}`),
      undefined, 2000,
    );
    return res.ok ? res.result : null;
  }

  /**
   * Adapt immutable engine writes to OV 0.4.20's native mode:create batch API.
   * No client-side retry of writes. Existing identical bytes are reconciled on
   * later calls. Hash replacement is rejected because this API has no CAS.
   */
  async batchWrite(request: OVBatchWriteRequest): Promise<OVResponse<OVBatchWriteResult>> {
    if (request.operations.some(operation => operation.precondition.kind !== "create_if_absent")) {
      return { ok: false, result: null, status: 501, error: { code: "UNSUPPORTED_PRECONDITION", message: "This OpenViking API has no atomic hash-compare replacement" } };
    }
    const unchanged: string[] = [];
    const pending: OVBatchWriteOperation[] = [];
    for (const operation of request.operations) {
      const existing = await this.downloadBytes(operation.uri);
      if (existing.ok && existing.bytes) {
        if (!existing.bytes.equals(Buffer.from(operation.content_base64, "base64"))) return { ok: false, result: null, status: 409, error: { code: "CONTENT_CONFLICT", message: "Immutable object already contains different bytes" } };
        unchanged.push(operation.uri);
      } else if (existing.status === 404) pending.push(operation);
      else return { ok: false, result: null, status: existing.status, error: existing.error };
    }
    if (!pending.length) return { ok: true, result: { root_uri: request.root_uri, created: [], updated: [], unchanged }, status: 200 };
    const response = await this.fetchJSON<any>(openVikingApiPath("/content/batch-write"), {
      method: "POST",
      body: JSON.stringify({ root_uri: request.root_uri, operations: pending.map(({ uri, content_base64 }) => ({ uri, content_base64, mode: "create" })), wait: false }),
    });
    if (!response.ok) return response;
    // Require the native acceptance contract as well as byte-level proof.
    // This must never turn a partial or unexpected server response into an ACK.
    const accepted = response.result;
    const expected = new Set(pending.map(operation => operation.uri));
    if (accepted?.root_uri !== request.root_uri || !Array.isArray(accepted.created) || !Array.isArray(accepted.updated) || !Array.isArray(accepted.unchanged) || accepted.updated.length !== 0 || [...accepted.created, ...accepted.unchanged].length !== expected.size || new Set([...accepted.created, ...accepted.unchanged]).size !== expected.size || [...accepted.created, ...accepted.unchanged].some(uri => !expected.has(uri))) {
      return { ok: false, result: null, status: 502, error: { code: "WRITE_UNVERIFIED", message: "Unexpected batch acceptance response; reconcile stored bytes before retry" } };
    }
    for (const operation of pending) {
      const stored = await this.downloadBytes(operation.uri);
      if (!stored.ok || !stored.bytes?.equals(Buffer.from(operation.content_base64, "base64"))) return { ok: false, result: null, status: stored.status || 0, error: { code: "WRITE_UNVERIFIED", message: "Stored bytes could not be verified; reconcile before retry" } };
    }
    return { ok: true, result: { root_uri: request.root_uri, created: accepted.created, updated: [], unchanged: [...unchanged, ...accepted.unchanged] }, status: response.status };
  }

  /** Raw stored bytes without JSON decoding; bounded and never follows redirects. */
  async downloadBytes(uri: string): Promise<OVBytesResponse> {
    const path = openVikingApiPath(`/content/download?uri=${encodeURIComponent(uri)}`);
    const signal = this.requestSignal(Math.min(this.cfg.requestTimeoutMs || 2_000, 2_000));
    try {
      signal.throwIfAborted();
      let status: number, bytes: Buffer;
      if (this.loopback) {
        this.directAgent ??= new Agent();
        const response = await undiciRequest(`${this.baseUrl}${path}`, { method: "GET", headers: this.headers(), signal, dispatcher: this.directAgent });
        status = response.statusCode;
        bytes = Buffer.from(await response.body.arrayBuffer());
      } else {
        const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal, redirect: "manual" });
        status = response.status;
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (status >= 200 && status < 300) return { ok: true, bytes, status };
      return { ok: false, bytes: null, status, error: { message: `OpenViking download failed (HTTP ${status})` } };
    } catch {
      return { ok: false, bytes: null, status: 0, error: { message: "OpenViking download timed out or failed" } };
    }
  }

  async tree(uri: string, opts: { depth?: number; nodeLimit?: number } = {}): Promise<OVResponse<unknown>> {
    const params = new URLSearchParams({ uri, level_limit: String(opts.depth ?? 3), node_limit: String(opts.nodeLimit ?? 100), output: "original" });
    return this.fetchJSON(openVikingApiPath(`/fs/tree?${params}`));
  }

  async writeContent(uri: string, content: string, opts: { mode?: "create" | "replace" | "append"; wait?: boolean } = {}): Promise<OVResponse<any>> {
    return this.fetchJSON(openVikingApiPath("/content/write"), { method: "POST", body: JSON.stringify({ uri, content, mode: opts.mode ?? "create", wait: opts.wait ?? false }) });
  }

  /** Upload already vetted bytes. The OV server never fetches the original URL. */
  async uploadResource(bytes: Uint8Array, filename: string, opts: { sourceUrl?: string; reason?: string; to?: string } = {}): Promise<OVResponse<{ root_uri: string }>> {
    // Use a text-only upload name: parser selection must not introduce another URL fetch.
    const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/\.[^.]*$/, "").slice(0, 100) + ".txt";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "text/plain" }), safeName);
    const encoded = new Request("http://localhost", { method: "POST", body: form });
    const body = Buffer.from(await encoded.arrayBuffer());
    const headers = this.headers();
    headers["Content-Type"] = encoded.headers.get("content-type")!;
    const signal = this.requestSignal(Math.min(this.cfg.requestTimeoutMs || 2_000, 2_000));
    let upload: any;
    try {
      signal.throwIfAborted();
      let status: number;
      if (this.loopback) {
        this.directAgent ??= new Agent();
        const response = await undiciRequest(`${this.baseUrl}/api/v1/resources/temp_upload`, { method: "POST", headers, body, signal, dispatcher: this.directAgent });
        status = response.statusCode;
        upload = await response.body.json();
      } else {
        const response = await fetch(`${this.baseUrl}/api/v1/resources/temp_upload`, { method: "POST", headers, body, signal, redirect: "manual" });
        status = response.status;
        upload = await response.json();
      }
      if (status < 200 || status >= 300 || upload?.status === "error") return { ok: false, result: null, status, error: { message: `OpenViking upload failed (HTTP ${status})` } };
    } catch { return { ok: false, result: null, status: 0, error: { message: "OpenViking upload timed out or failed; outcome may be unknown" } }; }
    const id = upload?.result?.temp_file_id ?? upload?.temp_file_id;
    if (typeof id !== "string" || !id) return { ok: false, result: null, status: 502, error: { message: "Upload response omitted temp_file_id" } };
    return this.fetchJSON(openVikingApiPath("/resources"), { method: "POST", body: JSON.stringify({ temp_file_id: id, ...(opts.to ? { to: opts.to, create_parent: true } : {}), reason: opts.reason ?? (opts.sourceUrl ? `Imported text from ${opts.sourceUrl}` : "Imported text"), wait: false }) });
  }

  /** Stat result that distinguishes not-found from transport failure. */
  async statUri(uri: string): Promise<OVUriStatus> {
    const response = await this.fetchJSON<OVStatInfo>(
      openVikingApiPath(`/fs/stat?uri=${encodeURIComponent(uri)}`),
      undefined,
      2000,
    );
    if (response.ok && response.result) {
      return { ok: true, exists: true, isDir: response.result.isDir === true, status: response.status || 200 };
    }
    if (response.status === 404) return { ok: true, exists: false, isDir: false, status: 404 };
    return { ok: false, exists: false, isDir: false, status: response.status || 0, error: response.error };
  }

  /** Create one VikingFS directory; callers make parents explicitly. */
  async mkdirUri(uri: string): Promise<OVResponse<{ uri: string }>> {
    return this.fetchJSON<{ uri: string }>(
      openVikingApiPath("/fs/mkdir"),
      { method: "POST", body: JSON.stringify({ uri }) },
      2000,
    );
  }


  // ========== Filesystem ==========

  /** List one directory. */
  async ls(uri: string): Promise<OVDirEntry[]> {
    const res = await this.fetchJSON<any[]>(
      openVikingApiPath(`/fs/ls?uri=${encodeURIComponent(uri)}`),
      undefined, 2000,
    );
    if (!res.ok || !Array.isArray(res.result)) return [];
    return res.result.map(e => ({
      uri: e.uri ?? "",
      name: e.name ?? uriBasename(e.uri ?? ""),
      isDir: e.isDir ?? false,
      size: e.size ?? 0,
      mode: e.mode ?? 0,
      modTime: e.modTime ?? "",
      abstract: e.abstract ?? "",
    }));
  }

  /** Read file or directory metadata. */
  async stat(uri: string): Promise<OVStatInfo | null> {
    const res = await this.fetchJSON<OVStatInfo>(
      openVikingApiPath(`/fs/stat?uri=${encodeURIComponent(uri)}`),
      undefined, 2000,
    );
    return res.ok ? res.result : null;
  }

  /** Remove a file or directory. */
  async delete(uri: string, recursive = false): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      openVikingApiPath(`/fs?uri=${encodeURIComponent(uri)}&recursive=${recursive}`),
      { method: "DELETE" },
      2000,
    );
    return res.ok;
  }

  // ========== Resources ==========

  /** Ingest a URL or file path. */
  async addResource(
    path: string, opts?: { reason?: string },
  ): Promise<{ root_uri: string } | null> {
    const body: Record<string, unknown> = { path };
    if (opts?.reason) body.reason = opts.reason;
    const res = await this.fetchJSON<{ root_uri: string }>(
      openVikingApiPath("/resources"),
      { method: "POST", body: JSON.stringify(body) },
      2000,
    );
    return res.ok ? res.result : null;
  }

  // ========== User Space Resolution ==========

  /**
   * 未配置用户时的存储用户名：服务端为本次凭证解析出的当前用户。
   *
   * SPEC“目标配置”规定 `sessionScopedMemory=false` 时使用配置用户或服务解析的
   * 当前用户。这里只问服务端本身，不枚举 `viking://user` 后挑选——该 ls 不按调
   * 用方过滤，任何挑选都可能选中其他用户的 space，并把事件写进去。
   *
   * Fail closed when the server cannot prove identity. Never guess "default"
   * and accidentally route captured data to a different principal.
   */
  async resolveUserSpace(): Promise<string> {
    const statusRes = await this.fetchJSON<any>(openVikingApiPath("/system/status"), undefined, 2000);
    const resolved = statusRes.ok && typeof statusRes.result?.user === "string"
      ? statusRes.result.user.trim()
      : "";
    return resolved;
  }

  async close(force = false): Promise<void> {
    this.lifecycleAbort.abort();
    const previous = this.connected;
    this.connected = false;
    if (previous !== this.connected) this.observe.emit("client_connection", "change", previous, this.connected);
    const agent = this.directAgent;
    this.directAgent = undefined;
    if (agent) {
      if (force && typeof agent.destroy === "function") await agent.destroy();
      else if (typeof agent.close === "function") await agent.close();
    }
    this.observe.emit("client_connection", "snapshot", this.connected);
    this.observe.emit("client_namespace", "snapshot", this.user);
  }
}

function uriBasename(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const last = cleaned.lastIndexOf("/");
  return last >= 0 ? cleaned.slice(last + 1) : cleaned;
}
