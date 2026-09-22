import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface ContextMessage { role: string; content?: any; timestamp?: number; id?: string; [key: string]: any }

/** Append-only per-turn files avoid lost updates between processes resuming a session. */
export class RecallLedger {
  readonly directory: string;
  private blocks = new Map<string, string>();
  private writes = new Set<Promise<void>>();
  lastError: string | null = null;

  constructor(stateDir: string, identity: unknown) {
    this.directory = join(stateDir, "recall-ledger", hash(JSON.stringify(identity)));
  }

  async load(): Promise<void> {
    try {
      const files = await readdir(this.directory);
      for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const entry = JSON.parse(await readFile(join(this.directory, name), "utf8"));
          if (entry.version === 1 && typeof entry.key === "string" && typeof entry.block === "string" &&
              entry.block.length <= 250_000 && `${hash(entry.key)}.json` === name) this.blocks.set(entry.key, entry.block);
        } catch { this.lastError = "LEDGER_INVALID_ENTRY"; }
      }
    } catch (error: any) { if (error.code !== "ENOENT") this.lastError = "LEDGER_READ_FAILED"; }
  }

  get(key: string): string | undefined { return this.blocks.get(key); }

  record(key: string, block: string): string {
    if (this.blocks.has(key)) return this.blocks.get(key)!;
    this.blocks.set(key, block);
    const operation = this.persist(key, block).catch(() => { this.lastError = "LEDGER_WRITE_FAILED"; });
    this.writes.add(operation);
    void operation.finally(() => this.writes.delete(operation));
    return block;
  }

  private async persist(key: string, block: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const target = join(this.directory, `${hash(key)}.json`);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, key, block }), { flag: "wx", mode: 0o600 });
      try { await link(temporary, target); }
      catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        const existing = JSON.parse(await readFile(target, "utf8"));
        if (existing.key !== key || typeof existing.block !== "string") throw new Error("ledger conflict");
        // First writer wins on restart. Current in-flight context keeps its already issued block.
        if (existing.block !== block) this.lastError = "LEDGER_CONCURRENT_SESSION";
      }
    } finally { await rm(temporary, { force: true }); }
  }

  async flush(): Promise<void> { await Promise.all([...this.writes]); }

  private originalContent(message: ContextMessage): any {
    const content = structuredClone(message.content);
    const strip = (text: string): string => {
      for (const block of this.blocks.values()) if (block && text.startsWith(`${block}\n`)) return text.slice(block.length + 1);
      return text;
    };
    if (typeof content === "string") return strip(content);
    if (Array.isArray(content)) {
      const text = content.find(item => item.type === "text");
      if (text && typeof text.text === "string") text.text = strip(text.text);
    }
    return content;
  }

  turnKeys(messages: ContextMessage[]): Map<number, string> {
    const occurrences = new Map<string, number>();
    const keys = new Map<number, string>();
    messages.forEach((message, index) => {
      if (message.role !== "user") return;
      const contentHash = hash(JSON.stringify(this.originalContent(message)) ?? "");
      const occurrence = occurrences.get(contentHash) ?? 0;
      occurrences.set(contentHash, occurrence + 1);
      const identity = message.id ?? message.timestamp ?? `occurrence:${occurrence}`;
      keys.set(index, `${identity}:${contentHash}`);
    });
    return keys;
  }

  apply(messages: ContextMessage[]): ContextMessage[] {
    const keys = this.turnKeys(messages);
    return messages.map((message, index) => {
      const block = this.blocks.get(keys.get(index) ?? "");
      if (!block) return message;
      const copy = { ...message, content: this.originalContent(message) };
      if (typeof copy.content === "string") copy.content = `${block}\n${copy.content}`;
      else if (Array.isArray(copy.content)) {
        const text = copy.content.find((item: any) => item.type === "text");
        if (text) text.text = `${block}\n${text.text}`;
        else copy.content.unshift({ type: "text", text: block });
      }
      return copy;
    });
  }
}
