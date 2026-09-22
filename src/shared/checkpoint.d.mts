import type { ArchiveManifestV1 } from "./archive.mjs";
import type { PiRecordedEventV1, ProducedRecordedEventV1 } from "./recorded-event.mjs";

export const CHECKPOINT_SCHEMA_VERSION: 2;
export const CHECKPOINT_IDENTITY_VERSION: 2;
export const CHECKPOINT_PROMPT_VERSION: "checkpoint-v2";
export const CHECKPOINT_MODEL: "openviking/session-working-memory-v2";
export const TEMPLATE_GUIDANCE: Map<string, string>;
export const CHECKPOINT_MAX_ATTEMPTS: 3;

export interface CheckpointV2 {
  checkpointId: string;
  sourceArchiveId: string;
  sourceArchiveHash: string;
  narrative: string;
  model: string;
  promptVersion: string;
}

export interface CheckpointRequestV2 {
  schemaVersion: 2;
  type: "checkpoint-request";
  taskId: string;
  archiveId: string;
  archiveHash: string;
  previousCheckpointId: string | null;
  attempt: number;
  submittedAt: string;
  model: string;
  promptVersion: string;
}

export interface CheckpointFailureV2 {
  schemaVersion: 2;
  type: "checkpoint-failure";
  taskId: string;
  archiveId: string;
  archiveHash: string;
  attempt: number;
  failedAt: string;
  error: {
    errorClass: "protocol";
    errorCode: "empty_output" | "invalid_output" | "task_cancelled" | "task_failed";
    message: string;
  };
}

export interface CheckpointMediaInput {
  eventId: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  abstract: string;
}

export function checkpointId(manifest: ArchiveManifestV1): string;
export function checkpointTaskId(manifest: ArchiveManifestV1, previousCheckpointId: string | null, attempt: number): string;
export function checkpointEventId(manifest: ArchiveManifestV1): string;
export function checkpointEventIdFor(checkpointId: string): string;
export function checkpointRequestEventId(manifest: ArchiveManifestV1, previousCheckpointId: string | null, attempt: number): string;
export function checkpointFailureEventId(manifest: ArchiveManifestV1, previousCheckpointId: string | null, attempt: number): string;
export function validateCheckpointOverview(overview: string): string;
export function checkpointFromOverview(manifest: ArchiveManifestV1, overview: string): CheckpointV2;
export function buildCheckpointRequestEvent(input: { manifest: ArchiveManifestV1; previousCheckpointId?: string | null; attempt: number; submittedAt: string }): ProducedRecordedEventV1;
export function buildCheckpointFailureEvent(input: { requestEvent: ProducedRecordedEventV1; failedAt: string; error: { errorClass?: string; errorCode?: string; message?: string } }): ProducedRecordedEventV1;
export function buildCheckpointEvent(input: { manifest: ArchiveManifestV1; requestEvent: ProducedRecordedEventV1; overview: string; completedAt: string }): ProducedRecordedEventV1;
export function parseCheckpointRequestEvent(event: ProducedRecordedEventV1): CheckpointRequestV2;
export function parseCheckpointFailureEvent(event: ProducedRecordedEventV1): CheckpointFailureV2;
export function parseCheckpointEvent(event: ProducedRecordedEventV1, manifest: ArchiveManifestV1): CheckpointV2;
export function parseCheckpointEventById(event: ProducedRecordedEventV1, expectedCheckpointId: string): CheckpointV2;
export function renderCheckpointBlock(checkpoint: CheckpointV2): string;
export function embeddedImages(events: PiRecordedEventV1[]): Array<{ eventId: string; mimeType: string; bytes: Buffer; contentHash: string }>;
export function renderCheckpointInput(manifest: ArchiveManifestV1, events: PiRecordedEventV1[], previousCheckpoint: CheckpointV2 | null, media?: CheckpointMediaInput[]): string;
