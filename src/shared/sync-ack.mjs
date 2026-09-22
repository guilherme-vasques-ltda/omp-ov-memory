import { readFile } from "node:fs/promises";

import { stateFileKey, writeStateFile } from "./state-file.mjs";

export const SYNC_ACK_IDENTITY_VERSION = 1;
const SYNC_ACK_DOMAIN = "pi-openviking/sync-ack";

export function syncAckFileKey(target, sessionId) {
  return stateFileKey(SYNC_ACK_DOMAIN, SYNC_ACK_IDENTITY_VERSION, target, sessionId);
}

export function normalizeSyncAck(value) {
  const leaves = Array.isArray(value?.acknowledgedLeaves)
    ? value.acknowledgedLeaves.filter((leaf) => typeof leaf === "string" && leaf.length > 0)
    : [];
  return { acknowledgedLeaves: [...new Set(leaves)].sort() };
}

export function isAncestorEntry(ancestorId, descendantId, parentById) {
  let current = descendantId;
  const visited = new Set();
  while (typeof current === "string") {
    if (current === ancestorId) return true;
    if (visited.has(current)) throw new Error(`Pi entry parent cycle at: ${current}`);
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}

export function isEntryAcknowledged(ack, entryId, parentById) {
  return normalizeSyncAck(ack).acknowledgedLeaves
    .some((leaf) => isAncestorEntry(entryId, leaf, parentById));
}

export function advanceSyncAck(ack, entryId, parentById) {
  if (!parentById.has(entryId)) throw new Error(`cannot acknowledge unknown Pi entry: ${entryId}`);
  const current = normalizeSyncAck(ack).acknowledgedLeaves;
  if (current.some((leaf) => isAncestorEntry(entryId, leaf, parentById))) {
    return { acknowledgedLeaves: current };
  }
  const leaves = current.filter((leaf) => !isAncestorEntry(leaf, entryId, parentById));
  leaves.push(entryId);
  return normalizeSyncAck({ acknowledgedLeaves: leaves });
}

export async function readSyncAck(path) {
  try {
    return normalizeSyncAck(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { acknowledgedLeaves: [] };
    throw new Error(`SyncAck is invalid: ${error?.message || String(error)}`);
  }
}

export async function writeSyncAck(path, ack) {
  return writeStateFile(path, normalizeSyncAck(ack));
}
