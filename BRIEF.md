# omp-ov-memory — Brief para Codex Astra Ultra

## Missão

Criar um plugin OMP↔OpenViking completo, production-ready, chamado **`omp-ov-memory`**, publicado como open-source (Apache-2.0) no org `guilherme-vasques-ltda`. Ele unifica o melhor de três fontes num pacote só, com um core compartilhado que depois vira base para adapters de outros agentes (Codex, Grok, Hermes).

## Contexto do ambiente (verificado)

- **OMP**: `omp v18.2.8` instalado em `~/.bun/bin/omp`. Extensions TS carregam de `~/.omp/agent/extensions/` e de plugins (`~/.omp/plugins/node_modules/<pkg>` com campo `omp.extensions` ou `pi.extensions` no package.json).
- **OpenViking server**: `v0.4.20` rodando em `http://127.0.0.1:1933` (self-hosted no Titanos Oracle, túnel SSH). `curl http://127.0.0.1:1933/health` → `{"status":"ok","healthy":true,"version":"v0.4.20","auth_mode":"api_key"}`. API completa em `/openapi.json` (122 paths): `/api/v1/content/{read,write,abstract,overview,batch-write,set_tags,reindex,download}`, `/api/v1/fs/{ls,tree,stat,mkdir,mv,cp,attrs}`, `/api/v1/search/{search,find,glob,grep,recall}`, `/api/v1/sessions/*` (messages, archives, commit, context, extract, tool-results).
- **Plugin atual instalado**: `pi-openviking@0.4.4` em `~/.omp/plugins/node_modules/pi-openviking` (Apache-2.0, upstream Volcano Engine/earendil-works). Tem patch local `~/.omp/plugins/patches/pi-openviking@0.4.4.patch` (peer_id no addMessage + guard em agent.close).
- **OMP `memory.backend`**: feature nativa fechada (`off`/`local`/`hindsight`/`mnemopi`) — NÃO é ponto de extensão de plugin. Nosso plugin entrega a memória via hook `context` + tools + `/ov`, que na prática é o mesmo resultado visível.

## Fontes de referência (estudar antes de codar)

1. **`pi-openviking@0.4.4`** (Apache-2.0 — pode reusar código):
   - Local: `~/.omp/plugins/node_modules/pi-openviking/`
   - Entry: `index.ts` (hooks), `client.ts` (OVClient HTTP), `tools.ts` (7 tools), `sync.ts`, `recall.ts`, `config.ts`, `lib/`, `shared/`
   - Features: sync de eventos JSONL→OV, Archives atômicos, VLM checkpoints, takeover de contexto, recall via `before_agent_start`→`context`, uri-guard `viking://`, workspace-peer isolation, `/viking` command.
   - ~9.6k linhas. Docs em `docs/` (spec.md, design.md, observability.md, usage.md).

2. **`cortexc0de/omp-openviking-memory@0.2.2`** (AGPL-3.0 — NÃO copiar código, só ideias):
   - Clone probe: `/tmp/omp-ov-probe/` (pode re-clonar de github.com/cortexc0de/omp-openviking-memory)
   - Agregar: 4 tools extras (`viking_tree`, `viking_write`, `viking_edit`, `viking_health`), MCP-proxy fallback (`servers/mcp-proxy.mjs`), recall-ledger (`~/.openviking/omp-recall-ledger/` reaplica bloco byte-a-byte pra prompt-cache), alias `/ov`.
   - Reescrever as tools extras limpo contra nossa API (AGPL contamina se copiar).

3. **`akitaonrails/ai-memory`** (MIT — pode reusar ideias e padrões):
   - Clone probe: `/tmp/ai-memory-probe/` (pode re-clonar de github.com/akitaonrails/ai-memory)
   - Agregar o DESIGN, não o backend (ele usa Rust+SQLite próprio; nós usamos OpenViking):
     - **Cross-agent handoff**: `before_agent_start` → `fetchHandoff(cwd, sessionID)` → injeta `customType:"ai-memory-handoff"`. Adaptar pra OV: handoff = memória `viking://` especial por workspace, recuperável por qualquer agente.
     - **Hook queue assíncrona**: `HOOK_QUEUE_MAX=100`, flush 2s, threshold 20, timeout 2s, eventos imediatos `{session-start, stop, session-end, pre-compact}` — nunca bloqueia o agente. Copiar esse padrão pro nosso sync.
     - **Capture policy** (`ts_capture_policy_v1`): allowlist/denylist de padrões de captura.
     - **Workspace routing**: `.ai-memory.toml` marker file → adaptar pra `.ov-memory.toml` (project routing, mono-repo, worktrees).
     - **Multi-agente**: ele já resolve "mesmo projeto, agentes diferentes" — estudar `docs/managed-workstreams.md`, `docs/marker-file.md`, `docs/auto-scope.md`.

## Arquitetura alvo

