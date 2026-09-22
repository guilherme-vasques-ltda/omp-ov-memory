// Copyright 2026 omp-ov-memory contributors. SPDX-License-Identifier: Apache-2.0
// A disk-backed queue: the in-memory dispatch window is bounded; overflow remains
// recoverable on disk. Delivery is at least once. Handlers must reconcile writes
// using stable identities; a timeout is never evidence that a write did not occur.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonBytes, type JsonValue } from "./shared/canonical-json.mjs";

export const HOOK_QUEUE_MAX = 100;
export const HOOK_FLUSH_INTERVAL_MS = 2000;
export const HOOK_FLUSH_THRESHOLD = 20;
export const HOOK_TIMEOUT_MS = 2000;
export const IMMEDIATE_HOOKS = new Set(["session-start", "stop", "session-end", "pre-compact"]);

export interface HookQueueOptions<T> {
  stateDir: string;
  /** Include endpoint, account, user, workspace and harness/session identity. Never include a token. */
  identity: JsonValue;
  handler: (payload: T, signal: AbortSignal) => Promise<void>;
  /** Must run before bytes reach disk. Called again on replay under the current policy. */
  filter?: (payload: T) => T | null;
  maxSize?: number;
  flushIntervalMs?: number;
  flushThreshold?: number;
  timeoutMs?: number;
  /** Only stable error codes are reported; payloads and exception messages are not logged. */
  onError?: (code: string) => void;
}

interface Envelope<T> { version: 1; id: string; payload: T }

export class HookQueue<T = Record<string, unknown>> {
  readonly pendingDirectory: string;
  private readonly options: HookQueueOptions<T>;
  private readonly windowSize: number;
  private readonly timeoutMs: number;
  private sequence = 0;
  private pending = 0;
  private closed = false;
  private lastError: string | null = null;
  private initialized: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<boolean> | null = null;
  private activeDelivery: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private writes = new Set<Promise<void>>();
  private failedWrites = new Map<string, string>();

  constructor(options: HookQueueOptions<T>) {
    this.options = options;
    this.windowSize = Math.max(1, Math.min(HOOK_QUEUE_MAX, options.maxSize ?? HOOK_QUEUE_MAX));
    this.timeoutMs = Math.max(1, Math.min(HOOK_TIMEOUT_MS, options.timeoutMs ?? HOOK_TIMEOUT_MS));
    const key = createHash("sha256").update(canonicalJsonBytes(["omp-ov-memory/hooks/v1", options.identity])).digest("hex");
    this.pendingDirectory = join(options.stateDir, "pending", key);
  }

  get status(): { pending: number; inFlight: boolean; closed: boolean; lastError: string | null } {
    return { pending: this.pending, inFlight: this.activeDelivery !== null, closed: this.closed, lastError: this.lastError };
  }

