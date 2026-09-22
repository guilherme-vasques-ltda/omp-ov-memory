export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string;
export function canonicalJsonBytes(value: JsonValue): Buffer;
