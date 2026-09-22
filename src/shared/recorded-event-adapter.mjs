import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import {
  BATCH_MAX_FILE_BYTES,
  ContentConflictError,
  ContentWriteError,
  ensureDirectoryChain,
  writeContentObjects,
} from "./content-objects.mjs";
import { observation as processObservation } from "./observe.mjs";
import { contentHash, recordedEventBytes, recordedEventId } from "./recorded-event.mjs";

export const RECORDED_EVENT_STORAGE_VERSION = 1;
const RECORDED_EVENT_STORAGE_SEGMENT = `recorded-events/v${RECORDED_EVENT_STORAGE_VERSION}`;

export const EVENT_CHUNK_BYTES = 4 * 1024 * 1024;

const STORAGE_DOMAIN = "pi-openviking/recorded-event-storage";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireEventId(eventId) {
  if (!/^evt_[0-9a-f]{64}$/.test(eventId)) throw new TypeError(`invalid RecordedEvent eventId: ${eventId}`);
  return eventId;
}

function parentUri(uri) {
  return uri.slice(0, uri.lastIndexOf("/"));
}

export function recordedEventStorageLocation(userRoot, sessionId, eventId) {
  const root = String(userRoot || "").replace(/\/+$/, "");
  // Local adaptation: session isolation is a path beneath the authenticated user, never impersonation.
  if (!/^viking:\/\/user\/[A-Za-z0-9._-]+(?:\/omp-ov-memory\/sessions\/[a-f0-9]{24,64})?$/.test(root)) throw new TypeError("RecordedEvent storage requires a bound user root");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
  requireEventId(eventId);
  const sessionKey = createHash("sha256")
    .update(canonicalJsonBytes([STORAGE_DOMAIN, RECORDED_EVENT_STORAGE_VERSION, "session", sessionId]))
    .digest("hex");
  const digest = eventId.slice(4);
  const sessionRoot = `${root}/resources/.pi-openviking/${RECORDED_EVENT_STORAGE_SEGMENT}/${sessionKey}`;
  const shardRoot = `${sessionRoot}/${digest.slice(0, 2)}`;
  return {
    sessionKey,
    sessionRoot,
    shardRoot,
    directUri: `${shardRoot}/.${eventId}.json`,
    claimUri: `${shardRoot}/.${eventId}.claim.json`,
    chunkUri: (index) => `${shardRoot}/.${eventId}.chunk-${String(index).padStart(6, "0")}.bin`,
    commitUri: `${shardRoot}/.${eventId}.commit.json`,
  };
}

/** 存储对象的 JSON 解析：崩溃残留必须表现为本模块的域错误，而不是裸 SyntaxError。 */
function parseStoredJson(bytes, uri) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentConflictError("stored OpenViking object is not valid JSON", uri);
  }
}

/**
 * 逐项复算事件身份与内容 hash。
 *
 * 回读校验必须独立于写出路径：写出时的正确性不能证明读到的字节仍是同一个事件。
 */
export function verifyRecordedEventBytes(bytes, expectedEventId) {
  const event = parseStoredJson(bytes, expectedEventId);
  if (recordedEventId(event?.source) !== expectedEventId) {
    throw new ContentConflictError("stored RecordedEvent identity does not match its location", expectedEventId);
  }
  if (event.eventId !== expectedEventId || contentHash(event.payload) !== event.contentHash) {
    throw new ContentConflictError("stored RecordedEvent content hash does not match its payload", expectedEventId);
  }
  if (!recordedEventBytes(event).equals(bytes)) {
    throw new ContentConflictError("stored RecordedEvent bytes are not canonical", expectedEventId);
  }
  return event;
}

export class RecordedEventAdapter {
  constructor(transport, { userRoot, observation = processObservation }) {
    this.transport = transport;
    this.userRoot = userRoot;
    this.observation = observation;
    this.createdDirectories = new Set();
    this.byteReadVerified = false;
  }

  get resourceRoot() {
    return `${this.userRoot.replace(/\/+$/, "")}/resources`;
  }

