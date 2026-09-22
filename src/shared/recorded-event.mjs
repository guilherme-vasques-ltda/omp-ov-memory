import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";

export const RECORDED_EVENT_SCHEMA_VERSION = 1;
export const RECORDED_EVENT_IDENTITY_VERSION = 1;

const EVENT_DOMAIN = "pi-openviking/recorded-event";
const TURN_DOMAIN = "pi-openviking/turn";
const STEP_DOMAIN = "pi-openviking/step";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJsonBytes(value))}`;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function jsonClone(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Pi source value is not JSON-serializable: ${error?.message || String(error)}`);
  }
  if (serialized === undefined) throw new TypeError("Pi source value is not JSON-serializable");
  return JSON.parse(serialized);
}

function partType(value) {
  if (typeof value === "string") return "text";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.type === "string" && value.type.length > 0) return value.type;
    if (typeof value.kind === "string" && value.kind.length > 0) return value.kind;
  }
  return "unknown";
}

function splitContentEntry(entry, container, content, forcedPartType) {
  const envelope = jsonClone(entry);
  const path = container.split(".");
  let target = envelope;
  for (let index = 0; index < path.length - 1; index++) target = target[path[index]];
  delete target[path.at(-1)];

  const values = Array.isArray(content) ? content : [content];
  if (values.length === 0) return [];
  const form = Array.isArray(content) ? "array" : "string";
  return values.map((value, index) => ({
    partType: forcedPartType || partType(value),
    partIndex: index,
    payload: {
      entry: envelope,
      part: {
        container,
        form,
        count: values.length,
        value: jsonClone(value),
      },
    },
  }));
}

function projectableParts(entry) {
  if (entry?.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message;
    if (Object.prototype.hasOwnProperty.call(message, "content") &&
        (typeof message.content === "string" || Array.isArray(message.content))) {
      const forcedPartType = message.role === "toolResult" ? "toolResult" : "";
      const parts = splitContentEntry(entry, "message.content", message.content, forcedPartType);
      if (parts.length > 0) return parts;
    }
  }

  if (entry?.type === "custom_message" &&
      Object.prototype.hasOwnProperty.call(entry, "content") &&
      (typeof entry.content === "string" || Array.isArray(entry.content))) {
    const parts = splitContentEntry(entry, "content", entry.content, "");
    if (parts.length > 0) return parts;
  }

  return [{
    partType: "opaque",
    partIndex: 0,
    payload: { entry: jsonClone(entry) },
  }];
}

function setContainerValue(target, container, value) {
  const path = String(container || "").split(".");
  let cursor = target;
  for (let index = 0; index < path.length - 1; index++) {
    if (!cursor || typeof cursor !== "object") throw new Error("RecordedEvent part container is not reconstructable");
    cursor = cursor[path[index]];
  }
  if (!cursor || typeof cursor !== "object" || !path.at(-1)) {
    throw new Error("RecordedEvent part container is not reconstructable");
  }
  cursor[path.at(-1)] = value;
}

/** Reconstruct one original Pi entry from its complete, ordered RecordedEvent projection. */
export function reconstructPiEntry(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("Pi entry reconstruction requires events");
  const first = events[0];
  const entryId = first?.source?.entryId;
  if (!entryId || !events.every((event) => event?.source?.entryId === entryId)) {
    throw new Error("Pi entry reconstruction requires one source entry");
  }

  const parts = events.map((event) => event?.payload?.part).filter(Boolean);
  if (parts.length === 0) {
    if (events.length !== 1 || !first?.payload?.entry) throw new Error("opaque Pi entry is not reconstructable");
    return jsonClone(first.payload.entry);
  }
  if (parts.length !== events.length) throw new Error("mixed RecordedEvent part group is not reconstructable");

  const { container, form, count } = parts[0];
  if (typeof container !== "string" || !["array", "string"].includes(form) ||
      !Number.isSafeInteger(count) || count < 1) {
    throw new Error("RecordedEvent part metadata is not reconstructable");
  }
  if (!parts.every((part) => part.container === container && part.form === form && part.count === count)) {
    throw new Error("RecordedEvent part metadata is inconsistent");
  }
  if (parts.length !== count) throw new Error("RecordedEvent entry is split outside the reconstruction range");

  const values = new Array(count);
  for (const event of events) {
    const index = event?.source?.partIndex;
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || values[index] !== undefined) {
      throw new Error("RecordedEvent part index is not reconstructable");
    }
    values[index] = jsonClone(event.payload.part.value);
  }
  if (values.some((value) => value === undefined)) throw new Error("RecordedEvent entry is missing a content part");

  const entry = jsonClone(first.payload.entry);
  setContainerValue(entry, container, form === "string" ? values[0] : values);
  return entry;
}

