// SPDX-License-Identifier: Apache-2.0
// OpenViking preserves source_message_ids but does NOT deduplicate appends.
// An intent is therefore published before each append. An unknown outcome may
// only be acknowledged by positive readback; absence never authorizes replay.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OVClient } from "./client.ts";

interface NativeMessage {
  role: string;
  content: string;
  source_message_ids: string[];
  turn_id: string;
  message_kind: "user_query" | "assistant_step" | "tool_transport";
  peer_id?: string;
  created_at?: string;
}
interface Intent { version: 1; sourceId: string; digest: string; birth: string }
interface CommitIntent { version: 1; watermark: string; birth: string; beforeCount: number }
interface NativeProof { digest: string; messageId: string }
interface RemoteView { birth: string; proofs: Map<string, NativeProof> }
const SOURCE_ID = /^omp_mirror_[a-f0-9]{64}$/;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = (role: string, content: string): string => sha(JSON.stringify([role, content]));
class MirrorFailure extends Error { constructor(code: string) { super(code); this.name = "MirrorFailure"; } }

/** Mirror already policy-filtered entries. This class never captures raw entries on disk. */
export class SessionMirror {
  readonly directory: string;
  readonly sessionId: string;
  private client: OVClient;
  private tail: Promise<void> = Promise.resolve();
  private current = { confirmed: 0, unknown: 0, commitUnknown: false, lastError: null as string | null };

