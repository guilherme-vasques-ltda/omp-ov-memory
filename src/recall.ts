// Apache-2.0; retrieval engine adapted from pi-openviking 0.4.4.
import type { OVClient } from "./client.ts";
import type { OVConfig } from "./config.ts";
import { RecallLedger, type ContextMessage } from "./ledger.ts";
import { within } from "./deadline.ts";
import { canonicalVikingUri, insideVikingRoot, isManagedVikingUri } from "./security.ts";
import { buildRecallBlock } from "./shared/recall-core.mjs";
import { observation, type Observation } from "./shared/observe.mjs";

export class RecallManager {
  private client: OVClient;
  private config: OVConfig;
  private ledger: RecallLedger;
  private sessionId: () => string | null;
  private observe: Observation;
  private pendingPrompt: string | null = null;
  private generation = 0;
  private startupBlock = "";
  private block: string | null = null;

  constructor(client: OVClient, config: OVConfig, sessionId: () => string | null = () => null,
    observe: Observation = observation, ledger?: RecallLedger) {
    this.client = client; this.config = config; this.sessionId = sessionId; this.observe = observe;
    this.ledger = ledger ?? new RecallLedger(config.stateDir, [client.recordedEventTarget, sessionId()]);
  }

  /** Deliberately no I/O. The UI can render the prompt immediately. */
  queueSearch(prompt: string): void { this.pendingPrompt = prompt; this.generation++; }
  setStartupBlock(block: string): void { this.startupBlock = block; }

  async searchPending(messages: ContextMessage[] = [], budgetMs = 1900): Promise<string | null> {
    const keys = this.ledger.turnKeys(messages);
    const key = [...keys.values()].at(-1);
    const stored = key ? this.ledger.get(key) : undefined;
    if (stored !== undefined) { this.pendingPrompt = null; this.block = stored || null; return this.block; }
    if (this.pendingPrompt === null) return null;
    const prompt = this.pendingPrompt;
    const generation = this.generation;
    this.pendingPrompt = null;
    let block: string | null = null;
    const deadline = Date.now() + Math.min(1900, budgetMs, this.config.requestTimeoutMs);
    if (prompt.trim().length >= this.config.minQueryLength && this.config.recallTokenBudget > 0) {
      const retrieve = buildRecallBlock(
        async (path: string, init?: RequestInit) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return Promise.resolve({ ok: false, result: null, status: 0 });
          const allowed = (uri: unknown): boolean => {
            const canonical = canonicalVikingUri(uri);
            return !!canonical && canonical === uri && !isManagedVikingUri(canonical) && !canonical.includes("/.omp-ov-memory/") &&
              (!this.config.sessionScopedMemory || insideVikingRoot(canonical, this.client.userRoot));
          };
          if (path.startsWith("/api/v1/content/")) {
            const uri = new URL(path, "http://local.invalid").searchParams.get("uri");
            if (!allowed(uri)) return {ok: false, result: null, status: 403};
          }
          let request = init;
          if (this.config.sessionScopedMemory && typeof init?.body === "string" && path.includes("/search/")) {
            const body = JSON.parse(init.body);
            body.target_uri = this.client.userRoot;
            request = {...init, body: JSON.stringify(body)};
          }
          const response = await this.client.fetchJSON<any>(path, request, remaining);
          if (this.config.sessionScopedMemory && response.ok && response.result && typeof response.result === "object") {
            for (const field of ["entries", "memories", "resources", "skills"]) {
              if (Array.isArray(response.result[field])) response.result[field] = response.result[field].filter((item: any) => allowed(item.uri));
            }
            // An unattributed rendered block must never bypass URI-level scope checks.
            delete response.result.rendered; delete response.result.digest;
          }
          return response;
        },
        { ...this.config, recallQueryExpansion: "off", recallQueryExpansionConfigured: true },
        prompt,
        { actorPeerId: this.config.peerId, sessionId: this.sessionId() ?? "", userSpace: this.client.memorySpace, observation: this.observe },
      );
      block = await within(retrieve, Math.max(0, deadline - Date.now()), null);
    }
    // A new prompt or session invalidates late results; never inject stale recall.
    if (generation !== this.generation) return null;
    const combined = [this.startupBlock, block].filter(Boolean).join("\n\n");
    this.startupBlock = "";
    this.block = key ? this.ledger.record(key, combined) || null : combined || null;
    return this.block;
  }

  injectRecall(messages: ContextMessage[]): { messages: ContextMessage[]; injectedBlock: string | null } {
    return { messages: this.ledger.apply(messages), injectedBlock: this.block };
  }

  invalidate(): void { this.generation++; this.pendingPrompt = null; this.block = null; }
}