function entryRole(entry) {
  return entry?.type === "message" && typeof entry.message?.role === "string"
    ? entry.message.role
    : "";
}

function turnId(sessionId, entryId) {
  return stableId("turn", [TURN_DOMAIN, RECORDED_EVENT_IDENTITY_VERSION, sessionId, entryId]);
}

function stepId(sessionId, entryId) {
  return stableId("step", [STEP_DOMAIN, RECORDED_EVENT_IDENTITY_VERSION, sessionId, entryId]);
}

export function recordedEventId(source) {
  if (!source || typeof source !== "object") throw new TypeError("recordedEventId requires a source");
  if (source.system === "pi") {
    if (!Number.isSafeInteger(source.partIndex) || source.partIndex < 0) {
      throw new TypeError("source.partIndex must be a non-negative safe integer");
    }
    return stableId("evt", [
      EVENT_DOMAIN,
      RECORDED_EVENT_IDENTITY_VERSION,
      "pi",
      requireString(source.sessionId, "source.sessionId"),
      requireString(source.entryId, "source.entryId"),
      requireString(source.partType, "source.partType"),
      source.partIndex,
    ]);
  }
  if (source.system === "pi-openviking") {
    return stableId("evt", [
      EVENT_DOMAIN,
      RECORDED_EVENT_IDENTITY_VERSION,
      source.system,
      requireString(source.sourceId, "source.sourceId"),
      requireString(source.sourceType, "source.sourceType"),
    ]);
  }
  throw new TypeError("recordedEventId source system is not supported");
}

export function contentHash(payload) {
  return `sha256:${sha256Hex(canonicalJsonBytes(payload))}`;
}

export function buildProducedRecordedEvent({ system, sourceId, sourceType, parentId = null, occurredAt, payload }) {
  const source = {
    system,
    sourceId: requireString(sourceId, "sourceId"),
    sourceType: requireString(sourceType, "sourceType"),
  };
  const eventPayload = jsonClone(payload);
  if (parentId !== null) requireString(parentId, "parentId");
  requireString(occurredAt, "occurredAt");
  return {
    schemaVersion: RECORDED_EVENT_SCHEMA_VERSION,
    eventId: recordedEventId(source),
    parentId,
    contentHash: contentHash(eventPayload),
    occurredAt,
    source,
    payload: eventPayload,
  };
}

export function recordedEventBytes(event) {
  return canonicalJsonBytes(event);
}

export function projectPiEntries(sessionId, entries) {
  requireString(sessionId, "sessionId");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");

  const events = [];
  const lastEventByEntry = new Map();
  const seenEntries = new Set();
  const contextByEntry = new Map();

  for (const rawEntry of entries) {
    const entry = jsonClone(rawEntry);
    const entryId = requireString(entry?.id, "entry.id");
    const entryType = requireString(entry?.type, "entry.type");
    const occurredAt = requireString(entry?.timestamp, "entry.timestamp");
    const parentEntryId = entry.parentId == null ? null : requireString(entry.parentId, "entry.parentId");

    if (seenEntries.has(entryId)) throw new Error(`duplicate Pi entry id: ${entryId}`);
    if (parentEntryId !== null && !lastEventByEntry.has(parentEntryId)) {
      throw new Error(`Pi entry parent must precede child: ${entryId} -> ${parentEntryId}`);
    }
    seenEntries.add(entryId);

    const inherited = parentEntryId === null ? {} : contextByEntry.get(parentEntryId);
    let currentTurnId = inherited?.turnId;
    let currentStepId = inherited?.stepId;
    const role = entryRole(entry);
    if (role === "user") {
      currentTurnId = turnId(sessionId, entryId);
      currentStepId = undefined;
    } else if (role === "assistant") {
      currentStepId = stepId(sessionId, entryId);
    }

    const parts = projectableParts(entry);
    let parentId = parentEntryId === null ? null : lastEventByEntry.get(parentEntryId);
    for (const part of parts) {
      const source = {
        system: "pi",
        sessionId,
        entryId,
        parentEntryId,
        entryType,
        partType: part.partType,
        partIndex: part.partIndex,
      };
      const event = {
        schemaVersion: RECORDED_EVENT_SCHEMA_VERSION,
        eventId: recordedEventId(source),
        parentId,
        contentHash: contentHash(part.payload),
        occurredAt,
        source,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...((role === "assistant" || role === "toolResult") && currentStepId
          ? { stepId: currentStepId }
          : {}),
        payload: part.payload,
      };
      events.push(event);
      parentId = event.eventId;
    }
    lastEventByEntry.set(entryId, parentId);
    contextByEntry.set(entryId, { turnId: currentTurnId, stepId: currentStepId });
  }

  return events;
}
