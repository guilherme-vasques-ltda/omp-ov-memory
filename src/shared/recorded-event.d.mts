import type { JsonValue } from "./canonical-json.mjs";

export const RECORDED_EVENT_SCHEMA_VERSION: 1;
export const RECORDED_EVENT_IDENTITY_VERSION: 1;

export interface PiRecordedEventSourceV1 {
  system: "pi";
  sessionId: string;
  entryId: string;
  parentEntryId: string | null;
  entryType: string;
  partType: string;
  partIndex: number;
}

export interface ProducedRecordedEventSourceV1 {
  system: "pi-openviking";
  sourceId: string;
  sourceType: string;
}

export interface RecordedEventBaseV1 {
  schemaVersion: typeof RECORDED_EVENT_SCHEMA_VERSION;
  eventId: string;
  parentId: string | null;
  contentHash: string;
  occurredAt: string;
  turnId?: string;
  stepId?: string;
  payload: JsonValue;
}

export interface PiRecordedEventV1 extends RecordedEventBaseV1 {
  source: PiRecordedEventSourceV1;
}

export interface ProducedRecordedEventV1 extends RecordedEventBaseV1 {
  source: ProducedRecordedEventSourceV1;
}

export type RecordedEventV1 = PiRecordedEventV1 | ProducedRecordedEventV1;

export function recordedEventId(source: PiRecordedEventSourceV1 | ProducedRecordedEventSourceV1): string;
export function contentHash(payload: JsonValue): string;
export function recordedEventBytes(event: RecordedEventV1): Buffer;
export function buildProducedRecordedEvent(input: {
  system: ProducedRecordedEventSourceV1["system"];
  sourceId: string;
  sourceType: string;
  parentId?: string | null;
  occurredAt: string;
  payload: JsonValue;
}): ProducedRecordedEventV1;
export function reconstructPiEntry(events: PiRecordedEventV1[]): JsonValue;
export function projectPiEntries(sessionId: string, entries: JsonValue[]): PiRecordedEventV1[];
