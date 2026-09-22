export type ObservationState = "disabled" | "ready" | "incomplete";

export interface ObservationStatus {
  state: ObservationState;
  reason: string;
  run: string | null;
  accepted: number;
  dropped: number;
}

export interface Observation {
  emit(stage: string, ...values: unknown[]): void;
  begin(stage: string, ...values: unknown[]): number;
  end(stage: string, op: number, ...values: unknown[]): void;
  bindSession(piSessionId: string | null | undefined): void;
  createProducer(): Observation;
  release(): void;
  abandon(): void;
  getStatus(): ObservationStatus;
  beginDrainDeadline(timeoutMs: number): number;
  finishRemaining(deadline: number): Promise<void>;
  finish(timeoutMs?: number): Promise<void>;
}

export const OBSERVATION_SCHEMA_VERSION: 1;
export const OBSERVATION_IDENTITY_VERSION: 1;
export const OBSERVATION_SESSION_DOMAIN: string;
export const OBSERVATION_QUEUE_CAPACITY: number;
export const OBSERVATION_STAGE_REGISTRY: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const observation: Observation;

export function createObservation(options?: {
  env?: Record<string, string | undefined>;
  autoFinalize?: boolean;
  queueCapacity?: number;
  dependencies?: Record<string, unknown>;
}): Observation;
export function observationSessionHash(piSessionId: string): string;
export function validateObservationRecord(record: unknown): { ok: boolean; reason: string | null };
