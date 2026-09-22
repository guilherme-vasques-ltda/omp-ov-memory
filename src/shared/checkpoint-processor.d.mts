import type { OVClient } from "../client.js";
import type { ArchiveManifestV1 } from "./archive.mjs";
import type { CheckpointV2 } from "./checkpoint.mjs";
import type { Observation } from "./observe.mjs";
import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export type CheckpointProcessResult =
  | { status: "processing"; taskCreatedAtMs?: number | null; error?: { errorClass: string; errorCode: string; message: string } }
  | { status: "pending"; error?: { errorClass: string; errorCode: string; message: string } }
  | { status: "failed"; error: { errorClass: string; errorCode: string; message: string } }
  | { status: "completed"; overview: string };

export class OpenVikingCheckpointProcessor {
  constructor(client: OVClient, options?: { observation?: Observation });
  advance(input: {
    taskId: string;
    manifest: ArchiveManifestV1;
    loadEvents: () => Promise<PiRecordedEventV1[] | null>;
    previousCheckpoint: CheckpointV2 | null;
  }): Promise<CheckpointProcessResult>;
  cleanup(taskId: string): Promise<boolean>;
}
