import { createHash } from "node:crypto";
import { openVikingOAuthProvider } from "./openviking-oauth.mjs";

export const SERVER_STATE_VERSION = 1;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function serverEndpoint(config) {
  const server = object(config.server);
  let host = text(server.host) || "127.0.0.1";
  const port = Number.isFinite(Number(server.port)) ? Number(server.port) : 1933;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

function credentialKind(vlm) {
  const oauth = openVikingOAuthProvider(text(vlm.provider));
  if (oauth) return oauth.label;
  if (text(vlm.api_key).trim()) return "API key configured";
  return "not configured";
}

export function summarizeServerConfig(configValue) {
  const config = object(configValue);
  const embedding = object(object(config.embedding).dense);
  const vlm = object(config.vlm);
  const storage = object(config.storage);
  return {
    endpoint: serverEndpoint(config),
    embedding: {
      provider: text(embedding.provider),
      model: text(embedding.model),
      dimension: embedding.dimension === undefined ? "" : text(embedding.dimension),
    },
    vlm: {
      provider: text(vlm.provider),
      model: text(vlm.model),
      credential: credentialKind(vlm),
    },
    storage: text(storage.workspace),
  };
}

export function configFingerprint(config) {
  return fingerprint(object(config));
}

export function proxyFingerprint(proxyValue) {
  const proxy = object(proxyValue);
  return fingerprint({
    http: text(proxy.http),
    https: text(proxy.https),
    noProxy: text(proxy.noProxy),
  });
}

export function createManagedServerState({ pid, startedAt = new Date().toISOString(), config, proxy }) {
  const summary = summarizeServerConfig(config);
  return {
    version: SERVER_STATE_VERSION,
    pid,
    startedAt,
    configFingerprint: configFingerprint(config),
    proxyFingerprint: proxyFingerprint(proxy),
    endpoint: summary.endpoint,
    embedding: summary.embedding,
    vlm: summary.vlm,
    proxy: {
      http: Boolean(proxy?.http),
      https: Boolean(proxy?.https),
    },
    storage: summary.storage,
  };
}

export function parseManagedServerState(textValue) {
  try {
    const state = JSON.parse(textValue);
    if (
      !state ||
      typeof state !== "object" ||
      state.version !== SERVER_STATE_VERSION ||
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.endpoint !== "string" ||
      typeof state.configFingerprint !== "string" ||
      typeof state.proxyFingerprint !== "string"
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}
