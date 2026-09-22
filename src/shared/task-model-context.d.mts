
export interface PiTaskModelContextFacts {
  capacity: { contextWindow: number; maxTokens: number } | null;
  factsAvailable: boolean;
  systemPrompt: string;
  toolDefinitions: string;
}

export function readTaskModelContext(
  pi: { getActiveTools(): string[]; getAllTools(): any[] },
  ctx: any,
  onError?: (error: unknown) => void,
): PiTaskModelContextFacts;
