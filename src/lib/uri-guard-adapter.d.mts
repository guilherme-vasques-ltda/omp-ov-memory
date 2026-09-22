import type { Observation } from "../shared/observe.mjs";

export function guardVikingUriToolCall(event: any, observation?: Observation): { block: true; reason: string } | null;
