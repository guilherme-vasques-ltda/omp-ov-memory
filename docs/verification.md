# Delivery verification

Verified from this repository on branch `main`, with Node 24.20.0, OMP 18.2.8 and
OpenViking v0.4.20. Commands below were executed; excerpts omit per-test timings
and unrelated plugin descriptions. No GitHub push was performed.

## Required checks

`npm test` exited 0:

```text
ℹ tests 92
ℹ suites 0
ℹ pass 91
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

The skipped check is the explicitly opt-in live OpenAPI test. It was run separately
with `OPENVIKING_LIVE_TEST=1 node --test --test-name-pattern='live OpenAPI' tests/client.test.mjs`:

```text
✔ live OpenAPI confirms implemented wire contract
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

`npm run typecheck` exited 0:

```text
> omp-ov-memory@0.1.0 typecheck
> tsc --noEmit
```

`node --check extensions/openviking.ts` and `node --check servers/mcp-proxy.mjs`
both exited 0 with no output.

## Live authenticated integration

`curl --silent --show-error --max-time 5 http://127.0.0.1:1933/health` returned:

```json
{"status":"ok","healthy":true,"version":"v0.4.20","auth_mode":"api_key"}
```

The live `/openapi.json` document contains 122 paths. Authenticated tests loaded
the existing credential through an explicit `OPENVIKING_CLI_CONFIG_FILE` override;
no credential was copied into the repository. The default newer local CLI file
has an empty key; the README explains selecting the older credential file.

`npm run test:live` exited 0 with the following actual output:

```json
{"liveSmoke":{"health":true,"authenticatedIdentity":true,"writeEditReadTree":true,"crossSessionHandoff":true,"immutableSync":{"firstAdded":1,"replayAdded":0},"nativeMirror":{"messageCount":1,"commitCount":0,"restartConfirmed":1},"forget":true}}
{"cleanupConfirmed":true}
```

Separate development probes checked create conflicts, content write modes,
scoped cold-root sync and vetted text resource upload. Their disposable resources
were also removed. Native source-message IDs were observed to survive storage
but **not** deduplicate repeated appends; the mirror guard addresses this limit.
Paid VLM checkpoint generation and completed model extraction were not exercised.
Their request, recovery and integrity paths are covered by controlled fixtures;
acceptance or health is not evidence of generated model output.

## OMP installation and native loading

The requested `omp plugin install --force ./ --scope project` ran, but OMP 18.2.8
warned that these flags were ignored for a local path and created a global link.
That development link and its stale configuration were removed. The verified
project-scope route was:

```sh
omp plugin marketplace add ./ --scope project
omp plugin install omp-ov-memory@omp-ov-memory-marketplace --force --scope project
```

Actual result:

```text
✔ Installed omp-ov-memory from omp-ov-memory-marketplace (0.1.0)
```

`omp plugin list --json` identifies that package with `scope: "project"`.
The actual OMP `loadExtensions` implementation was invoked through Bun against
the installed marketplace cache entry. It returned `errors: []`, all eleven
`viking_*` tools, commands `ov` and `viking`, and all fourteen registered hooks.
This verifies native loading without starting a paid agent turn.

`omp plugin doctor` exited 0:

```text
⚠ plugin:@heihei0299/pi-switch: v20260912.1.1 - No omp/pi manifest (not an omp plugin)
Summary: 10 ok, 1 warnings, 0 errors
```

That preexisting unrelated warning remains. Doctor audits the global npm plugin
directory; the native-loader result above is the relevant marketplace loading
evidence. Existing global plugins, including `pi-openviking`, were preserved;
the old memory extension must not be enabled alongside this replacement.

## Distribution audit

The npm package dry-run contains the extension, shared engine, MCP proxy, live
smoke script, skill, manifests and documentation. Runtime state, `node_modules`,
`.omp`, `.git` and credential files are excluded. A scan of repository files
against the actual configured API key found **zero matches**. Test tokens are
synthetic fixtures. Apache provenance and the clean AGPL implementation boundary
are recorded in [provenance](provenance.md).
