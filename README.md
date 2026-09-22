# omp-ov-memory

OpenViking memory for OMP and Pi: durable conversation capture, scoped recall,
verified archives, explicit memory tools, and workspace handoffs between agents.
The plugin is Apache-2.0 and uses OpenViking as its backend.

It integrates through extension hooks, eleven `viking_*` tools, and `/ov`.
It does not add an unsupported value to OMP's built-in `memory.backend` setting.
The optional MCP server exposes the same tools to hosts without the extension.

## Requirements

- Node.js **22.19 or newer** and npm. Development was verified with Node 24.20.
- OMP with its extension/plugin API; the local integration targets **OMP 18.2.8**.
- An accessible OpenViking server and credentials authorized for its user namespace.
  The client was checked against **OpenViking v0.4.20** and its live OpenAPI schema.

OpenViking is managed separately. This package does not provision a server,
change OMP's backend settings, or bundle model-provider credentials.

## Install from a local marketplace

From this checkout:

```sh
npm ci
omp plugin marketplace add ./ --scope project
omp plugin install omp-ov-memory@omp-ov-memory-marketplace --scope project
omp plugin doctor
```

The local marketplace catalog is [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json).
These commands install into the current project's OMP configuration. To use the
checkout in another project, run the marketplace commands from that project and
replace `./` with the absolute path to this checkout. Restart OMP to discover the
extension and its tools.

Do not enable the older `pi-openviking` extension in the same OMP session: it
registers overlapping tools and hooks. Its existing global installation was
preserved during development; select the replacement when starting your host.

The repository and npm package have **not been published**. A future repository
is intended at `guilherme-vasques-ltda/omp-ov-memory`; no remote install command is
claimed to work before publication.

### Development link

Install dependencies first, then explicitly link the checkout:

```sh
omp plugin link /absolute/path/to/omp-ov-memory
```

On the tested OMP 18.2.8 build, this creates a **user/global development symlink**.
Use the marketplace route above when project scope matters. Do not install both
routes for the same project.

The requested direct command `omp plugin install --force ./ --scope project`
warned that its flags were ignored and created a global link on that build.
`omp plugin link --dry-run ./` also created a real link. Neither spelling should
be relied on for project scoping or a nonmutating preview.

## Credentials

Credentials resolve field by field in this order:

1. `OPENVIKING_*` environment variables.
2. `~/.openviking/ovcli.conf`.
3. `~/.openviking/ov.conf`.
4. Endpoint fallback `http://127.0.0.1:1933`, with no guessed API key or identity.

| Environment variable | Purpose |
| --- | --- |
| `OPENVIKING_URL` | Server base URL |
| `OPENVIKING_API_KEY` | Bearer credential |
| `OPENVIKING_ACCOUNT` | Account header, when required |
| `OPENVIKING_USER` | Authenticated user, when explicitly configured |
| `OPENVIKING_PEER_ID` | Explicit actor/workspace peer override |
| `OPENVIKING_CLI_CONFIG_FILE` | Explicit path to an existing `ovcli.conf` |
| `OPENVIKING_CONFIG_FILE` | Explicit path to an existing server `ov.conf` |

The client also accepts `OPENVIKING_BASE_URL` and
`OPENVIKING_BEARER_TOKEN` as lower-priority aliases for the corresponding primary
environment variables. CLI files accept `url`, `api_key`, `account`/`account_id`,
`user`/`user_id`, and `actor_peer_id`/`peer_id`. Server configuration may supply
`server.url`, `server.host`, `server.port`, and `server.root_api_key`.

When an explicit user is absent, the plugin resolves the actual user through the
authenticated status endpoint. It fails closed if identity cannot be established.
Session scoping changes a storage path; it never impersonates another user.

For an existing older installation with credentials under `~/.pi/openviking`,
select that file explicitly before starting OMP:

```sh
export OPENVIKING_CLI_CONFIG_FILE="$HOME/.pi/openviking/ovcli.conf"
omp
```

That override was needed on the development machine: its newer
`~/.openviking/ovcli.conf` contained an empty key, while the older file held the
working credential. Credentials were not copied into this repository.

