import { existsSync, readFileSync } from "node:fs";
import { parseJsoncObject } from "./jsonc.mjs";

export const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";

const PROXY_ENV_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);


function proxyUrl(value, field, source) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") {
    throw new Error(`${source}: managedServer.proxy.${field} 必须是字符串`);
  }
  if (value.includes("\0")) {
    throw new Error(`${source}: managedServer.proxy.${field} 包含无效字符`);
  }

  const trimmed = value.trim();
  if (!trimmed) return "";

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${source}: managedServer.proxy.${field} 不是有效 URL`);
  }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${source}: managedServer.proxy.${field} 仅支持 http:// 或 https:// URL`);
  }
  return trimmed;
}

export function parseManagedServerProxy(text, source = "pi-openviking.jsonc") {
  const root = parseJsoncObject(text, source);

  const managedServer = root.managedServer;
  if (managedServer === undefined) {
    return { http: "", https: "", noProxy: DEFAULT_NO_PROXY };
  }
  if (!managedServer || typeof managedServer !== "object" || Array.isArray(managedServer)) {
    throw new Error(`${source}: managedServer 必须是对象`);
  }

  if (Object.keys(managedServer).some((key) => key !== "proxy")) {
    throw new Error(`${source}: managedServer 包含未知字段；仅支持 proxy`);
  }

  const proxy = managedServer.proxy;
  if (proxy === undefined) {
    return { http: "", https: "", noProxy: DEFAULT_NO_PROXY };
  }
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) {
    throw new Error(`${source}: managedServer.proxy 必须是对象`);
  }

  const unknown = Object.keys(proxy).filter((key) => !["http", "https", "noProxy"].includes(key));
  if (unknown.length > 0) {
    throw new Error(`${source}: managedServer.proxy 包含未知字段；仅支持 http、https、noProxy`);
  }
  if (proxy.noProxy !== undefined && typeof proxy.noProxy !== "string") {
    throw new Error(`${source}: managedServer.proxy.noProxy 必须是字符串`);
  }
  if (typeof proxy.noProxy === "string" && proxy.noProxy.includes("\0")) {
    throw new Error(`${source}: managedServer.proxy.noProxy 包含无效字符`);
  }

  return {
    http: proxyUrl(proxy.http, "http", source),
    https: proxyUrl(proxy.https, "https", source),
    noProxy: proxy.noProxy === undefined ? DEFAULT_NO_PROXY : proxy.noProxy.trim(),
  };
}

export function readManagedServerProxy(path) {
  if (!existsSync(path)) return { http: "", https: "", noProxy: DEFAULT_NO_PROXY };
  return parseManagedServerProxy(readFileSync(path, "utf8"), path);
}

export function buildManagedServerEnv(baseEnv, proxy) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (PROXY_ENV_NAMES.has(key.toUpperCase())) delete env[key];
  }

  if (proxy.http) env.HTTP_PROXY = proxy.http;
  if (proxy.https) env.HTTPS_PROXY = proxy.https;
  env.NO_PROXY = proxy.noProxy;
  return env;
}
