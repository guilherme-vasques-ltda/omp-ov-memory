import type { Observation } from "./observe.mjs";

export function buildRecallBlock(
  fetchJSON: (path: string, init?: any, options?: any) => Promise<{ ok: boolean; status?: number; result?: any; error?: any }>,
  cfg: Record<string, any>,
  query: string,
  options?: {
    actorPeerId?: string;
    sessionId?: string;
    /** 已绑定的记忆空间名；缺省时 viking://user/<reserved> 不展开，不做推断。 */
    userSpace?: string;
    observation?: Observation;
  },
): Promise<string | null>;
