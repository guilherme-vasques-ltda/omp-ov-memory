export interface SyncAck {
  acknowledgedLeaves: string[];
}

export interface SyncAckTarget {
  endpoint: string;
  account: string;
  user: string;
}

export const SYNC_ACK_IDENTITY_VERSION: 1;
export function syncAckFileKey(target: SyncAckTarget, sessionId: string): string;

export function normalizeSyncAck(value: unknown): SyncAck;
export function isAncestorEntry(ancestorId: string, descendantId: string, parentById: Map<string, string | null>): boolean;
export function isEntryAcknowledged(ack: SyncAck, entryId: string, parentById: Map<string, string | null>): boolean;
export function advanceSyncAck(ack: SyncAck, entryId: string, parentById: Map<string, string | null>): SyncAck;
export function readSyncAck(path: string): Promise<SyncAck>;
export function writeSyncAck(path: string, ack: SyncAck): Promise<SyncAck>;