HTTP is accepted on loopback. Bearer credentials require HTTPS outside loopback.
OpenViking requests do not follow redirects, and loopback traffic bypasses global
proxy dispatchers. Keep real credentials out of plugin JSON, session prompts,
committed `.env` files, and issue reports.

## Configuration

Package defaults live in [`config.json`](config.json). Put user overrides in
`~/.openviking/omp-ov-memory.jsonc`; JSON comments are accepted. Credential values
belong in the credential sources above, not this behavior file. Unknown fields
and invalid values fail validation. Restart OMP after changing configuration.

The brief's behavior defaults are:

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

Additional configuration:

| Setting | Default / behavior |
| --- | --- |
| `captureAllowlist`, `captureDenylist` | Empty arrays of file-path glob patterns |
| `captureMode` | `denylist`, `allowlist`, or `off` |
| `requestTimeoutMs` | `2000`; configurable from 1 to 2000 ms |
| `stateDir` | `~/.openviking/omp-ov-memory` |
| `archive.chunkTokenBudget` | `50000` |
| `archive.rawTailTokenBudget` | `20000` |
| `takeover.contextTokenThreshold` | Alias of `tokenThreshold`; default `30000` |
| `takeover.checkpointTokenBudget` | `16000` |
| `recallMaxContentChars`, `recallPreferAbstract` | `500`, `true` |
| `recallLimit`, `recallQueryExpansion` | `10`, `auto`; hot-hook recall explicitly disables query expansion to honor its deadline |
| `recallPeerScope` | `all` or `actor`; this does not override URI/session isolation |

`OPENVIKING_WORKSPACE_PEER`, `OPENVIKING_RECALL_PEER_SCOPE`,
`OPENVIKING_RECALL_LIMIT`, and `OPENVIKING_RECALL_QUERY_EXPANSION` provide the
corresponding environment overrides. `bypassPatterns` matches workspace paths
with `*` wildcards and disables the extension in those paths.

### Workspace routing

An optional `.ov-memory.toml` selects a stable workspace/project identity:

```toml
workspace = "engineering"
project = "catalog-service"
project_strategy = "repo-root"

[capture]
mode = "denylist"
ignore_paths = ["private/**", "exports/**"]
```

The nearest marker wins. Without an explicit project name, repository identity
separates unrelated projects; Git worktrees resolve their common repository.
`project_strategy = "directory"` separates individual directories. An explicit
project name intentionally lets matching workspace/project names share across
clones. A marker's capture paths combine with the configured path lists.

Allowlist mode requires recognized allowed paths and rejects unknown shell
commands. With custom deny paths configured, shell capture is conservative and
excluded because arbitrary shell code can compute hidden paths. Built-in secret
file and credential patterns are excluded even without custom patterns. Capture
filtering also suppresses the results of denied tool calls. These controls apply
to the plugin's copies, not OMP's original transcript.

### Session and cross-agent scope

By default, tools and recall are confined to:

```text
viking://user/<authenticated-user>/omp-ov-memory/sessions/<workspace-and-session-hash>
```

Resuming the same native session and workspace restores that scope. A new session
gets a different scope. `viking_remember` creates an explicit note within it;
immutable captured events and archives use their own protected paths.

A workspace handoff is the explicit bridge between sessions and agents. It stores
recent policy-approved conversation under the authenticated base user's shared
handoff path and is injected as historical context in another session. Handoffs
are best effort and last-writer-wins; they are not locks or task ownership records.

Native OpenViking extraction writes learned memories into the authenticated
user's canonical memory namespace. Strict session-scoped recall excludes those
base memories. Set `sessionScopedMemory: false` to use shared learned memory
within the server's authorization boundaries. Native session mirroring and
context/resume handling are distinct from durable raw-event storage. Native
`ov-` session IDs also include a workspace-derived suffix, so identical harness
session IDs in unrelated workspaces do not share a native server session.

### Native message and commit recovery

After raw-event storage is verified, the plugin mirrors approved user, assistant
and tool-result text into a native OpenViking session. Stable `source_message_ids`
provide reconciliation evidence; the server does **not** deduplicate appends by
those IDs. The plugin therefore publishes a private intent before submitting a
message, then requires matching remote source identity and content before marking
it confirmed. The native mirror does not copy image/binary parts; the raw-event
and checkpoint paths retain their separate responsibilities.

