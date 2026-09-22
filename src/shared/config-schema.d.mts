export interface ExtensionConfigV1 {
  enabled: boolean;
  syncTurns: boolean;
  archive: { chunkTokenBudget: number; rawTailTokenBudget: number };
  takeover: { enabled: boolean; contextTokenThreshold: number; checkpointTokenBudget: number };
  recallTokenBudget: number;
  recallMaxContentChars: number;
  recallPreferAbstract: boolean;
  recallLimit: number;
  recallQueryExpansion: "auto" | "off";
  scoreThreshold: number;
  minQueryLength: number;
  profileTokenBudget: number;
  sessionScopedMemory: boolean;
  workspacePeer: boolean;
  recallPeerScope: "actor" | "all";
  bypassPatterns: string[];
  logLevel: "silent" | "error" | "info";
}

export const EXTENSION_CONFIG_DEFAULTS: Readonly<ExtensionConfigV1>;
export function validateExtensionConfig(value: unknown): ExtensionConfigV1;
