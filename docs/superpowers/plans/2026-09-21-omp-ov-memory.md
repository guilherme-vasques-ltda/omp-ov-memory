# omp-ov-memory Implementation Plan

**Goal:** Implement the approved BRIEF.md on main with native OMP hooks and an opt-in MCP fallback.

**Architecture:** Reuse the Apache-2.0 immutable event/archive/checkpoint engine from pi-openviking 0.4.4. Keep transport, queue, recall, capture, routing and handoff agent-neutral. Implement the extension serially after independent module contracts converge.

**Tech Stack:** Node native TypeScript stripping, TypeScript strict checking, node:test, undici, TypeBox and TOML.

## Global constraints

- Apache-2.0; do not copy AGPL code.
- API contracts come from the live OpenViking 0.4.20 OpenAPI document.
- Hot hook I/O has an overall budget of at most 2000 ms; capture is scheduled in the background.
- Pending state uses 0700 directories and 0600 files with atomic rename.
- No secrets in source, output or commits; no GitHub push.
- Work in this repo on branch main. User has selected native parallel agents.

## Ownership and validation

- [x] Client/config worker: src/client.ts, src/config.ts, config.json, tests/client.test.mjs, tests/config.test.mjs. Preserve OVClient public methods for the engine; validate all live endpoints, credential precedence, timeout, retry, HTTPS and peer headers. Run targeted node:test fixtures.
- [x] Sync worker: src/sync.ts, src/hook-queue.ts, tests/sync.test.mjs, tests/hook-queue.test.mjs. Preserve archive/checkpoint engine. Add durable bounded queue, replay and drain; prove outage recovery and duplicate/concurrent handling.
- [x] Tools/proxy worker: src/tools.ts, src/security.ts, servers/mcp-proxy.mjs, tests/tools.test.mjs, tests/mcp-proxy.test.mjs. Eleven tools share one implementation; enforce SSRF/URI/category boundaries; MCP initialize/list/call/error/cancellation use stdio JSON-RPC. No AGPL implementation reading.
- [x] Main: workspace, capture-policy, ledger, handoff and recall with behavioral tests. Workspace/session/actor coordinates must stay consistent; historical context injection is immutable and byte-stable.
- [x] Main: extension, manifests, docs and lifecycle tests. Register tools synchronously; queue-only prompt hook; context timeout; lifecycle switch isolation; bounded shutdown; native compaction fallback and optional takeover.
- [x] Integration: npm install, npm test, npm run typecheck, node --check extensions/openviking.ts, local project plugin install and doctor, live authenticated read/write/readback/delete in a disposable namespace, packaged-file/secret audit.
- [x] Independent review: review concrete integration against BRIEF, fix findings and rerun required checks.

Delivery evidence and validation boundaries: [docs/verification.md](../../verification.md).