  constructor(client: OVClient, stateDir: string, sessionId: string) {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) throw new Error("Invalid native session ID");
    this.client = client;
    this.sessionId = sessionId;
    this.directory = join(stateDir, "session-mirror", sha(JSON.stringify([client.recordedEventTarget, sessionId])));
  }

  get status(): { confirmed: number; unknown: number; commitUnknown: boolean; lastError: string | null } { return { ...this.current }; }

  sync(entries: any[], signal?: AbortSignal): Promise<boolean> {
    return this.serialize(() => this.syncNow(entries, signal));
  }

  /** One extraction attempt per confirmed-source watermark, with durable uncertainty. */
  commit(signal?: AbortSignal): Promise<boolean> {
    return this.serialize(() => this.commitNow(signal));
  }

  private serialize(operation: () => Promise<boolean>): Promise<boolean> {
    const pending = this.tail.then(operation).catch((error: unknown) => {
      this.current.lastError = error instanceof MirrorFailure ? error.message : "MIRROR_IO_FAILED";
      return false;
    });
    this.tail = pending.then(() => {});
    return pending;
  }

  private check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new MirrorFailure("MIRROR_CANCELLED");
  }

  private project(entries: any[]): Map<string, NativeMessage> {
    const messages = new Map<string, NativeMessage>();
    let turnId = `omp_turn_${sha(this.sessionId)}`;
    for (const entry of entries) {
      if (entry?.type !== "message" || typeof entry.id !== "string" || !entry.id) continue;
      const role = entry.message?.role;
      if (!["user", "assistant", "toolResult"].includes(role)) continue;
      const content = typeof entry.message.content === "string" ? entry.message.content
        : Array.isArray(entry.message.content) ? entry.message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
      if (!content.trim()) continue;
      const sourceId = `omp_mirror_${sha(JSON.stringify([this.sessionId, entry.id]))}`;
      if (role === "user") turnId = `omp_turn_${sha(sourceId)}`;
      const body: NativeMessage = {
        role: role === "toolResult" ? "tool" : role,
        content,
        source_message_ids: [sourceId],
        turn_id: turnId,
        message_kind: role === "user" ? "user_query" : role === "assistant" ? "assistant_step" : "tool_transport",
      };
      if (this.client.cfg.peerId) body.peer_id = this.client.cfg.peerId;
      if (typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))) body.created_at = entry.timestamp;
      const existing = messages.get(sourceId);
      if (existing && digest(existing.role, existing.content) !== digest(body.role, body.content)) throw new MirrorFailure("MIRROR_CONTENT_CONFLICT");
      messages.set(sourceId, body);
    }
    return messages;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new MirrorFailure("MIRROR_UNSAFE_STATE");
    await chmod(this.directory, 0o700);
  }

  private async readJson(path: string): Promise<any> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) throw new MirrorFailure("MIRROR_INVALID_STATE");
      return JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  }

  private async readRecord(path: string): Promise<Intent> {
    const record = await this.readJson(path);
    if (record?.version !== 1 || !SOURCE_ID.test(record.sourceId) || !/^[a-f0-9]{64}$/.test(record.digest) || typeof record.birth !== "string" || !record.birth) throw new MirrorFailure("MIRROR_INVALID_STATE");
    return record;
  }

  /** Atomic create-only publication is also the cross-process append/commit claim. */
  private async publishFile(path: string, record: Intent | CommitIntent): Promise<boolean> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temporary, path); }
      catch (error: any) { if (error?.code === "EEXIST") return false; throw error; }
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } finally { await rm(temporary, { force: true }); }
  }

  private async publish(record: Intent, kind: "intent" | "ack"): Promise<boolean> {
    const path = join(this.directory, `${record.sourceId}.${kind}.json`);
    const created = await this.publishFile(path, record);
    if (!created) {
      const old = await this.readRecord(path);
      if (old.digest !== record.digest || old.birth !== record.birth || old.sourceId !== record.sourceId) throw new MirrorFailure("MIRROR_CONTENT_CONFLICT");
    }
    return created;
  }

  private async readCommit(path: string): Promise<CommitIntent> {
    const record = await this.readJson(path);
    if (record?.version !== 1 || !/^[a-f0-9]{64}$/.test(record.watermark) || typeof record.birth !== "string" || !record.birth || !Number.isSafeInteger(record.beforeCount) || record.beforeCount < 0) throw new MirrorFailure("MIRROR_INVALID_STATE");
    return record;
  }

  private async commitState(): Promise<{intents: Map<string, CommitIntent>; acks: Map<string, CommitIntent>}> {
    const intents = new Map<string, CommitIntent>();
    const acks = new Map<string, CommitIntent>();
    for (const file of await readdir(this.directory)) {
      const match = /^commit-([a-f0-9]{64})\.(intent|ack)\.json$/.exec(file);
      if (!match) continue;
      const record = await this.readCommit(join(this.directory, file));
      if (record.watermark !== match[1]) throw new MirrorFailure("MIRROR_INVALID_STATE");
      (match[2] === "intent" ? intents : acks).set(record.watermark, record);
    }
    this.current.commitUnknown = [...intents.keys()].some(key => !acks.has(key));
    return {intents, acks};
  }

  private async metadata(signal?: AbortSignal): Promise<any> {
    this.check(signal);
    const response = await this.client.fetchJSON<any>(`/api/v1/sessions/${encodeURIComponent(this.sessionId)}`);
    if (!response.ok || response.result?.session_id !== this.sessionId || typeof response.result.created_at !== "string" || !Number.isSafeInteger(response.result.commit_count) || response.result.commit_count < 0) throw new MirrorFailure("MIRROR_SESSION_UNAVAILABLE");
    return response.result;
  }

  private async reconcileCommits(signal?: AbortSignal): Promise<Map<string, CommitIntent>> {
    const state = await this.commitState();
    if (!this.current.commitUnknown) return state.acks;
    const metadata = await this.metadata(signal);
    for (const [key, intent] of state.intents) {
      if (state.acks.has(key)) continue;
      if (intent.birth !== metadata.created_at) throw new MirrorFailure("MIRROR_SESSION_REPLACED");
      if (metadata.commit_count <= intent.beforeCount) throw new MirrorFailure("MIRROR_COMMIT_UNKNOWN");
      await this.publishFile(join(this.directory, `commit-${key}.ack.json`), intent);
      state.acks.set(key, intent);
    }
    this.current.commitUnknown = false;
    return state.acks;
  }

  private async commitNow(signal?: AbortSignal): Promise<boolean> {
    this.check(signal);
    await this.initialize();
    const {acks} = await this.localState();
    if (this.current.unknown > 0) throw new MirrorFailure("MIRROR_OUTCOME_UNKNOWN");
    const committed = await this.reconcileCommits(signal);
    if (acks.size === 0) { this.current.lastError = null; return true; }
    const watermark = sha(JSON.stringify([...acks].map(([id, record]) => [id, record.digest]).sort(([a], [b]) => a!.localeCompare(b!))));
    if (committed.has(watermark)) { this.current.lastError = null; return true; }
    const metadata = await this.metadata(signal);
    if ([...acks.values()].some(record => record.birth !== metadata.created_at)) throw new MirrorFailure("MIRROR_SESSION_REPLACED");
    const intent: CommitIntent = {version: 1, watermark, birth: metadata.created_at, beforeCount: metadata.commit_count};
    this.check(signal);
    if (!await this.publishFile(join(this.directory, `commit-${watermark}.intent.json`), intent)) {
      this.current.commitUnknown = true;
      throw new MirrorFailure("MIRROR_COMMIT_UNKNOWN");
    }
    this.current.commitUnknown = true;
    this.check(signal);
    const response = await this.client.fetchJSON<any>(`/api/v1/sessions/${encodeURIComponent(this.sessionId)}/commit`, {
      method: "POST", body: JSON.stringify({keep_recent_count: 0}),
    });
    if (!response.ok || !response.result || !["accepted", "skipped"].includes(response.result.status)) throw new MirrorFailure("MIRROR_COMMIT_UNKNOWN");
    await this.publishFile(join(this.directory, `commit-${watermark}.ack.json`), intent);
    this.current.commitUnknown = false;
    this.current.lastError = null;
    return true;
  }

  private async localState(): Promise<{ intents: Map<string, Intent>; acks: Map<string, Intent> }> {
    const intents = new Map<string, Intent>();
    const acks = new Map<string, Intent>();
    for (const file of await readdir(this.directory)) {
      const match = /^(omp_mirror_[a-f0-9]{64})\.(intent|ack)\.json$/.exec(file);
      if (!match) continue;
      const record = await this.readRecord(join(this.directory, file));
      if (record.sourceId !== match[1]) throw new MirrorFailure("MIRROR_INVALID_STATE");
      (match[2] === "intent" ? intents : acks).set(record.sourceId, record);
    }
    for (const [id, ack] of acks) {
      const intent = intents.get(id);
      if (intent && (intent.birth !== ack.birth || intent.digest !== ack.digest)) throw new MirrorFailure("MIRROR_INVALID_STATE");
    }
    this.current.confirmed = acks.size;
    this.current.unknown = [...intents.keys()].filter(id => !acks.has(id)).length;
    return { intents, acks };
  }

  private addProofs(messages: unknown, proofs: Map<string, NativeProof>, nativeIds: Set<string>): void {
    if (!Array.isArray(messages)) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
    for (const message of messages) {
      if (!message || typeof message.id !== "string" || typeof message.role !== "string") throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
      nativeIds.add(message.id);
      // Checkpoint provenance can reference original IDs without retaining their bytes.
      if (message.message_kind === "checkpoint") continue;
      const content = typeof message.content === "string" ? message.content
        : Array.isArray(message.parts) ? message.parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
      for (const sourceId of Array.isArray(message.source_message_ids) ? message.source_message_ids : []) {
        if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) continue;
        const proof = { digest: digest(message.role, content), messageId: message.id };
        const prior = proofs.get(sourceId);
        if (prior && (prior.messageId !== proof.messageId || prior.digest !== proof.digest)) throw new MirrorFailure("MIRROR_DUPLICATE_SOURCE");
        proofs.set(sourceId, proof);
      }
    }
  }

  private async inspectRemote(wanted: Set<string>, signal?: AbortSignal): Promise<RemoteView> {
    this.check(signal);
    const path = `/api/v1/sessions/${encodeURIComponent(this.sessionId)}`;
    const metadata = await this.client.fetchJSON<any>(path);
    if (!metadata.ok || !metadata.result || metadata.result.session_id !== this.sessionId || typeof metadata.result.created_at !== "string") throw new MirrorFailure("MIRROR_SESSION_UNAVAILABLE");
    this.check(signal);
    const context = await this.client.fetchJSON<any>(`${path}/context?token_budget=128000`);
    if (!context.ok || !context.result) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
    const proofs = new Map<string, NativeProof>();
    const nativeIds = new Set<string>();
    this.addProofs(context.result.messages, proofs, nativeIds);
    const birth = metadata.result.created_at;
    if ([...wanted].every(id => proofs.has(id))) return { birth, proofs };
    const root = metadata.result.uri;
    const expectedRoot = this.client.baseUserRoot;
    if (typeof root !== "string" || !root.endsWith(`/sessions/${this.sessionId}`) ||
        !/^viking:\/\/user\/[^/]+\/sessions\/[^/]+$/.test(root) || (expectedRoot && !root.startsWith(`${expectedRoot}/sessions/`))) throw new MirrorFailure("MIRROR_INVALID_SESSION_URI");
    let liveCount = context.result.messages.length;
    if (liveCount < metadata.result.message_count) {
      // The deployed server truncates active messages to the context budget,
      // including returning none for token_budget=0. Read the source JSONL.
      this.check(signal);
      const raw = await this.client.fetchJSON<string>(`/api/v1/content/read?${new URLSearchParams({uri: `${root}/messages.jsonl`, raw: "true"})}`);
      if (!raw.ok || typeof raw.result !== "string") throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
      const messages = raw.result.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      this.addProofs(messages, proofs, nativeIds);
      liveCount = messages.length;
      if ([...wanted].every(id => proofs.has(id))) return {birth, proofs};
    }
    const archiveIds: string[] = [];
    const pageSize = 1000;
    for (let offset = 0; offset <= 10000; offset += pageSize) {
      this.check(signal);
      const listing = await this.client.fetchJSON<any[]>(`/api/v1/fs/ls?${new URLSearchParams({ uri: `${root}/history`, output: "original", node_limit: String(pageSize), offset: String(offset), sort_by: "name", sort_order: "asc" })}`);
      if (listing.status === 404 && offset === 0) break;
      if (!listing.ok || !Array.isArray(listing.result)) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
      for (const item of listing.result) {
        if (item?.isDir !== true && item?.is_dir !== true) continue;
        if (typeof item.name !== "string" || !/^archive_\d+$/.test(item.name) || archiveIds.includes(item.name)) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
        archiveIds.push(item.name);
      }
      if (listing.result.length < pageSize) break;
      if (offset === 10000) throw new MirrorFailure("MIRROR_ARCHIVE_LIMIT");
    }
    const archiveCount = context.result.stats?.totalArchives;
    if (!Number.isSafeInteger(archiveCount) || archiveCount < 0 || archiveIds.length < archiveCount || archiveIds.length < metadata.result.commit_count) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
    for (const archiveId of archiveIds) {
      this.check(signal);
      const archive = await this.client.fetchJSON<any>(`${path}/archives/${encodeURIComponent(archiveId)}`);
      if (archive.ok && archive.result?.archive_id === archiveId) this.addProofs(archive.result.messages, proofs, nativeIds);
      else if (archive.status === 404) {
        // Native commits publish raw messages before their asynchronous summary is done.
        // The archive API deliberately hides those not-yet-complete archives.
        const raw = await this.client.fetchJSON<string>(`/api/v1/content/read?${new URLSearchParams({ uri: `${root}/history/${archiveId}/messages.jsonl`, raw: "true" })}`);
        if (!raw.ok || typeof raw.result !== "string") throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
        this.addProofs(raw.result.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)), proofs, nativeIds);
      } else throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
      if ([...wanted].every(id => proofs.has(id))) return { birth, proofs };
    }
    this.check(signal);
    const after = await this.client.fetchJSON<any>(path);
    if (!after.ok || !after.result || ["created_at", "updated_at", "message_count", "total_message_count", "commit_count"].some(key => after.result[key] !== metadata.result[key])) throw new MirrorFailure("MIRROR_REMOTE_CHANGED");
    if (!Number.isSafeInteger(metadata.result.total_message_count) || nativeIds.size < metadata.result.total_message_count || !Number.isSafeInteger(metadata.result.message_count) || liveCount < metadata.result.message_count) throw new MirrorFailure("MIRROR_INCOMPLETE_REMOTE_VIEW");
    return { birth, proofs };
  }

  private async syncNow(entries: any[], signal?: AbortSignal): Promise<boolean> {
    this.check(signal);
    await this.initialize();
    const messages = this.project(entries);
    const { intents, acks } = await this.localState();
    await this.reconcileCommits(signal);
    for (const [id, body] of messages) {
      const local = intents.get(id) ?? acks.get(id);
      if (local && local.digest !== digest(body.role, body.content)) throw new MirrorFailure("MIRROR_CONTENT_CONFLICT");
    }
    const wanted = new Set([...messages.keys(), ...[...intents.keys()].filter(id => !acks.has(id))]);
    if (wanted.size === 0) { this.current.lastError = null; return true; }
    const remote = await this.inspectRemote(wanted, signal);
    for (const [id, local] of [...intents, ...acks]) if (wanted.has(id) && local.birth !== remote.birth) throw new MirrorFailure("MIRROR_SESSION_REPLACED");
    for (const id of wanted) {
      const proof = remote.proofs.get(id);
      const body = messages.get(id);
      const local = intents.get(id) ?? acks.get(id);
      const expectedDigest = body ? digest(body.role, body.content) : local?.digest;
      if (proof) {
        if (proof.digest !== expectedDigest) throw new MirrorFailure("MIRROR_CONTENT_CONFLICT");
        await this.publish({version: 1, sourceId: id, digest: proof.digest, birth: remote.birth}, "ack");
        acks.set(id, {version: 1, sourceId: id, digest: proof.digest, birth: remote.birth});
      }
    }
    this.current.confirmed = acks.size;
    this.current.unknown = [...intents.keys()].filter(id => !acks.has(id)).length;
    if (this.current.unknown > 0) throw new MirrorFailure("MIRROR_OUTCOME_UNKNOWN");
    for (const [sourceId, body] of messages) {
      if (remote.proofs.has(sourceId)) continue;
      if (acks.has(sourceId)) throw new MirrorFailure("MIRROR_ACK_NOT_VISIBLE");
      this.check(signal);
      const intent: Intent = { version: 1, sourceId, digest: digest(body.role, body.content), birth: remote.birth };
      if (!await this.publish(intent, "intent")) {
        this.current.unknown++;
        throw new MirrorFailure("MIRROR_OUTCOME_UNKNOWN");
      }
      this.current.unknown++;
      this.check(signal);
      const response = await this.client.fetchJSON(`/api/v1/sessions/${encodeURIComponent(this.sessionId)}/messages`, { method: "POST", body: JSON.stringify(body) });
      if (!response.ok) throw new MirrorFailure("MIRROR_OUTCOME_UNKNOWN");
      const verified = await this.inspectRemote(new Set([sourceId]), signal);
      if (verified.birth !== intent.birth) throw new MirrorFailure("MIRROR_SESSION_REPLACED");
      if (verified.proofs.get(sourceId)?.digest !== intent.digest) throw new MirrorFailure("MIRROR_OUTCOME_UNKNOWN");
      await this.publish(intent, "ack");
      this.current.unknown--;
      this.current.confirmed++;
    }
    this.current.lastError = null;
    return true;
  }
}
