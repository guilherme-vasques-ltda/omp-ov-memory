import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";

export interface WorkspaceRoute {
  cwd: string;
  root: string;
  repository: string;
  workspace: string;
  project: string;
  scopeKey: string;
  peerId: string;
  markerPath: string | null;
  capture: { mode?: "allowlist" | "denylist"; allowPaths: string[]; ignorePaths: string[] };
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64) || "default";

function names(value: unknown, key: string): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`Invalid .ov-memory.toml ${key}`);
  }
  return value;
}

function patterns(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some(p => typeof p !== "string" || !p || p.length > 1024)) {
    throw new Error("Invalid .ov-memory.toml capture patterns");
  }
  return value as string[];
}

/** Resolve once per session. No process-global 'active workspace' can redirect another agent. */
export function resolveWorkspace(cwd: string, options: { peerId?: string; workspacePeer?: boolean } = {}): WorkspaceRoute {
  const absolute = realpathSync(resolve(cwd));
  let markerPath: string | null = null;
  let gitRoot: string | null = null;
  let current = absolute;
  while (true) {
    if (!markerPath && existsSync(join(current, ".ov-memory.toml"))) markerPath = join(current, ".ov-memory.toml");
    if (!gitRoot && existsSync(join(current, ".git"))) gitRoot = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  let marker: Record<string, any> = {};
  if (markerPath) {
    if (statSync(markerPath).size > 65536) throw new Error(".ov-memory.toml exceeds 64 KiB");
    try { marker = parse(readFileSync(markerPath, "utf8")); }
    catch { throw new Error("Invalid .ov-memory.toml"); }
  }
  let repository = gitRoot ?? (markerPath ? dirname(markerPath) : absolute);
  if (gitRoot && statSync(join(gitRoot, ".git")).isFile()) {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(join(gitRoot, ".git"), "utf8"));
    if (!match) throw new Error("Invalid git worktree marker");
    const gitDir = resolve(gitRoot, match[1]!);
    const common = join(gitDir, "commondir");
    if (existsSync(common)) repository = dirname(realpathSync(resolve(gitDir, readFileSync(common, "utf8").trim())));
  }
  const root = markerPath ? dirname(markerPath) : gitRoot ?? absolute;
  const workspace = names(marker.workspace, "workspace") ?? "default";
  const strategy = marker.project_strategy ?? "repo-root";
  if (!["repo-root", "repo_root", "directory"].includes(strategy)) throw new Error("Invalid project_strategy");
  const explicitProject = names(marker.project, "project");
  const project = explicitProject ?? slug(basename(strategy === "directory" ? absolute : repository));
  // Explicit names intentionally allow sharing across clones; otherwise hash repository identity.
  const scopeKey = digest(JSON.stringify([workspace, project, explicitProject ? "named" : strategy === "directory" ? absolute : repository]));
  const capture = marker.capture ?? {};
  if (capture === null || typeof capture !== "object" || Array.isArray(capture)) throw new Error("Invalid capture table");
  if (capture.mode !== undefined && !["allowlist", "denylist"].includes(capture.mode)) throw new Error("Invalid capture mode");
  return {
    cwd: absolute, root, repository, workspace, project, scopeKey,
    peerId: options.peerId || (options.workspacePeer === false ? "" : `omp-${scopeKey}`),
    markerPath,
    capture: { mode: capture.mode, allowPaths: patterns(capture.allow_paths), ignorePaths: patterns(capture.ignore_paths) },
  };
}

export function deriveMemoryNamespace(baseUser: string, sessionId: string, route: WorkspaceRoute): string {
  return `${baseUser}/omp-ov-memory/sessions/${deriveSessionScope(sessionId, route)}`;
}

export function deriveSessionScope(sessionId: string, route: WorkspaceRoute): string {
  return digest(`${route.scopeKey}:${sessionId}`);
}

export function isBypassed(cwd: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const expr = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expr}(?:/|$)`).test(cwd);
  });
}