```
omp-ov-memory/
├── package.json          # name omp-ov-memory, omp.extensions + pi.extensions
├── plugin.json           # OMP plugin manifest
├── config.json           # defaults (ver seção config)
├── mcp.json              # MCP fallback → servers/mcp-proxy.mjs
├── extensions/
│   └── openviking.ts     # entry: registra hooks, tools, commands
├── src/
│   ├── client.ts         # OVClient — HTTP p/ OV API v1 (auth, retry, timeouts)
│   ├── sync.ts           # event projection + archive + pending-queue
│   ├── recall.ts         # recall pipeline (search→assemble→inject)
│   ├── ledger.ts         # recall-ledger p/ prompt-cache stability
│   ├── handoff.ts        # cross-agent handoff (fetch/store via OV)
│   ├── capture-policy.ts # allowlist/denylist
│   ├── workspace.ts      # .ov-memory.toml routing + peer isolation
│   └── tools.ts          # 11 viking_* tools
├── servers/
│   └── mcp-proxy.mjs     # MCP stdio→HTTP proxy (fallback sem Extension)
├── skills/openviking-memory/SKILL.md
├── commands/ov.md        # slash /ov
├── tests/                # node --test
└── docs/
```

## Hooks a implementar (Extension API do Pi/OMP)

| Evento | Ação |
|---|---|
| `session_start` | `health()` → `ensureSession(ov-…)` → `replayPending()` → profile + archive overview → `fetchHandoff(cwd)` injeta se houver |
| `before_agent_start` | `queueSearch(prompt)` (sem I/O) + postHook `user-prompt` na fila |
| `context` | `fetchAssembledContext` + ledger injection (bloco estável p/ cache) |
| `tool_call` / `tool_result` | capture na fila + `viking://` uri-guard intercept |
| `turn_end` / `agent_end` | `syncBranch` → OV, footer status |
| `session_before_compact` | takeover ou `commit()` + rehydration |
| `session_shutdown` | drain bounded → `commit()` |

## Tools (11)

`viking_search` · `viking_read` · `viking_browse` · `viking_remember` · `viking_forget` · `viking_add_resource` (SSRF-guarded) · `viking_archive_expand` · `viking_tree` · `viking_write` · `viking_edit` · `viking_health`

+ uri-guard: `read`/`bash`/`glob`/`grep` em `viking://` → reroute p/ `viking_read`/`viking_search`.

## Config (`config.json` defaults)

```json
{
  "enabled": true,
  "syncTurns": true,
  "recallTokenBudget": 2000,
  "scoreThreshold": 0.35,
  "minQueryLength": 3,
  "profileTokenBudget": 10000,
  "resumeContextBudget": 32000,
  "commitTokenThreshold": 20000,
  "sessionScopedMemory": true,
  "workspacePeer": true,
  "recallPeerScope": "all",
  "captureMode": "denylist",
  "handoff": { "enabled": true },
  "takeover": { "enabled": false, "tokenThreshold": 30000, "keepRecentTurns": 3 },
  "bypassPatterns": [],
  "logLevel": "error"
}
```

## Credenciais (ordem de prioridade)

1. `OPENVIKING_*` env (`OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`, `OPENVIKING_PEER_ID`)
2. `~/.openviking/ovcli.conf`
3. `~/.openviking/ov.conf`
4. Fallback `http://127.0.0.1:1933` (loopback http ok; remoto exige https quando token setado)

## Requisitos não-funcionais

- **Nunca bloquear o agente**: toda I/O OV é best-effort com timeout ≤2s em hooks quentes; fila assíncrona com drain no shutdown.
- **Degradação graciosa**: OV fora do ar → coding continua, eventos ficam em pending-queue (`0o700`/`0o600`, atomic rename) e replay no próximo boot.
- **Segurança**: bearer token só em https fora de loopback; `add_resource` bloqueia localhost/private/169.254/*.local; logs redactam payload; `category` allowlist `^[a-z][a-z_-]{0,31}$`.
- **Prompt-cache**: ledger reaplica o mesmo bloco byte-a-byte em turns históricos.
- **Licença Apache-2.0**; não copiar código AGPL do fork.

## Entregáveis

1. Repo completo em `~/Documents/Workspaces/omp-ov-memory` (git init já feito, branch main)
2. `npm test` passando (node --test)
3. `npm run typecheck` limpo (tsc --noEmit)
4. `node --check extensions/openviking.ts` ok
5. `omp plugin doctor` ok quando instalado via `omp plugin install --force ./ --scope project`
6. README.md com install (marketplace + dev link), config, credentials, lifecycle, tools, security
7. NÃO commitar segredos; NÃO publicar no GitHub ainda (deixar repo local pronto, eu faço o push)

## Processo

1. Estudar `pi-openviking` (principal fonte), fork (features), ai-memory (design handoff/queue/policy/routing)
2. Planejar a estrutura e abrir o esqueleto
3. Implementar client → sync → recall → tools → hooks → mcp-proxy → docs
4. Testar contra OV local `http://127.0.0.1:1933` (health deve retornar ok)
5. Reportar com evidência real (saída de test/typecheck/doctor)
