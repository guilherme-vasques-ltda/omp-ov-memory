# Source provenance

`omp-ov-memory` is distributed under the Apache License, Version 2.0. The root
[LICENSE](../LICENSE) preserves that license text, and [NOTICE](../NOTICE)
identifies the reused engine and design references.

## Apache-licensed implementation reused

The principal implementation source is **`pi-openviking@0.4.4`**, whose package
manifest declares Apache-2.0. Development used the locally installed package at
`~/.omp/plugins/node_modules/pi-openviking/`. It was not an AGPL fork of that
package.

The reused implementation includes the event projection and canonical-object
model, immutable RecordedEvent storage, ancestry ACKs, archive verification,
checkpoint/active-context machinery, recall helpers, URI guards and observability
helpers. Those modules reside primarily in `src/shared/` and `src/lib/`.
Client, config, sync, recall and the original tool definitions were adapted from
the same Apache source.

Project modifications include:

- OMP/Pi-compatible entry wiring and structural host types, plus native Node
  TypeScript imports using `.ts` suffixes.
- Actual OpenViking v0.4.20 API adaptation: create-mode batches, byte reconciliation,
  unsupported-CAS failure, create-or-reuse session verification and peer IDs.
- Bounded HTTP calls, safe read-only retry, redirect/auth protections, direct
  loopback dispatch and guarded client shutdown.
- Required credential precedence, validated configuration, private state paths and
  authenticated storage scopes that do not invent user identities.
- Capture filtering before projection, durable hook replay, historical recall
  ledger, workspace routing and cross-agent handoff integration.
- Additional tool validation and resource-fetch security, direct scoped explicit
  notes, and a stdio MCP implementation sharing the same tool layer.

Some internal hash domains and remote managed path segments intentionally retain
`pi-openviking` or `.pi-openviking` for compatibility with the reused event format.
Those names identify serialization/storage domains, not a second installed
plugin or a license change. Existing local upstream patches for `peer_id` and a
safe `close()` guard were preserved in adapted form.

## MIT design reference

[akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) is an MIT-licensed
design reference for workspace markers, cross-agent handoff, bounded asynchronous
hook queues and capture allow/deny policy. Its backend is not incorporated: this
plugin uses OpenViking rather than that project's Rust/SQLite memory service.
The corresponding modules were written for this package's TypeScript and
OpenViking contracts. No MIT implementation files were vendored as part of this
design adaptation.

## AGPL boundary

[cortexc0de/omp-openviking-memory](https://github.com/cortexc0de/omp-openviking-memory)
is AGPL-3.0 and was treated only as a public feature-description reference. Its
README motivated the four additional tool names (`viking_tree`, `viking_write`,
`viking_edit`, `viking_health`), optional MCP fallback, `/ov` alias, and stable
recall-ledger behavior.

No AGPL implementation code was read, copied, translated, or vendored for this
build. The additional tools and proxy were independently implemented against the
live OpenViking OpenAPI surface and the shared Apache-licensed client. The ledger
was independently implemented with private per-turn records. Public feature names
and behavioral ideas do not identify copied implementation files.

## Validation and distribution boundaries

Compatibility claims are grounded in local source inspection, tests and isolated
live API probes; configuration discovery and health alone are not proof of a
working authenticated memory flow. [API compatibility](api-compatibility.md)
records observed server differences and unsupported operations.

The repository remains local and unpublished at delivery. No GitHub push is part
of this build, and credentials or runtime memory data are not distribution
artifacts. Installed npm dependencies retain their own licenses; the package
lockfile records the resolved dependency versions.
