# OpenViking API compatibility

The implementation targets the live OpenViking **v0.4.20** REST API under
`/api/v1`. Health is `/health`. `tests/client.test.mjs` includes an opt-in read-only
schema check: `OPENVIKING_LIVE_TEST=1 node --test tests/client.test.mjs`.

## Observed contracts

The following behaviors were checked against the local server using disposable
resource directories and a disposable session. Those resources were deleted after
the checks. Credentials were loaded in-process and were never written to this repo.

| Operation | Observed behavior |
| --- | --- |
| `GET /health` | `healthy: true`, version `v0.4.20`; no result wrapper |
| `POST /sessions` with explicit ID | First create HTTP 200; existing ID HTTP 409 |
| `POST /content/batch-write`, `mode: create` | First create HTTP 200; existing identical or different bytes HTTP 409 |
| Batch success result | `root_uri`, `created`, `updated`, `unchanged`, queue/semantic/vector statuses |
| `POST /content/write`, `mode: replace` | Creates a missing file and replaces an existing file |
| `POST /content/write`, `mode: create` | Creates a missing file |
| `POST /content/write`, `mode: append` | Creates a missing file |
| `POST /content/write`, `mode: upsert` | HTTP 400; not exposed by this client |
| `GET /fs/tree` | HTTP 200 with `level_limit`, `node_limit`, and `output` parameters |

`createSession` preserves the engine's create-or-reuse contract by verifying a
successful `GET /sessions/{id}` after a create conflict. An unreadable session is
not considered reusable.

## Immutable events and archives

The Apache upstream engine expects `create_if_absent` and `replace_if_hash`
preconditions. The live server's batch operation schema rejects extra fields and
only accepts `uri`, `content`, `content_base64`, and `mode`. It exposes no atomic
hash-compare replacement.

The adapter handles immutable create requests by reading any existing objects,
accepting only identical bytes, and sending the missing objects in one native
`mode: create` batch. It validates the batch acceptance lists and reads the stored
bytes back before reporting success. A racing writer can cause HTTP 409; later
replay reconciles identical bytes. Network-uncertain writes are never automatically
retried by the HTTP client.

A `replace_if_hash` request fails closed with `UNSUPPORTED_PRECONDITION` (501).
This prevents unsafe repair of a damaged archive manifest. An operator must
investigate a damaged archive rather than have the plugin overwrite it without
concurrency protection. The adapter does not claim transactional atomicity for the
whole server batch; immutable identities, result validation, and read-back protect
acknowledgment and archive publication.

## Credentials and request boundaries

Credential precedence is field-by-field: `OPENVIKING_*`,
`~/.openviking/ovcli.conf`, then `~/.openviking/ov.conf`. An existing older
`~/.pi/openviking/ovcli.conf` can be selected explicitly with
`OPENVIKING_CLI_CONFIG_FILE`; it is not an implicit fallback.

Remote bearer-authenticated endpoints require HTTPS. Requests never follow
redirects. Loopback requests use a direct Undici dispatcher, independent of global
proxy settings. Each HTTP call, including any safe read retry, has one deadline of
at most two seconds. Writes receive no automatic retry. Composite background
operations can issue multiple calls; lifecycle code bounds its own drain/wait.

HTTP failures expose sanitized status/code data and do not reflect response bodies,
request payloads, or credentials in error messages. Resource ingestion uploads
already vetted text through `resources/temp_upload` then references the returned
`temp_file_id`; the original URL is metadata, not a server-side fetch instruction.

## Authenticated storage scopes

Session isolation uses a subpath under the real authenticated user:
`viking://user/<user>/omp-ov-memory/sessions/<scope>`. It does not switch the
`X-OpenViking-User` header to an invented per-session identity. Scoped raw-engine
sync and byte-verified replay were tested against the live server, including a
cold scoped root; both succeeded, and the disposable scopes were removed.
Inventing another user with the existing non-root credential returned HTTP 403.

The client exposes `authenticatedUser`/`baseUserRoot` separately from scoped
`userRoot`/`memorySpace`. If the server cannot establish an actual user, identity
resolution returns empty rather than guessing `default`. Scoped recall uses
`target_uri` and verifies returned URI prefixes. Native server-extracted memories
remain in the authenticated user's canonical memory namespace; they are outside
strict session-scoped recall. Explicit scoped notes and the workspace handoff
bridge provide scoped and cross-session storage respectively.
