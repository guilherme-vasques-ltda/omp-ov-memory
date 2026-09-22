export const BATCH_MAX_OPERATIONS: 128;
export const BATCH_MAX_FILE_BYTES: number;
export const BATCH_MAX_TOTAL_BYTES: number;

export type ContentPrecondition =
  | { kind: "create_if_absent" }
  | { kind: "replace_if_hash"; base_hash: string };

export const CREATE_IF_ABSENT: { kind: "create_if_absent" };
export function replaceIfHash(baseHash: string): { kind: "replace_if_hash"; base_hash: string };

export interface ContentBatchWriteRequest {
  root_uri: string;
  operations: Array<{ uri: string; content_base64: string; precondition: ContentPrecondition }>;
  wait: false;
}

export interface ContentTransport {
  statUri(uri: string): Promise<{ ok: boolean; exists: boolean; isDir: boolean; status?: number; error?: unknown }>;
  mkdirUri(uri: string): Promise<{ ok: boolean; status?: number; error?: unknown }>;
  batchWrite(request: ContentBatchWriteRequest): Promise<{ ok: boolean; result?: unknown; status?: number; error?: unknown }>;
  downloadBytes(uri: string): Promise<{ ok: boolean; bytes: Buffer | null; status?: number; error?: unknown }>;
}

export interface ContentObject {
  uri: string;
  bytes: Buffer;
  precondition?: ContentPrecondition;
}

export interface AcceptedContentResult {
  created: Set<string>;
  updated: Set<string>;
  unchanged: Set<string>;
}

export class ContentConflictError extends Error {
  uri: string;
}
export class ContentBusyError extends Error {
  uri: string;
  retryable: true;
}
export class ContentWriteError extends Error {
  status?: number;
  error?: unknown;
}
export const BUSY_RETRY_DELAYS_MS: readonly number[];
export function withBusyRetry<T>(
  operation: () => Promise<T>,
  options?: {
    onRetry?: (error: ContentBusyError, attempt: number) => void;
    delaysMs?: readonly number[];
    signal?: AbortSignal;
  },
): Promise<T>;
export function acceptBatchResult(response: unknown, rootUri: string, expectedUris: string[]): AcceptedContentResult;
export function planContentBatches(objects: ContentObject[]): ContentObject[][];
export function ensureDirectoryChain(
  transport: ContentTransport, resourceRoot: string, directoryUri: string, created?: Set<string>,
): Promise<void>;
export function writeContentObjects(
  transport: ContentTransport, rootUri: string, objects: ContentObject[],
): Promise<AcceptedContentResult>;
