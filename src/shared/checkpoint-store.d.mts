import type { OVClient } from "../client.js";
import type { ArchiveManager } from "./archive-store.mjs";
import type { ArchiveManifestV1 } from "./archive.mjs";
import type { CheckpointProcessResult } from "./checkpoint-processor.mjs";
import type { Observation } from "./observe.mjs";
import type { RecordedEventAdapter } from "./recorded-event-adapter.mjs";

export interface CheckpointStatus {
  mode: "caught_up" | "processing" | "lagging" | "failed";
  consumed: number;
  pending: number;
  backlogTokens: number;
  lastCheckpointId: string | null;
  currentArchiveId: string | null;
  lastFailure: string | null;
}

export interface CheckpointArchiveDescriptor {
  manifest: ArchiveManifestV1;
  tokenCount: number;
}

export interface CheckpointProcessor {
  advance(input: Record<string, unknown>): Promise<CheckpointProcessResult>;
  cleanup(taskId: string): Promise<boolean>;
}

export class CheckpointManager {
  constructor(client: OVClient, options: {
    adapter: RecordedEventAdapter;
    archiveManager: ArchiveManager;
    processor?: CheckpointProcessor;
    observation?: Observation;
    notify?: (message: string, level: "info" | "warning") => void;
    onStateChange?: (status: CheckpointStatus) => void;
    pollIntervalMs?: number;
    taskTimeoutMs?: number;
    now?: () => string;
  });
  readonly status: CheckpointStatus;
  schedule(
    sessionId: string,
    archives: CheckpointArchiveDescriptor[],
    archiveChains?: CheckpointArchiveDescriptor[][],
  ): Promise<void>;
  refresh(): Promise<void>;
  observeFinalState(): void;
  stop(): Promise<void>;
}