  /** No server I/O is awaited by a hot hook. Local spooling starts immediately. */
  enqueue(input: T, options: { immediate?: boolean; event?: string } = {}): boolean {
    if (this.closed) return false;
    let serialized: string;
    const id = `${String(Date.now()).padStart(16, "0")}-${String(++this.sequence).padStart(10, "0")}-${randomUUID()}`;
    try {
      const payload = this.options.filter ? this.options.filter(input) : input;
      if (payload === null) return false;
      serialized = `${JSON.stringify({ version: 1, id, payload } satisfies Envelope<T>)}\n`;
    } catch {
      this.report("capture_rejected");
      return false;
    }
    this.pending++;
    this.spool(id, serialized);
    if (options.immediate || IMMEDIATE_HOOKS.has(options.event ?? "") ||
        this.pending >= (this.options.flushThreshold ?? HOOK_FLUSH_THRESHOLD)) {
      void this.flush();
    } else this.schedule();
    return true;
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      for (const directory of [this.options.stateDir, join(this.options.stateDir, "pending"), this.pendingDirectory]) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await lstat(directory)).isDirectory()) throw new Error("unsafe queue directory");
        await chmod(directory, 0o700);
      }
    })().catch(error => { this.initialized = null; throw error; });
    return this.initialized;
  }

  private spool(id: string, serialized: string): void {
    const write = this.initialize().then(() => this.atomicWrite(join(this.pendingDirectory, `${id}.json`), serialized))
      .then(() => { this.failedWrites.delete(id); })
      .catch(() => { this.failedWrites.set(id, serialized); this.report("spool_write_failed"); })
      .finally(() => { this.writes.delete(write); });
    this.writes.add(write);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const directory = await open(this.pendingDirectory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  private async readPrivate(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("unsafe queue record");
      await handle.chmod(0o600);
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }

  private report(code: string): void {
    this.lastError = code;
    try { this.options.onError?.(code); } catch { /* Diagnostics cannot break capture. */ }
  }

  private schedule(): void {
    if (this.closed || this.timer || (this.pending === 0 && this.writes.size === 0)) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.options.flushIntervalMs ?? HOOK_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  /** A process lease prevents simultaneous replay of one durable queue. */
  private async acquireLease(): Promise<(() => Promise<void>) | null> {
    const path = join(this.pendingDirectory, ".lease");
    const temporary = join(this.pendingDirectory, `.lease-${randomUUID()}.tmp`);
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(owner); await handle.sync(); } finally { await handle.close(); }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await link(temporary, path);
          return async () => {
            try { if (await this.readPrivate(path) === owner) await rm(path); }
            catch (error: any) { if (error?.code !== "ENOENT") this.report("lease_release_failed"); }
          };
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
          const previous = JSON.parse(await this.readPrivate(path));
          if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error("invalid lease");
          try { process.kill(previous.pid, 0); return null; }
          catch (probe: any) {
            if (probe?.code !== "ESRCH") return null;
            // Only dead process owners can be reclaimed; a slow owner keeps its lease.
            if (await this.readPrivate(path) === JSON.stringify(previous)) await rm(path);
          }
        }
      }
      return null;
    } finally { await rm(temporary, { force: true }); }
  }

  /** Recover a complete, private temporary after its writer process has exited.
   * Incomplete files remain available for diagnosis; never interpret them as ACKs. */
  private async recoverInterruptedSpools(): Promise<number> {
    let incomplete = 0;
    for (const file of await readdir(this.pendingDirectory)) {
      const match = /^(\d+-\d+-[a-f0-9-]+\.json)\.(\d+)\.[a-z0-9-]+\.tmp$/.exec(file);
      if (!match) continue;
      try { process.kill(Number(match[2]), 0); continue; }
      catch (probe: any) { if (probe?.code !== "ESRCH") continue; }
      const temporary = join(this.pendingDirectory, file);
      try {
        const record = JSON.parse(await this.readPrivate(temporary)) as Envelope<T>;
        if (record.version !== 1 || `${record.id}.json` !== match[1] || !("payload" in record)) throw new Error("incomplete spool");
        // Hard-link publishes without overwriting an already committed record.
        try { await link(temporary, join(this.pendingDirectory, match[1])); }
        catch (error: any) { if (error?.code !== "EEXIST") throw error; }
        await rm(temporary);
      } catch { incomplete++; this.report("spool_incomplete"); }
    }
    return incomplete;
  }

  flush(): Promise<boolean> {
    if (this.flushPromise) return this.flushPromise;
    if (this.activeDelivery) return Promise.resolve(false);
    this.clearTimer();
    const run = this.flushNow().catch(() => { this.report("queue_io_failed"); return false; })
      .finally(() => { this.flushPromise = null; this.schedule(); });
    this.flushPromise = run;
    return run;
  }

  async replayPending(): Promise<boolean> { return this.flush(); }

  private async flushNow(): Promise<boolean> {
    await this.initialize();
    for (const [id, serialized] of this.failedWrites) this.spool(id, serialized);
    // Include spools accepted while a previous disk write was still finishing.
    while (this.writes.size) await Promise.all([...this.writes]);
    if (this.failedWrites.size) return false;
    const release = await this.acquireLease();
    if (!release) { this.report("queue_busy"); return false; }
    try {
      const incomplete = await this.recoverInterruptedSpools();
      while (true) {
        while (this.writes.size) await Promise.all([...this.writes]);
        if (this.failedWrites.size) return false;
        const files = (await readdir(this.pendingDirectory)).filter(file => /^\d+-\d+-[a-f0-9-]+\.json$/.test(file)).sort();
        // A new enqueue may have started while readdir was awaiting the kernel.
        // Do not report a successful drain before its spool has become visible.
        if (!files.length && this.writes.size > 0) continue;
        this.pending = files.length + incomplete;
        if (!files.length) { if (!incomplete) this.lastError = null; return incomplete === 0; }
        for (const file of files.slice(0, this.windowSize)) {
          const path = join(this.pendingDirectory, file);
          const record = JSON.parse(await this.readPrivate(path)) as Envelope<T>;
          if (record.version !== 1 || `${record.id}.json` !== file || !("payload" in record)) throw new Error("invalid queue record");
          let payload: T | null;
          try { payload = this.options.filter ? this.options.filter(record.payload) : record.payload; }
          catch { this.report("capture_rejected"); return false; }
          if (payload === null) { await rm(path); this.pending--; continue; }
          // A policy update can further redact a record before a new delivery attempt.
          const next = `${JSON.stringify({ ...record, payload })}\n`;
          if (next !== `${JSON.stringify(record)}\n`) await this.atomicWrite(path, next);
          if (!await this.deliver(payload, path)) return false;
        }
      }
    } finally {
      if (this.activeDelivery) {
        // Keep the lease while an abort-ignoring handler is still uncertain. Its late
        // confirmed success may acknowledge the record; a late failure leaves it pending.
        void this.activeDelivery.finally(release).catch(() => {});
      } else await release();
    }
  }

  private async deliver(payload: T, path: string): Promise<boolean> {
    const controller = new AbortController();
    this.activeAbort = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delivery = Promise.resolve().then(() => this.options.handler(payload, controller.signal)).then(async () => {
      await rm(path);
      this.pending = Math.max(0, this.pending - 1);
    });
    this.activeDelivery = delivery;
    void delivery.finally(() => {
      if (this.activeDelivery === delivery) { this.activeDelivery = null; this.activeAbort = null; }
    }).catch(() => {});
    try {
      return await Promise.race([
        delivery.then(() => true, () => { this.report("delivery_failed"); return false; }),
        new Promise<boolean>(resolve => { timer = setTimeout(() => {
          controller.abort(); this.report("delivery_timeout"); resolve(false);
        }, this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async drain(timeoutMs = HOOK_TIMEOUT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.flush(),
        new Promise<boolean>(resolve => { timer = setTimeout(() => {
          this.activeAbort?.abort(); resolve(false);
        }, Math.max(0, timeoutMs)); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async dispose(timeoutMs = HOOK_TIMEOUT_MS): Promise<boolean> {
    this.closed = true;
    this.clearTimer();
    return this.drain(timeoutMs);
  }
}
