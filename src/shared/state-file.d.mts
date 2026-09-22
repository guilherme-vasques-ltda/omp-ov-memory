export function stateFileKey(
  domain: string,
  version: number,
  target: { endpoint: string; account: string; user: string },
  sessionId: string,
): string;
export function writeStateFile<T>(path: string, value: T): Promise<T>;