  async assertRepresentationAbsent(uri, message) {
    const status = await this.transport.statUri(uri);
    if (!status?.ok) throw new ContentWriteError(`OpenViking stat failed: ${uri}`, { status: status?.status || 0 });
    if (status.exists) throw new ContentConflictError(message, uri);
  }

  /** 事件命名空间 append-only：任何 `updated` 都表示既有事件被改写。 */
  async writeObjects(rootUri, objects) {
    for (const directory of new Set(objects.map((object) => parentUri(object.uri)))) {
      await ensureDirectoryChain(this.transport, this.resourceRoot, directory, this.createdDirectories);
    }
    await writeContentObjects(this.transport, rootUri, objects, (batch) => {
      if (batch.updated.size !== 0) {
        throw new ContentConflictError("OpenViking replaced an existing RecordedEvent object", [...batch.updated][0]);
      }
    });
  }

  async downloadVerified(uri, expectedLength, expectedHash) {
    const response = await this.transport.downloadBytes(uri);
    if (!response?.ok || !Buffer.isBuffer(response.bytes) ||
        response.bytes.length !== expectedLength || sha256(response.bytes) !== expectedHash) {
      throw new ContentWriteError(`OpenViking byte verification failed: ${uri}`);
    }
    return response.bytes;
  }

  async writeChunked(event, location, bytes) {
    await this.assertRepresentationAbsent(location.directUri, "direct representation already exists for event");
    const chunks = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += EVENT_CHUNK_BYTES, index++) {
      const content = bytes.subarray(offset, Math.min(bytes.length, offset + EVENT_CHUNK_BYTES));
      chunks.push({
        index,
        uri: location.chunkUri(index),
        byteLength: content.length,
        contentHash: sha256(content),
        bytes: content,
      });
    }
    const claim = {
      schemaVersion: RECORDED_EVENT_STORAGE_VERSION,
      type: "recorded-event-claim",
      eventId: event.eventId,
      eventHash: sha256(bytes),
      byteLength: bytes.length,
      chunks: chunks.map(({ index, uri, byteLength, contentHash: hash }) => ({ index, uri, byteLength, contentHash: hash })),
    };
    const claimBytes = canonicalJsonBytes(claim);
    await this.writeObjects(location.sessionRoot, [{ uri: location.claimUri, bytes: claimBytes }]);
    await this.writeObjects(location.sessionRoot, chunks.map((chunk) => ({ uri: chunk.uri, bytes: chunk.bytes })));

    const downloaded = [];
    for (const chunk of chunks) downloaded.push(await this.downloadVerified(chunk.uri, chunk.byteLength, chunk.contentHash));
    const reconstructed = Buffer.concat(downloaded);
    if (reconstructed.length !== claim.byteLength || sha256(reconstructed) !== claim.eventHash) {
      throw new ContentWriteError(`OpenViking event verification failed: ${event.eventId}`);
    }
    this.byteReadVerified = true;

