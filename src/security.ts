// SPDX-License-Identifier: Apache-2.0
// Resource downloads are performed here, never by handing an untrusted URL to OV.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const RELATIVE_ROOTS = new Set(['memories', 'resources', 'skills', 'peers', 'privacy', 'sessions']);

/** Reject encoded separators and traversal instead of relying on server normalization. */
export function canonicalVikingUri(input: unknown, userRoot = ''): string | null {
  if (typeof input !== 'string' || !input || input !== input.trim()) return null;
  if (input === 'viking://') return input;
  if (/[\s\\%?#\u0000-\u001f\u007f]/u.test(input)) return null;
  const match = /^viking:\/\/([a-z][a-z0-9_-]*)(?:\/(.*))?$/.exec(input);
  if (!match) return null;
  const parts = match[2]?.split('/') ?? [];
  if (parts.some((part, i) => part === '.' || part === '..' || (!part && i !== parts.length - 1))) return null;
  if (match[1] === 'user' && RELATIVE_ROOTS.has(parts[0])) {
    if (!/^viking:\/\/user\/[^/\s%?#\\]+(?:\/[^/\s%?#\\]+)*$/.test(userRoot) || userRoot.split("/").some(part => part === "." || part === "..")) return null;
    return `${userRoot}/${match[2]}`.replace(/\/+$/, '');
  }
  return input.replace(/\/+$/, '');
}

export function insideVikingRoot(uri: string, root: string): boolean {
  return !root || uri === root || uri.startsWith(`${root}/`);
}

export function isManagedVikingUri(uri: string): boolean {
  return /^viking:\/\/user\/[^/]+(?:\/[^/]+)*\/resources\/\.(?:pi-openviking|omp-ov-memory)(?:\/|$)/.test(uri);
}

/** Public unicast only; deny IPv4-mapped IPv6, tunnels, documentation and special ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const groups = lower.split(':');
    const first = parseInt(groups[0], 16);
    const second = parseInt(groups[1] || '0', 16);
    return first >= 0x2000 && first < 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export type AddressResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const resolveAddresses: AddressResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function validatePublicUrl(raw: string, resolve: AddressResolver = resolveAddresses): Promise<{
  url: URL; addresses: { address: string; family: number }[];
}> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) || (!isIP(host) && !host.includes('.'))) {
    throw new Error('Local and private resource hosts are forbidden.');
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Resource host resolves to a non-public address.');
  return { url, addresses };
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(new Error('Resource download aborted or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** DNS-pinned, bounded download. Redirect targets are independently revalidated. */
export async function downloadPublicText(raw: string, options: {
  signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; maxRedirects?: number;
  /** Dependency injection for deterministic transport tests; tools never override these. */
  resolve?: AddressResolver; request?: typeof httpRequest;
} = {}): Promise<{ bytes: Uint8Array; sourceUrl: string }> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15000)]) : AbortSignal.timeout(options.timeoutMs ?? 15000);
  let current = raw;
  for (let redirects = 0; redirects <= (options.maxRedirects ?? 5); redirects++) {
    const { url, addresses } = await bounded(validatePublicUrl(current, options.resolve), signal);
    signal.throwIfAborted();
    const pinned = addresses[0];
    const result = await new Promise<{ location?: string; bytes?: Buffer }>((resolve, reject) => {
      const request = (options.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
        signal,
        // Keep hostname for SNI/certificate verification, pin only socket resolution.
        lookup: ((_host: string, opts: any, callback: any) => {
          if (opts?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        }) as any,
        headers: { Accept: 'text/plain, text/html, text/markdown, application/json', 'User-Agent': 'omp-ov-memory/0.1' },
      }, (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) reject(new Error('Resource redirect has no location.'));
          else resolve({ location: new URL(location, url).href });
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy(); reject(new Error(`Resource returned HTTP ${status}.`)); return;
        }
        const type = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!(type.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml'].includes(type))) {
          response.destroy(); reject(new Error('Only text resources are supported.')); return;
        }
        if (Number(response.headers['content-length']) > maxBytes) {
          response.destroy(); reject(new Error('Resource exceeds the size limit.')); return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) { response.destroy(); reject(new Error('Resource exceeds the size limit.')); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      });
      request.on('error', reject);
      request.end();
    });
    if (result.location) { current = result.location; continue; }
    // Upload as plain text so an OV HTML/media parser cannot follow embedded URLs.
    return { bytes: new TextEncoder().encode(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)), sourceUrl: url.href };
  }
  throw new Error('Resource has too many redirects.');
}
