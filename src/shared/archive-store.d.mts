import type { ArchiveBudgets, ArchiveDescriptor, ArchiveManifestV1 } from "./archive.mjs";
import type { ContentTransport } from "./content-objects.mjs";
import type { Observation } from "./observe.mjs";
import type { PiRecordedEventV1 } from "./recorded-event.mjs";
import type { RecordedEventAdapter } from "./recorded-event-adapter.mjs";

export interface ArchiveLocation {
  sessionRoot: string;
  shardRoot: string;
  manifestUri: string;
}

export interface ArchiveState {
  committed: number;
  lastArchiveId: string | null;
  pending: number;
  lastFailure: string | null;
}

export function archiveSessionRoot(userRoot: string, sessionId: string): string;
export function archiveStorageLocation(userRoot: string, sessionId: string, id: string): ArchiveLocation;

export class ArchiveManager {
  constructor(transport: ContentTransport, options: {
    userRoot: string;
    adapter: RecordedEventAdapter;
    budgets: ArchiveBudgets;
    observation?: Observation;
    busyRetrySignal?: AbortSignal;
  });
  readonly status: ArchiveState;
  observeFinalState(): void;
  formArchives(sessionId: string, events: PiRecordedEventV1[]): Promise<
    { planned: number; created: number; reconciled: boolean; archives: ArchiveDescriptor[] } & ArchiveState
  >;
  commit(sessionId: string, events: PiRecordedEventV1[]): Promise<{
    archiveId: string;
    branch: "already_committed" | "proof_reused" | "created" | "repaired_residue";
    manifest: ArchiveManifestV1;
  }>;
  read(sessionId: string, archiveId: string): Promise<ArchiveManifestV1>;
  expand(sessionId: string, archiveId: string): Promise<{ manifest: ArchiveManifestV1; events: PiRecordedEventV1[] }>;
}
