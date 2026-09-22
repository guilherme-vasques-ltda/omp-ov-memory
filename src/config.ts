// Apache-2.0; engine configuration compatibility adapted from pi-openviking 0.4.4.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_CONFIG_DEFAULTS as ENGINE_DEFAULTS, validateExtensionConfig, type ExtensionConfigV1 } from "./shared/config-schema.mjs";
import { parseJsoncObject } from "./shared/jsonc.mjs";

export interface OVConfig extends ExtensionConfigV1 {
  endpoint: string;
  apiKey: string;
  account: string;
  user: string;
  peerId: string;
  userAgent: string;
  recallLimitConfigured: boolean;
  recallQueryExpansionConfigured: boolean;
  resumeContextBudget: number;
  commitTokenThreshold: number;
  captureMode: "allowlist" | "denylist" | "off";
  captureAllowlist: string[];
  captureDenylist: string[];
  handoff: { enabled: boolean };
  takeover: ExtensionConfigV1["takeover"] & { tokenThreshold: number; keepRecentTurns: number };
  requestTimeoutMs: number;
  stateDir: string;
}

export const EXTENSION_CONFIG_DEFAULTS = Object.freeze({
  ...ENGINE_DEFAULTS,
  resumeContextBudget: 32_000,
  commitTokenThreshold: 20_000,
  captureMode: "denylist" as const,
  captureAllowlist: Object.freeze([]) as readonly string[],
  captureDenylist: Object.freeze([]) as readonly string[],
  handoff: Object.freeze({ enabled: true }),
  takeover: Object.freeze({ enabled: false, tokenThreshold: 30_000, contextTokenThreshold: 30_000, keepRecentTurns: 3, checkpointTokenBudget: 16_000 }),
  requestTimeoutMs: 2_000,
  stateDir: "~/.openviking/omp-ov-memory",
});

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXTENSION_VERSION = (() => { try { return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();
export const USER_CONFIG_PATH = join(homedir(), ".openviking", "omp-ov-memory.jsonc");
export interface LoadConfigOptions {
  /** Explicit context makes configuration portable and tests independent from real credentials. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: Record<string, unknown>;
  userConfigPath?: string;
}

function readObject(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try { return parseJsoncObject(readFileSync(path, "utf8"), "configuration"); }
  catch { throw new Error(`Invalid OpenViking configuration file: ${path}`); }
}
function str(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}
function expandPath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}
function integer(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${name} must be a string array`);
  return [...value];
}
function object(value: unknown, name: string): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, any>;
}
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
/** Reject credential-bearing remote cleartext and URL user-info before a socket opens. */
export function validateEndpoint(endpoint: string, apiKey = ""): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("OpenViking endpoint must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("OpenViking endpoint must use HTTP(S), without user-info, query or fragment");
  if (apiKey && url.protocol !== "https:" && !isLoopbackHost(url.hostname)) throw new Error("OpenViking bearer credentials require HTTPS outside loopback");
  return url.href.replace(/\/+$/, "");
}

export function loadConfigFromModuleUrl(moduleUrl: string): OVConfig {
  const directory = dirname(fileURLToPath(moduleUrl));
  return loadConfig(existsSync(join(directory, "config.json")) ? directory : dirname(directory));
}

export function loadConfig(extensionDir = packageDir, options: LoadConfigOptions = {}): OVConfig {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const packaged = readObject(join(extensionDir, "config.json"));
  const user = readObject(options.userConfigPath ?? join(home, ".openviking", "omp-ov-memory.jsonc"));
  const override = options.config ?? {};
  const source = { ...packaged, ...user, ...override };
  const archive = { ...object(packaged.archive, "archive"), ...object(user.archive, "archive"), ...object(override.archive, "archive") };
  const takeover = { ...object(packaged.takeover, "takeover"), ...object(user.takeover, "takeover"), ...object(override.takeover, "takeover") };
  const handoff = { ...EXTENSION_CONFIG_DEFAULTS.handoff, ...object(packaged.handoff, "handoff"), ...object(user.handoff, "handoff"), ...object(override.handoff, "handoff") };
  const allowed = new Set([...Object.keys(EXTENSION_CONFIG_DEFAULTS), "managedServer"]);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`Unknown plugin configuration field: ${key}`);
  for (const key of Object.keys(takeover)) if (!(key in EXTENSION_CONFIG_DEFAULTS.takeover)) throw new Error(`Unknown plugin configuration field: takeover.${key}`);
  for (const key of Object.keys(handoff)) if (key !== "enabled") throw new Error(`Unknown plugin configuration field: handoff.${key}`);
  if (typeof handoff.enabled !== "boolean") throw new Error("handoff.enabled must be a boolean");
  const engineInput: Record<string, unknown> = {};
  for (const key of Object.keys(ENGINE_DEFAULTS)) if (source[key] !== undefined) engineInput[key] = source[key];
  if (source.managedServer !== undefined) engineInput.managedServer = source.managedServer;
  engineInput.archive = archive;
  // Both names remain available, but per-layer explicit alias settings take precedence.
  let threshold: number = EXTENSION_CONFIG_DEFAULTS.takeover.tokenThreshold;
  for (const layer of [packaged, user, override]) {
    const value = object(layer.takeover, "takeover");
    if (value.tokenThreshold !== undefined) threshold = integer(value.tokenThreshold, threshold, "takeover.tokenThreshold", 0, 1_000_000);
    if (value.contextTokenThreshold !== undefined) threshold = integer(value.contextTokenThreshold, threshold, "takeover.contextTokenThreshold", 0, 1_000_000);
  }
  engineInput.takeover = { enabled: takeover.enabled ?? false, contextTokenThreshold: threshold, checkpointTokenBudget: takeover.checkpointTokenBudget ?? 16_000 };
  const engine = validateExtensionConfig(engineInput);
  const captureMode = source.captureMode ?? "denylist";
  if (!["denylist", "allowlist", "off"].includes(captureMode as string)) throw new Error("captureMode must be allowlist, denylist or off");
  const cli = readObject(expandPath(str(env.OPENVIKING_CLI_CONFIG_FILE) || join(home, ".openviking", "ovcli.conf"), home));
  const ov = readObject(expandPath(str(env.OPENVIKING_CONFIG_FILE) || join(home, ".openviking", "ov.conf"), home));
  const server = object(ov.server, "server");
  let host = str(server.host) || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  if (host.includes(":")) host = `[${host.replace(/^\[|\]$/g, "")}]`;
  const port = integer(server.port, 1933, "server.port", 1, 65535);
  const apiKey = str(env.OPENVIKING_API_KEY, env.OPENVIKING_BEARER_TOKEN, cli.api_key, server.root_api_key, server.api_key, ov.api_key);
  const endpoint = validateEndpoint(str(env.OPENVIKING_URL, env.OPENVIKING_BASE_URL, cli.url, server.url, ov.url) || `http://${host}:${port}`, apiKey);
  const stateDir = source.stateDir ?? EXTENSION_CONFIG_DEFAULTS.stateDir;
  if (typeof stateDir !== "string" || !stateDir.trim()) throw new Error("stateDir must be a nonempty path");
  const result: OVConfig = {
    ...engine,
    archive: { ...engine.archive },
    takeover: { ...engine.takeover, tokenThreshold: threshold, keepRecentTurns: integer(takeover.keepRecentTurns, 3, "takeover.keepRecentTurns", 0, 1000) },
    endpoint, apiKey,
    account: str(env.OPENVIKING_ACCOUNT, cli.account, cli.account_id, server.account, server.account_id, ov.account, ov.account_id),
    user: str(env.OPENVIKING_USER, cli.user, cli.user_id, server.user, server.user_id, ov.user, ov.user_id),
    peerId: str(env.OPENVIKING_PEER_ID, cli.actor_peer_id, cli.peer_id, server.actor_peer_id, server.peer_id, ov.actor_peer_id, ov.peer_id),
    userAgent: `omp-ov-memory/${EXTENSION_VERSION}`,
    recallLimitConfigured: [user, override].some(value => Object.hasOwn(value, "recallLimit")),
    recallQueryExpansionConfigured: [user, override].some(value => Object.hasOwn(value, "recallQueryExpansion")),
    resumeContextBudget: integer(source.resumeContextBudget, 32_000, "resumeContextBudget", 100, 1_000_000),
    commitTokenThreshold: integer(source.commitTokenThreshold, 20_000, "commitTokenThreshold", 100, 1_000_000),
    captureMode: captureMode as OVConfig["captureMode"],
    captureAllowlist: strings(source.captureAllowlist, "captureAllowlist"),
    captureDenylist: strings(source.captureDenylist, "captureDenylist"),
    handoff: { enabled: handoff.enabled },
    requestTimeoutMs: integer(source.requestTimeoutMs, 2_000, "requestTimeoutMs", 1, 2_000),
    stateDir: expandPath(stateDir, home),
  };
  if (env.OPENVIKING_WORKSPACE_PEER !== undefined) {
    if (!/^(true|false|1|0|on|off)$/i.test(env.OPENVIKING_WORKSPACE_PEER)) throw new Error("OPENVIKING_WORKSPACE_PEER must be a boolean");
    result.workspacePeer = /^(true|1|on)$/i.test(env.OPENVIKING_WORKSPACE_PEER);
  }
  if (env.OPENVIKING_RECALL_PEER_SCOPE) {
    if (!["actor", "all"].includes(env.OPENVIKING_RECALL_PEER_SCOPE)) throw new Error("OPENVIKING_RECALL_PEER_SCOPE must be actor or all");
    result.recallPeerScope = env.OPENVIKING_RECALL_PEER_SCOPE as "actor" | "all";
  }
  if (env.OPENVIKING_RECALL_LIMIT) { result.recallLimit = integer(Number(env.OPENVIKING_RECALL_LIMIT), 10, "OPENVIKING_RECALL_LIMIT", 1, 50); result.recallLimitConfigured = true; }
  if (env.OPENVIKING_RECALL_QUERY_EXPANSION) {
    if (!["auto", "off"].includes(env.OPENVIKING_RECALL_QUERY_EXPANSION)) throw new Error("OPENVIKING_RECALL_QUERY_EXPANSION must be auto or off");
    result.recallQueryExpansion = env.OPENVIKING_RECALL_QUERY_EXPANSION as "auto" | "off";
    result.recallQueryExpansionConfigured = true;
  }
  return result;
}
