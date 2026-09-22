import { createHash } from "node:crypto";

function identity(message: any): string {
  return createHash("sha256").update(JSON.stringify([message.role, message.content, message.toolCallId ?? null])).digest("hex");
}

/** Never accept an optimization that removes or reorders the configured raw turn tail. */
export function preservesRecentTurns(original: any[], replacement: any[], keepRecentTurns: number): boolean {
  const starts = original.map((message, index) => message.role === "user" ? index : -1).filter(index => index >= 0);
  if (!starts.length || keepRecentTurns <= 0) return true;
  const start = starts[Math.max(0, starts.length - keepRecentTurns)]!;
  const required = original.slice(start).map(identity);
  const actual = replacement.map(identity);
  for (let offset = 0; offset + required.length <= actual.length; offset++) {
    if (required.every((value, index) => value === actual[offset + index])) return true;
  }
  return false;
}

export function compactionKeepsRecentTurns(branch: any[], firstKeptEntryId: string, keepRecentTurns: number): boolean {
  const starts = branch.map((entry, index) => entry?.message?.role === "user" ? index : -1).filter(index => index >= 0);
  if (!starts.length || keepRecentTurns <= 0) return true;
  const boundary = branch.findIndex(entry => entry.id === firstKeptEntryId);
  return boundary >= 0 && boundary <= starts[Math.max(0, starts.length - keepRecentTurns)]!;
}