    const commit = {
      schemaVersion: RECORDED_EVENT_STORAGE_VERSION,
      type: "recorded-event-commit",
      eventId: event.eventId,
      claimHash: sha256(claimBytes),
    };
    await this.writeObjects(location.sessionRoot, [{ uri: location.commitUri, bytes: canonicalJsonBytes(commit) }]);
  }

  async writeEvents(sessionId, events) {
    const direct = [];
    const chunked = [];
    for (const event of events) {
      requireEventId(event?.eventId);
      if (event?.source?.system === "pi" && event.source.sessionId !== sessionId) {
        throw new ContentWriteError(`RecordedEvent session mismatch: ${event?.eventId || "unknown"}`);
      }
      if (!event?.source || !["pi", "pi-openviking"].includes(event.source.system)) {
        throw new ContentWriteError(`RecordedEvent source is not supported: ${event?.eventId || "unknown"}`);
      }
      const bytes = recordedEventBytes(event);
      const location = recordedEventStorageLocation(this.userRoot, sessionId, event.eventId);
      if (bytes.length <= BATCH_MAX_FILE_BYTES) direct.push({ event, location, bytes });
      else chunked.push({ event, location, bytes });
    }
    this.observation.emit("event_representation", direct, chunked);
    for (const item of direct) {
      await this.assertRepresentationAbsent(item.location.claimUri, "chunked representation already exists for event");
    }
    if (direct.length > 0) {
      await this.writeObjects(
        direct[0].location.sessionRoot,
        direct.map((item) => ({ uri: item.location.directUri, bytes: item.bytes })),
      );
    }
    if (direct.length > 0 && !this.byteReadVerified) {
      const sample = direct[0];
      const downloaded = await this.transport.downloadBytes(sample.location.directUri);
      if (!downloaded?.ok || !Buffer.isBuffer(downloaded.bytes) || !downloaded.bytes.equals(sample.bytes)) {
        throw new ContentWriteError(`OpenViking direct byte verification failed: ${sample.location.directUri}`);
      }
      this.byteReadVerified = true;
    }
    for (const item of chunked) await this.writeChunked(item.event, item.location, item.bytes);

    return {
      acceptedEventIds: events.map((event) => event.eventId),
      capabilityVerified: this.byteReadVerified,
    };
  }

  /**
   * 按 event ID 回读已接受事件，direct 与 chunked 两种表示都复算到规范字节。
   *
   * 没有有效 commit marker 的 chunked 事件不是已接受事件。读路径与写路径对称：
   * chunk 位置由 event ID 确定性推导，而不是采信 claim 里写着的 URI——具有相同凭证的
   * 外部写入不在信任边界内，claim 因此不能作为可信的位置来源。
   */
  async readEvent(sessionId, eventId) {
    const stored = await this.readEventIfExists(sessionId, eventId);
    if (!stored) throw new ContentWriteError(`RecordedEvent is not stored: ${eventId}`);
    return stored;
  }

  async readEventIfExists(sessionId, eventId) {
    const location = recordedEventStorageLocation(this.userRoot, sessionId, requireEventId(eventId));
    const [direct, commit] = await Promise.all([
      this.statRepresentation(location.directUri),
      this.statRepresentation(location.commitUri),
    ]);
    if (direct && commit) {
      throw new ContentConflictError("direct and chunked representations coexist for event", location.directUri);
    }
    if (direct) {
      const response = await this.transport.downloadBytes(location.directUri);
      if (!response?.ok || !Buffer.isBuffer(response.bytes)) {
        throw new ContentWriteError(`OpenViking download failed: ${location.directUri}`);
      }
      return { event: verifyRecordedEventBytes(response.bytes, eventId), bytes: response.bytes };
    }
    if (!commit) return null;

    const commitResponse = await this.transport.downloadBytes(location.commitUri);
    const claimResponse = await this.transport.downloadBytes(location.claimUri);
    if (!commitResponse?.ok || !claimResponse?.ok) throw new ContentWriteError(`OpenViking download failed: ${eventId}`);
    const marker = parseStoredJson(commitResponse.bytes, location.commitUri);
    const claim = parseStoredJson(claimResponse.bytes, location.claimUri);
    if (marker?.eventId !== eventId || marker?.claimHash !== sha256(claimResponse.bytes) || claim?.eventId !== eventId) {
      throw new ContentConflictError("stored RecordedEvent commit marker does not match its claim", location.commitUri);
    }
    if (!Array.isArray(claim.chunks) || claim.chunks.length === 0) {
      throw new ContentConflictError("stored RecordedEvent claim does not list chunks", location.claimUri);
    }
    const parts = [];
    for (const [index, chunk] of claim.chunks.entries()) {
      if (chunk?.index !== index || chunk?.uri !== location.chunkUri(index)) {
        throw new ContentConflictError("stored RecordedEvent chunk is not at its derived location", location.claimUri);
      }
      parts.push(await this.downloadVerified(chunk.uri, chunk.byteLength, chunk.contentHash));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== claim.byteLength || sha256(bytes) !== claim.eventHash) {
      throw new ContentConflictError("stored RecordedEvent chunks do not reassemble to the claimed event", location.claimUri);
    }
    return { event: verifyRecordedEventBytes(bytes, eventId), bytes };
  }

  async statRepresentation(uri) {
    const status = await this.transport.statUri(uri);
    if (!status?.ok) throw new ContentWriteError(`OpenViking stat failed: ${uri}`, { status: status?.status || 0 });
    return status.exists === true;
  }
}