`/ov status` reports the mirror's latest loaded/reconciled state:

| Field | Meaning |
| --- | --- |
| `confirmed` | Locally acknowledged native message identities |
| `unknown` | Published message intents without a confirming acknowledgment |
| `commitUnknown` | A commit intent has no acknowledged outcome |
| `lastError` | A stable diagnostic code for the latest mirror failure |

Only positive evidence resolves uncertainty. A missing message, incomplete
remote history, or unchanged commit counter does not authorize another append or
commit. A commit is claimed once per confirmed-source watermark and acknowledged
by an explicit accepted/skipped response, or reconciled against an advanced
commit counter on the same server-session generation. This confirms submission
or archival progress, not completed model extraction.

An unknown mirror operation can keep a queue record and later capture pending,
even when the raw-event copy was already verified. The private pending spool and
verified raw objects remain available. Restore access and inspect status; do not
delete mirror intents to force a retry. See [recovery](docs/recovery.md).

## Lifecycle and commands

| Hook | Behavior |
| --- | --- |
| `session_start` | Resolve identity, initialize engine/ledger, check health, replay pending capture, and load profile/resume/handoff in the background |
| `before_agent_start` | Queue the recall query without network I/O and capture the prompt |
| `context` | Assemble scoped recall within the hook deadline and reapply saved historical blocks |
| `tool_call` / `tool_result` | Capture approved events; block local filesystem/shell use of `viking://` and direct the model to memory tools |
| `turn_end` / `agent_end` | Queue branch synchronization, update status, and perform eligible commit/handoff work |
| `session_before_compact` | Use verified takeover context when enabled and eligible; otherwise retain native compaction and request advisory commit/rehydration |
| `session_shutdown` | Bound the combined drain/commit/handoff wait, retain pending work, and close clients |

Startup and capture do not await OpenViking on the user-facing hot path. Context
retrieval and lifecycle waits are bounded to about two seconds; each HTTP request
has a shared deadline of at most two seconds, including any safe read retry.
Background composite operations may span multiple requests. Explicit public
resource downloads have their own 15-second limit.

The hook queue uses a 100-record dispatch window, a 2-second flush interval, and
a threshold of 20 records. Session start/end, stop and pre-compaction trigger an
immediate asynchronous flush. Pending data survives restart after private atomic
spool publication. A long outage can grow the disk backlog; overflow is not
silently discarded. See [recovery](docs/recovery.md) for durability boundaries.

| Command | Action |
| --- | --- |
| `/ov` or `/ov status` | Connectivity, pending capture, session and derived engine state |
| `/ov health` | Refresh server health and show status |
| `/ov sync` | Queue the current branch and attempt a bounded drain |
| `/ov commit` | Request commit after pending capture is drained |
| `/ov flush` | Alias of the commit command |
| `/ov handoff` | Save current workspace handoff |

`/viking` is an alias of `/ov`. A timeout or unconfirmed write is not evidence that
the server did nothing. Inspect state before retrying; the HTTP client never
blindly retries writes. Native message mirroring reconciles stable source-message
identities and retains uncertain outcomes instead of blindly appending again.
The checkpoint processor uses the same append/commit guard for its task input.

## Eleven tools

| Tool | Purpose |
| --- | --- |
| `viking_search` | Semantic retrieval with URI scope enforcement |
| `viking_read` | Abstract, overview or full content |
| `viking_browse` | Directory listing and metadata |
| `viking_remember` | Explicit durable note; native extraction in shared mode |
| `viking_forget` | Delete an explicit eligible memory or a sufficiently strong search match |
| `viking_add_resource` | Import vetted public text through a safe local download and upload |
| `viking_archive_expand` | Inspect verified current-session archives |
| `viking_tree` | Directory tree from the real filesystem API |
| `viking_write` | Create, replace or append exact content |
| `viking_edit` | Replace one unambiguous occurrence |
| `viking_health` | Connectivity check |

Full inputs, examples and operational limits are in [the tool reference](docs/tools.md).
The package also includes [an agent skill](skills/openviking-memory/SKILL.md).

