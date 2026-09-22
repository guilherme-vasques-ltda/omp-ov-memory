import type { ArchiveDescriptor } from "./archive.mjs";
import type { CheckpointV2 } from "./checkpoint.mjs";
import type { Observation } from "./observe.mjs";
import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export interface ActiveContextV1 {
  checkpointId: string;
  rawTailStartEventId: string;
}

export interface TaskModelCapacity {
  contextWindow: number;
  maxTokens: number;
}

export interface TakeoverPolicy {
  enabled: boolean;
  contextTokenThreshold: number;
  checkpointTokenBudget?: number;
}

/** 单一判定结果：可接管，或说明为什么还不能接管。 */
export type ActiveContextEligibility =
  | "eligible"
  | "checkpoint_over_budget"
  | "no_context"
  | "facts_unavailable"
  | "capacity_unknown"
  | "capacity_mismatch"
  | "takeover_disabled";

export interface ActiveContextStatus {
  checkpointId: string | null;
  rawTailStartEventId: string | null;
  rawTailEvents: number;
  eligibility: ActiveContextEligibility;
  capacityTokens: number | null;
  reserveTokens: number | null;
  usableTokens: number | null;
  payloadTokens: number | null;
  headroomTokens: number | null;
  lastFailure: string | null;
}

export type ActiveContextSegment =
  | { kind: "system" | "checkpoint"; text: string }
  | { kind: "anchor" | "raw-tail"; events: PiRecordedEventV1[] };

export interface ActiveContextPayload {
  segments: ActiveContextSegment[];
  tokens: { system: number; tools: number; checkpoint: number; anchor: number; rawTail: number; payload: number };
}

export interface EligibilityVerdict {
  eligibility: ActiveContextEligibility;
  capacityTokens: number | null;
  reserveTokens: number | null;
  usableTokens: number | null;
  payloadTokens: number | null;
  headroomTokens: number | null;
}

export interface ActiveContextUpdateInput {
  branchEvents?: PiRecordedEventV1[];
  archives?: ArchiveDescriptor[];
  lastCheckpointId?: string | null;
  capacity?: TaskModelCapacity | null;
  systemPrompt?: string;
  toolDefinitions?: string;
  factsAvailable?: boolean;
}

export function activeContextFileKey(
  target: { endpoint: string; account: string; user: string },
  sessionId: string,
): string;
export function normalizeActiveContext(value: unknown): ActiveContextV1 | null;
export function readActiveContext(path: string): Promise<ActiveContextV1 | null>;
export function writeActiveContext(path: string, context: ActiveContextV1): Promise<ActiveContextV1>;
export function clearActiveContext(path: string): Promise<void>;
export function selectActiveContext(
  branchEvents: PiRecordedEventV1[],
  archives: ArchiveDescriptor[],
  lastCheckpointId: string | null,
): ActiveContextV1 | null;
export function activeContextOnBranch(context: ActiveContextV1 | null, branchEvents: PiRecordedEventV1[]): boolean;
export function anchorEvents(branchEvents: PiRecordedEventV1[], rawTailStartEventId: string): PiRecordedEventV1[];
export function materializeActiveContext(input: {
  context: ActiveContextV1;
  checkpoint: CheckpointV2;
  branchEvents: PiRecordedEventV1[];
  systemPrompt?: string;
  toolDefinitions?: string;
}): ActiveContextPayload;
export function payloadSegment(payload: ActiveContextPayload | null, kind: string): ActiveContextSegment | null;
export function renderActiveContextMessages(payload: ActiveContextPayload): any[];
export function renderCompactionPointer(archives: Array<{ manifest: { archiveId: string; eventCount: number } }>): string;
export function evaluateEligibility(input: {
  capacity: TaskModelCapacity | null;
  takeover: TakeoverPolicy;
  payloadTokens: number | null;
  checkpointTokens: number | null;
}): EligibilityVerdict;
export function evaluateTakeoverTrigger(input: {
  enabled: boolean;
  eligibility: ActiveContextEligibility;
  currentCheckpointId: string | null;
  nextCheckpointId?: string | null;
  appliedCheckpointId: string | null;
  piUsageTokens: number | null;
  payloadTokens: number | null;
  highWaterTokens: number | null;
  activeHighWaterTokens?: number | null;
}): {
  render: boolean;
  allowAdvance: boolean;
  epochActive: boolean;
  usageTokens: number | null;
  highWaterTokens: number | null;
};

export class ActiveContextManager {
  constructor(options: {
    path: string | null;
    adapter: { readEvent(sessionId: string, eventId: string): Promise<{ event: any; bytes: Buffer }> };
    takeover?: TakeoverPolicy;
    observation?: Observation;
  });
  readonly status: ActiveContextStatus;
  readonly current: ActiveContextV1 | null;
  observeFinalState(): void;
  update(sessionId: string, input?: ActiveContextUpdateInput): Promise<ActiveContextStatus>;
  materialize(
    branchEvents: PiRecordedEventV1[],
    options?: { systemPrompt?: string; toolDefinitions?: string },
  ): Promise<ActiveContextPayload | null>;
  takeoverMessages(
    branchEvents: PiRecordedEventV1[],
    options?: {
      archives?: ArchiveDescriptor[];
      lastCheckpointId?: string | null;
      systemPrompt?: string;
      toolDefinitions?: string;
      capacity?: TaskModelCapacity | null;
      factsAvailable?: boolean;
      allowAdvance?: boolean;
      advanceHighWaterTokens?: number | null;
    },
  ): Promise<any[] | null>;
  compaction(branchEvents: PiRecordedEventV1[], tokensBefore: number): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details: {
      schemaVersion: 1;
      type: "openviking-active-context";
      checkpointId: string;
      checkpointHash: string | null;
      sourceArchiveId: string;
      sourceArchiveHash: string;
      rawTailStartEventId: string;
    };
  } | null>;
}
