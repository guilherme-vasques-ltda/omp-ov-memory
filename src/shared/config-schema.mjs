export const EXTENSION_CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  syncTurns: true,
  archive: Object.freeze({
    chunkTokenBudget: 50_000,
    rawTailTokenBudget: 20_000,
  }),
  takeover: Object.freeze({
    enabled: true,
    contextTokenThreshold: 0,
    checkpointTokenBudget: 16_000,
  }),
  recallTokenBudget: 2_000,
  recallMaxContentChars: 500,
  recallPreferAbstract: true,
  recallLimit: 10,
  recallQueryExpansion: "auto",
  scoreThreshold: 0.35,
  minQueryLength: 3,
  profileTokenBudget: 10_000,
  sessionScopedMemory: true,
  workspacePeer: true,
  recallPeerScope: "all",
  bypassPatterns: Object.freeze([]),
  logLevel: "error",
});

const TOP_LEVEL_FIELDS = new Set([
  ...Object.keys(EXTENSION_CONFIG_DEFAULTS),
  "managedServer",
]);
const ARCHIVE_FIELDS = new Set(Object.keys(EXTENSION_CONFIG_DEFAULTS.archive));
const TAKEOVER_FIELDS = new Set(Object.keys(EXTENSION_CONFIG_DEFAULTS.takeover));
const MANAGED_SERVER_FIELDS = new Set(["proxy"]);
const PROXY_FIELDS = new Set(["http", "https", "noProxy"]);

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value;
}

function rejectUnknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`未知配置字段：${path ? `${path}.` : ""}${key}`);
  }
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`);
  return value;
}

function number(value, path, fallback, { min, max, integer = true }) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${path} 必须是${integer ? "整数" : "有限数字"}`);
  }
  if (value < min || value > max) throw new Error(`${path} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function enumeration(value, path, fallback, values) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw new Error(`${path} 必须是 ${values.join("、")} 之一`);
  return value;
}

function stringArray(value, path, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${path} 必须是字符串数组`);
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== "string") throw new Error(`${path}.${index} 必须是字符串`);
  }
  return [...value];
}

function validateManagedServer(root) {
  if (root.managedServer === undefined) return;
  const managed = object(root.managedServer, "managedServer");
  rejectUnknown(managed, MANAGED_SERVER_FIELDS, "managedServer");
  if (managed.proxy === undefined) return;
  const proxy = object(managed.proxy, "managedServer.proxy");
  rejectUnknown(proxy, PROXY_FIELDS, "managedServer.proxy");
  for (const field of PROXY_FIELDS) {
    if (proxy[field] !== undefined && typeof proxy[field] !== "string") {
      throw new Error(`managedServer.proxy.${field} 必须是字符串`);
    }
  }
}

export function validateExtensionConfig(value) {
  const root = object(value, "配置");
  rejectUnknown(root, TOP_LEVEL_FIELDS, "");
  validateManagedServer(root);

  const archiveInput = root.archive === undefined ? {} : object(root.archive, "archive");
  rejectUnknown(archiveInput, ARCHIVE_FIELDS, "archive");
  const takeoverInput = root.takeover === undefined ? {} : object(root.takeover, "takeover");
  rejectUnknown(takeoverInput, TAKEOVER_FIELDS, "takeover");

  return {
    enabled: boolean(root.enabled, "enabled", EXTENSION_CONFIG_DEFAULTS.enabled),
    syncTurns: boolean(root.syncTurns, "syncTurns", EXTENSION_CONFIG_DEFAULTS.syncTurns),
    archive: {
      chunkTokenBudget: number(archiveInput.chunkTokenBudget, "archive.chunkTokenBudget", EXTENSION_CONFIG_DEFAULTS.archive.chunkTokenBudget, { min: 1_000, max: 1_000_000 }),
      rawTailTokenBudget: number(archiveInput.rawTailTokenBudget, "archive.rawTailTokenBudget", EXTENSION_CONFIG_DEFAULTS.archive.rawTailTokenBudget, { min: 1_000, max: 1_000_000 }),
    },
    takeover: {
      enabled: boolean(takeoverInput.enabled, "takeover.enabled", EXTENSION_CONFIG_DEFAULTS.takeover.enabled),
      contextTokenThreshold: number(takeoverInput.contextTokenThreshold, "takeover.contextTokenThreshold", EXTENSION_CONFIG_DEFAULTS.takeover.contextTokenThreshold, { min: 0, max: 1_000_000 }),
      checkpointTokenBudget: number(takeoverInput.checkpointTokenBudget, "takeover.checkpointTokenBudget", EXTENSION_CONFIG_DEFAULTS.takeover.checkpointTokenBudget, { min: 100, max: 100_000 }),
    },
    recallTokenBudget: number(root.recallTokenBudget, "recallTokenBudget", EXTENSION_CONFIG_DEFAULTS.recallTokenBudget, { min: 200, max: 32_000 }),
    recallMaxContentChars: number(root.recallMaxContentChars, "recallMaxContentChars", EXTENSION_CONFIG_DEFAULTS.recallMaxContentChars, { min: 100, max: 5_000 }),
    recallPreferAbstract: boolean(root.recallPreferAbstract, "recallPreferAbstract", EXTENSION_CONFIG_DEFAULTS.recallPreferAbstract),
    recallLimit: number(root.recallLimit, "recallLimit", EXTENSION_CONFIG_DEFAULTS.recallLimit, { min: 1, max: 50 }),
    recallQueryExpansion: enumeration(root.recallQueryExpansion, "recallQueryExpansion", EXTENSION_CONFIG_DEFAULTS.recallQueryExpansion, ["auto", "off"]),
    scoreThreshold: number(root.scoreThreshold, "scoreThreshold", EXTENSION_CONFIG_DEFAULTS.scoreThreshold, { min: 0, max: 1, integer: false }),
    minQueryLength: number(root.minQueryLength, "minQueryLength", EXTENSION_CONFIG_DEFAULTS.minQueryLength, { min: 1, max: 64 }),
    profileTokenBudget: number(root.profileTokenBudget, "profileTokenBudget", EXTENSION_CONFIG_DEFAULTS.profileTokenBudget, { min: 500, max: 50_000 }),
    sessionScopedMemory: boolean(root.sessionScopedMemory, "sessionScopedMemory", EXTENSION_CONFIG_DEFAULTS.sessionScopedMemory),
    workspacePeer: boolean(root.workspacePeer, "workspacePeer", EXTENSION_CONFIG_DEFAULTS.workspacePeer),
    recallPeerScope: enumeration(root.recallPeerScope, "recallPeerScope", EXTENSION_CONFIG_DEFAULTS.recallPeerScope, ["actor", "all"]),
    bypassPatterns: stringArray(root.bypassPatterns, "bypassPatterns", EXTENSION_CONFIG_DEFAULTS.bypassPatterns),
    logLevel: enumeration(root.logLevel, "logLevel", EXTENSION_CONFIG_DEFAULTS.logLevel, ["silent", "error", "info"]),
  };
}
