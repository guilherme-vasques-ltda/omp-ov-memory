import { relative, resolve } from "node:path";
import type { WorkspaceRoute } from "./workspace.ts";

export const CAPTURE_POLICY_VERSION = 2;
const PATH_KEYS = new Set(["path", "filePath", "file_path", "filepath", "paths", "files"]);
const SECRET_PATH = /(?:^|[/\\\s"'])(?:\.env(?:\.[a-z0-9._-]+)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.kube[/\\]+config|\.docker[/\\]+config\.json|[^/\\\s"']+\.(?:pem|p12|key)|credentials(?:\.json)?|ovcli\.conf|ov\.conf|id_(?:rsa|ed25519))(?=$|[/\\\s"'`;|&])/i;
const SECRET_TEXT = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bauthorization[\\"'\s]*[:=][\\"'\s]*(?:bearer|basic|token)\s+[^\s"'\\]+|\b[a-z0-9_]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization|database_url)["']?\s*[:=]\s*["']?[^\s"']{8,}|\b_authToken[\\"'\s]*=|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]+)/i;

/** Glob matching uses a bounded dynamic program, not user-supplied regular expressions. */
export function matchesCapturePattern(path: string, pattern: string): boolean {
  const input = path.replaceAll("\\", "/");
  const glob = pattern.replaceAll("\\", "/");
  if (input.length > 4096 || glob.length > 1024 || input.length * glob.length > 1_000_000) return false;
  let previous = new Uint8Array(input.length + 1); previous[0] = 1;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const doubleStar = char === "*" && glob[i + 1] === "*";
    if (doubleStar) i++;
    const next = new Uint8Array(input.length + 1);
    if (char === "*") next[0] = previous[0]!;
    for (let j = 1; j <= input.length; j++) {
      if (char === "*") next[j] = previous[j]! || ((doubleStar || input[j - 1] !== "/") ? next[j - 1]! : 0);
      else if (char === "?" ? input[j - 1] !== "/" : char === input[j - 1]) next[j] = previous[j - 1]!;
    }
    previous = next;
  }
  return previous[input.length] === 1 || (glob.startsWith("**/") && matchesCapturePattern(input, glob.slice(3)));
}

export interface CaptureOptions { captureMode: "allowlist" | "denylist" | "off"; captureAllowlist?: string[]; captureDenylist?: string[] }

export class CapturePolicy {
  private mode: "allowlist" | "denylist" | "off";
  private allow: string[];
  private deny: string[];
  private base: string;
  private deniedCalls = new Set<string>();
  // A policy instance is immutable. Session + version + ID avoids replay collisions.
  private entries = new Map<string, {allowed: boolean; chars: number}>();

  constructor(config: CaptureOptions, route: WorkspaceRoute) {
    this.mode = route.capture.mode ?? config.captureMode;
    this.allow = [...(config.captureAllowlist ?? []), ...route.capture.allowPaths];
    this.deny = [...(config.captureDenylist ?? []), ...route.capture.ignorePaths];
    this.base = route.root;
  }

  allows(value: unknown): boolean {
    let text: string;
    try { text = JSON.stringify(value) ?? ""; } catch { return false; }
    return this.allowsText(value, text);
  }

  private allowsText(value: unknown, text: string): boolean {
    if (this.mode === "off") return false;
    if (text.length > 1_000_000 || SECRET_TEXT.test(text) || SECRET_PATH.test(text)) return false;
    const paths: string[] = [];
    let hasCommand = false;
    let commandDenied = false;
    const walk = (item: unknown, depth: number): void => {
      if (!item || typeof item !== "object" || depth > 8) return;
      for (const [key, child] of Object.entries(item)) {
        if (["command", "cmd", "script"].includes(key) && typeof child === "string") {
          hasCommand = true;
          // Arbitrary shells have no trustworthy path schema. When path restrictions exist,
          // capture metadata via the placeholder, never infer that unknown shell input is safe.
          if (this.deny.length > 0 || this.mode === "allowlist") commandDenied = true;
        }
        if (PATH_KEYS.has(key)) {
          if (typeof child === "string") paths.push(child);
          if (Array.isArray(child)) paths.push(...child.filter((x): x is string => typeof x === "string"));
        }
        if (child && typeof child === "object") walk(child, depth + 1);
      }
    };
    walk(value, 0);
    if (commandDenied || (hasCommand && this.mode === "allowlist")) return false;
    if (paths.length > 32) return false;
    const matched = (path: string, patterns: string[]) => patterns.some(pattern =>
      matchesCapturePattern(path, pattern) || matchesCapturePattern(relative(this.base, resolve(this.base, path)), pattern));
    if (paths.some(path => SECRET_PATH.test(path) || matched(path, this.deny))) return false;
    // Unknown tools, shell commands and missing paths fail closed under allowlist.
    if (this.mode === "allowlist") return paths.length > 0 && paths.every(path => matched(path, this.allow));
    return true;
  }

  filterHook<T extends Record<string, any>>(event: T): T | null {
    const id = event.toolCallId ?? event.tool_call_id;
    if (id && this.deniedCalls.has(id)) return null;
    if (this.allows(event)) return event;
    if (typeof id === "string") this.deniedCalls.add(id);
    return null;
  }

  filterEntry(entry: any, sessionId = ""): any | null {
    const message = entry?.message;
    if (typeof message?.toolCallId === "string" && this.deniedCalls.has(message.toolCallId)) return null;
    const key = typeof entry?.id === "string" ? `${CAPTURE_POLICY_VERSION}:${sessionId.length}:${sessionId}:${entry.id}` : null;
    const cached = key === null ? undefined : this.entries.get(key);
    if (cached) return cached.allowed ? entry : null;
    const calls = Array.isArray(message?.content) ? message.content.filter((c: any) => c?.type === "toolCall") : [];
    let denied = false;
    for (const call of calls) {
      if (!this.allows(call)) { if (typeof call.id === "string") this.deniedCalls.add(call.id); denied = true; }
    }
    let text: string;
    try { text = JSON.stringify(entry) ?? ""; } catch { return null; }
    const allowed = !denied && this.allowsText(entry, text);
    if (key !== null) this.entries.set(key, {allowed, chars: text.length});
    return allowed ? entry : null;
  }

  entryChars(entry: any, sessionId = ""): number {
    this.filterEntry(entry, sessionId);
    return this.entries.get(`${CAPTURE_POLICY_VERSION}:${sessionId.length}:${sessionId}:${entry?.id}`)?.chars ?? 0;
  }
}
