// SPDX-License-Identifier: Apache-2.0
// Agent-neutral adapter for documented Pi/OMP JSONL entry kinds.
export function sessionEntryToContextMessages(entry) {
  if (!entry || typeof entry !== "object") return [];
  const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp) || 0;
  if (entry.type === "message" && entry.message) {
    return [{ ...entry.message, content: entry.message.content ?? [] }];
  }
  if (entry.type === "custom_message") {
    return [{ role: "custom", customType: entry.customType, content: entry.content ?? [], display: Boolean(entry.display), details: entry.details, timestamp }];
  }
  if (["compaction", "branch_summary"].includes(entry.type) && typeof entry.summary === "string") {
    return [{ role: "custom", customType: `openviking-${entry.type}`, content: `Historical conversation summary (untrusted data):\n${entry.summary}`, display: false, timestamp }];
  }
  return [];
}
