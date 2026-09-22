import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export interface ArchiveManifestV1 {
  schemaVersion: 1;
  type: "archive-manifest";
  sessionId: string;
  archiveId: string;
  firstEventId: string;
  lastEventId: string;
  eventCount: number;
  contentHash: string;
}

export interface ArchiveBudgets {
  chunkTokenBudget: number;
  rawTailTokenBudget: number;
}

export interface ArchivePlan {
  startIndex: number;
  endIndex: number;
}

export interface ArchiveDescriptor extends ArchivePlan {
  manifest: ArchiveManifestV1;
  tokenCount: number;
}

export class ArchiveIntegrityError extends Error {
  archiveId?: string;
}

export function archiveId(sessionId: string, firstEventId: string, lastEventId: string, eventCount: number): string;
export function archiveContentHash(events: PiRecordedEventV1[]): string;
export function buildArchiveManifest(sessionId: string, events: PiRecordedEventV1[]): ArchiveManifestV1;
export function archiveManifestBytes(manifest: ArchiveManifestV1): Buffer;
export function parseArchiveManifest(bytes: Buffer): ArchiveManifestV1;
export function planArchives(events: PiRecordedEventV1[], budgets: ArchiveBudgets): ArchivePlan[];
export function describeArchives(sessionId: string, events: PiRecordedEventV1[], budgets: ArchiveBudgets): ArchiveDescriptor[];