## Security and API limits

- Capture policy runs before private spool writes, again on replay, and before
  projection. Secret matching is a heuristic, not a proof that arbitrary text is
  free of confidential data.
- Pending directories use `0700`, records use `0600`, and published records use
  fsync plus atomic rename. Local state includes private conversation data.
- HTTP errors expose sanitized status/codes. Credentials are never placed in queue
  metadata. Namespace resolution preserves the authenticated principal.
- Resource import rejects private, loopback, reserved, link-local and local-name
  destinations. DNS answers are vetted and pinned; redirects are rechecked.
  Only bounded UTF-8 text is uploaded as `.txt`, so OpenViking receives no remote
  fetch URL or active HTML ingestion instruction.
- URI validation rejects traversal and ambiguous encoded paths. Categories must
  match `^[a-z][a-z_-]{0,31}$`. Tools cannot mutate engine-owned immutable objects.
- Retrieved memory and handoffs are historical evidence, not instructions.

OpenViking v0.4.20 exposes no atomic hash-compare replacement. Immutable creates
are reconciled by bytes and read back before acknowledgment. The engine returns
`501 / UNSUPPORTED_PRECONDITION` for repair paths requiring `replace_if_hash`;
those damaged objects need investigation rather than unconditional overwrite.
`viking_edit` is explicitly best effort (`atomic: false`): an external writer can
race between its final read and write. Whole-batch transactional atomicity and
exactly-once external side effects are not promised.

Checkpoints may invoke the OpenViking server's configured model provider. Their
cost and success are separate from basic health, raw sync, and optional context
takeover, which is disabled by default. See [API compatibility](docs/api-compatibility.md)
and [architecture](docs/architecture.md).

## Optional MCP fallback

[`mcp.json`](mcp.json) is a **manual opt-in descriptor** for
`servers/mcp-proxy.mjs`. It is not named `.mcp.json` and is not automatically
loaded by the legacy plugin manifest. Configure your MCP host with the absolute
script path and run it from the intended workspace:

```sh
OPENVIKING_SESSION_ID=my-stable-session node /absolute/path/omp-ov-memory/servers/mcp-proxy.mjs
```

Choose a stable session ID to resume the same scope. Without one, each proxy
process uses a new random session. Use either the extension's tools or the MCP
fallback in a given host to avoid duplicate definitions. The fallback provides
explicit tools; automatic hooks, recall injection and handoffs require the
extension. See [MCP setup and protocol](docs/mcp.md).

## Verification and development

```sh
npm ci
npm test
npm run typecheck
node --check extensions/openviking.ts
OPENVIKING_LIVE_TEST=1 node --test tests/client.test.mjs
npm run test:live
curl --fail --silent http://127.0.0.1:1933/health
omp plugin doctor
```

Unit and integration tests use Node's native test runner, temporary private state,
controlled HTTP servers, and an actual child-process MCP proxy. The opt-in live
schema test reads the OpenAPI document; it does not create production memories.
`npm run test:live` creates disposable scoped objects, checks tools, cross-session
handoff and native mirror restart, then verifies deletion. It uses normal
credential discovery and does not request a model extraction commit.
Separate disposable live probes verified authenticated content CRUD, immutable
batch create/replay, scoped raw-engine sync, tree operations and text uploads;
the probe resources were cleaned up. Paid checkpoint generation was not treated
as proven by these checks.

The tested global `omp plugin doctor` reported **10 OK, 1 warning, 0 errors**.
Its warning concerned the unrelated installed `@heihei0299/pi-switch` package
missing a plugin manifest. That global doctor does not audit marketplace-loaded
extensions and is not, by itself, proof of this plugin's runtime execution.
Consult the current test/loader results as well as authenticated operations.
The recorded delivery results are in [verification](docs/verification.md).

## License and provenance

Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) and
[provenance](docs/provenance.md). The mature engine derives from
`pi-openviking@0.4.4` under Apache-2.0. Additional tools, the MCP fallback and recall
ledger are independently implemented from feature descriptions. MIT reference
designs informed handoff, queue, capture and routing. No AGPL implementation is
included.
