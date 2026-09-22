export interface PiSessionSourceResult {
  header: Record<string, unknown>;
  entries: Record<string, any>[];
  branch: Record<string, any>[];
  parentById: Map<string, string | null>;
}

export interface PiSessionSourceSnapshot {
  isPersisted(): boolean;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  hasAssistantEntry(): boolean;
  getEntries(): Record<string, any>[];
  getBranch(): Record<string, any>[];
}

export function sessionHasAssistantEntry(sessionManager: any): boolean;

export function snapshotSessionSource(sessionManager: any): PiSessionSourceSnapshot;

export function parsePiSessionJsonl(
  text: string,
  options?: { sessionId?: string; leafId?: string | null },
): PiSessionSourceResult;
