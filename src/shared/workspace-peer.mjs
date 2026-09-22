import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

function resolveWorkspaceRoot(cwd) {
  const raw = String(cwd || "").trim();
  if (!raw) return "";

  const absolute = resolve(raw);
  const workspacesRoot = resolve(homedir(), "Documents", "Workspaces");
  const nestedPath = relative(workspacesRoot, absolute);
  if (!nestedPath || nestedPath === ".." || nestedPath.startsWith(`..${sep}`) || isAbsolute(nestedPath)) {
    return absolute;
  }

  return resolve(workspacesRoot, nestedPath.split(sep)[0]);
}

export function deriveWorkspacePeerId(cwd) {
  return resolveWorkspaceRoot(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function resolveEffectivePeerId({ cfg = {}, cwd = "" } = {}) {
  const explicit = String(cfg.peerId || "").trim();
  if (explicit) return { peerId: explicit, source: "explicit" };

  if (cfg.workspacePeer !== false) {
    const peerId = deriveWorkspacePeerId(cwd);
    if (peerId) return { peerId, source: "workspace" };
  }

  return { peerId: "", source: "none" };
}
