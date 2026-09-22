import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export function contextTokenWeight(value: unknown): number;
export function eventTokenWeight(event: PiRecordedEventV1): number;
