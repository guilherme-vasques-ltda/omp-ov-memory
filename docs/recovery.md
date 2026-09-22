# Durability and recovery

The plugin provides recoverable, at-least-once event synchronization. It does not promise exactly-once delivery of every external side effect.

## What survives an outage

When OpenViking is unavailable, the hook queue keeps captured, policy-filtered jobs under:

```text
<stateDir>/pending/<identity-hash>/<ordered-id>.json
```

The default `stateDir` is `~/.openviking/omp-ov-memory`. Queue identity includes destination/workspace routing and a credential fingerprint, and each job keeps its original session identity. Directory permissions are `0700`; record permissions are `0600`. Temporary files use exclusive creation, are fsynced, and are atomically renamed. A directory fsync follows publication. The spool can contain conversation data, so treat it as private user data even though it never stores the HTTP authorization token as queue metadata.

A successful `enqueue()` means the event passed capture filtering and asynchronous local persistence started. It is not a disk-durability acknowledgement. An abrupt process or machine failure before persistence completes may require recovery from OMP's original session JSONL. Pending files that have completed publication survive process restart. Complete temporary records left by a dead writer are recovered; malformed/incomplete temporaries are retained and reported rather than treated as delivered.

Disk errors cannot be turned into successful remote delivery. Failed spool writes retain their filtered bytes in the live process for retry, and surface `spool_write_failed`. If the process exits while the disk remains unwritable, only already persisted jobs and the original OMP transcript remain recoverable.

Sync snapshots store the tree once and the branch as ordered entry IDs. Consecutive snapshots of the same session coalesce before delivery; hooks and session changes are ordering barriers. Each flush enforces a 64 MiB / 7-day retention budget under the process lease: expired records are removed, then oldest syncs, then oldest hooks if still over the byte cap. An uncertain in-flight handler retains its lease, deferring cleanup until it settles. `/ov status` exposes the last measured `bytes` and the process-local `dropped` counter; the status bar also shows drops. Budget drops emit `spool_budget_drop` and require the original OMP transcript for recovery.

## Replay sequence

1. Initialize the same endpoint, account, configured user, credential identity and workspace routing.
2. Discover pending records and recover complete temporary files whose writer is no longer running.
3. Acquire the spool's process lease. A live owner causes the competing dispatcher to defer.
4. Reapply the current capture policy before delivery. Newly excluded jobs are removed without being sent; further redaction is persisted.
5. Deliver in filename order, using the original session/namespace. A sync job verifies raw-event objects, then reconciles its native text mirror. The current handler finishes before another record is attempted.
6. Remove a record only after both required stages confirm success. An unknown mirror outcome or another failed stage leaves that record and its successors pending, even if raw-event ACK already advanced.

An acknowledged prefix of a session remains acknowledged when a later entry fails. Replayed RecordedEvents have the same deterministic IDs; the client reconciles already stored identical bytes. Lost local ACK state causes additional verification/replay rather than a reason to skip unproven remote data.

Changing endpoint, account, configured user, credential or workspace identity intentionally selects a different spool. Credential rotation therefore does not silently reassign old pending data to a new principal. The plugin does not send one destination's captured history to another automatically. Keep the original identity available if you need to drain its backlog.

## Timeout and shutdown behavior

The default per-handler timeout is 2 seconds. Timeout aborts the handler signal and ends the wait, while the durable record remains. An abort-ignoring handler retains its lease until it settles, so another consumer does not immediately overlap the uncertain operation. A late successful result removes the record; a late failure retains it.

`drain(timeoutMs)` bounds the time a caller waits. `dispose(timeoutMs)` stops accepting records, cancels the timer, aborts delivery and joins accepted disk writes and the in-flight flush/lease cleanup within the remaining budget. Runtime shutdown reserves 450 ms for queue disposal inside OMP's 2-second hook window. Abandoned lease temporaries are collected when their owner is dead; malformed fragments age out. A bounded shutdown may finish with pending work or an abort-ignoring handler. It does not mark that work delivered or prove that a timed-out request never reached its destination; late handlers cannot acknowledge records after disposal.

Replay-safe raw-event writes use deterministic identities and byte reconciliation. Native text append and commit use the separate durable mirror guard described below. Explicit resource ingestion and other non-idempotent tool side effects still need their own outcome checks. Do not manually repeat an uncertain write just because the extension returned control.

## Native message and commit uncertainty

OpenViking v0.4.20 retains `source_message_ids` but does not deduplicate messages by them. The mirror publishes an append intent before sending each approved text message. Intent and acknowledgment files under `<stateDir>/session-mirror/<identity-hash>/` store source IDs, content digests and the native session's creation timestamp, rather than another copy of the message text. They use private permissions and create-only durable publication.

| Mirror status | Interpretation |
| --- | --- |
| `confirmed` | Number of locally acknowledged source-message identities from the latest metadata load/reconciliation |
| `unknown` | Number of published append intents without an acknowledgment |
| `commitUnknown` | At least one commit intent lacks an acknowledged outcome |
| `lastError` | Latest stable mirror error code; inspect alongside the counts |

For message append, only a matching source ID and role/content digest in the same server-session generation can establish positive confirmation. Inspection can read active messages, raw native message JSONL and archived messages. Missing, truncated or changing history is not proof that an append failed. An intent can even remain unknown if the process stopped between intent publication and network submission; absence does not make automatic replay safe.

For commit, a create-only intent records the confirmed-source watermark, session generation and preceding commit counter. A successful accepted/skipped response acknowledges submission. After an uncertain response, a later commit counter greater than that recorded value on the same session generation can resolve the intent. If the counter has not advanced, the plugin does not resubmit. An acknowledged commit is not proof that asynchronous model extraction or its summary succeeded.

Mirror uncertainty stops later native appends and ordered queue progress. Already verified raw objects and the private pending records remain intact; pending count can therefore be nonzero while raw sync reports no undelivered entries. The checkpoint processor uses the same guard for its task input and commit, so restart/polling does not blindly repeat its provider-triggering submissions.

Useful mirror errors include:

| Code | Meaning |
| --- | --- |
| `MIRROR_OUTCOME_UNKNOWN` | An append intent lacks positive readback; automatic replay is refused |
| `MIRROR_COMMIT_UNKNOWN` | A commit intent has no confirmed submission or later counter advancement |
| `MIRROR_INCOMPLETE_REMOTE_VIEW` | Required active/archive evidence could not be fully inspected |
| `MIRROR_REMOTE_CHANGED` | Remote session metadata changed while it was being inspected |
| `MIRROR_SESSION_REPLACED` | The native session's creation timestamp no longer matches local intents |
| `MIRROR_CONTENT_CONFLICT` | A stable source identity disagrees with its recorded content digest |
| `MIRROR_DUPLICATE_SOURCE` | More than one contradictory remote message claims the same source identity |
| `MIRROR_ACK_NOT_VISIBLE` | Previously acknowledged content could not be confirmed in the inspected remote view |

Restore server access and allow readback reconciliation first. Preserve intents when investigating unresolved cases: deleting them removes the evidence that prevents duplicate appends or commits. Do not treat a new native session with the same name as the old session, or reset its generation proof just to make status green. Some uncertain outcomes require operator investigation; this conservative behavior deliberately favors retained capture over blind replay.

## Archive and checkpoint limits

The delivery layers have separate meanings:

| Evidence | What it establishes |
| --- | --- |
| `/health` succeeds | The server responds and reports healthy |
| Queue record published | Filtered job is persisted locally |
| RecordedEvent verified and ACK advanced | That entry's required content objects were accepted and verified |
| Native mirror `confirmed` | Matching source identity/content was acknowledged for native text history |
| Commit intent acknowledged | Commit submission was accepted/skipped or later native counter progress reconciled it; extraction may still be incomplete |
| Archive manifest and event hashes verify | That archive's declared range is reconstructable |
| Checkpoint fact completes | The checkpoint workflow produced its own verified result |
| Ledger block reapplied | The saved historical block bytes were reused |

A failure at one derived layer does not erase verified event facts from another. Archive/checkpoint errors are visible separately from pending event count.

OpenViking v0.4.20 does not offer the atomic hash-conditional replacement expected by upstream repair paths. The client returns `501` / `UNSUPPORTED_PRECONDITION` when such a repair is requested. A truncated/corrupt existing manifest or marker may therefore need operator intervention or a future server capability. Automatic unconditional replacement would weaken conflict protection and is deliberately not used.

## Inspecting problems

Use `/ov status` for current extension state and `viking_health` for a server connectivity check. Neither proves that all historical events or checkpoints are complete. Check queue pending/error state and archive/checkpoint state independently.

Common queue error codes:

| Code | Meaning |
| --- | --- |
| `capture_rejected` | Filter/serialization failed closed |
| `spool_write_failed` | Local private persistence could not complete; live process retains retry bytes |
| `spool_incomplete` | A dead writer left an invalid temporary record; retained for diagnosis |
| `spool_budget_drop` | Retention removed an expired or over-budget record; inspect `dropped` |
| `queue_busy` | Another live dispatcher owns the spool |
| `delivery_failed` | Handler rejected; ordered replay stopped at that record |
| `delivery_timeout` | Handler exceeded its deadline; outcome may still be uncertain |
| `queue_io_failed` | Directory, record parsing or lease I/O failed |
| `lease_release_failed` | Lease cleanup failed; records remain available |

Diagnostics use codes, not captured payloads or arbitrary exception text. Do not paste spool files, session JSONL or credential configuration into a public issue.

A `.lease` file identifies the owner process. A dead process's lease is reclaimed on replay; a PID that is still alive is treated conservatively as an owner. Do not delete a lease while that process could still be delivering work. Unexpected PID reuse or external modifications may require stopping the relevant agents and verifying ownership before removing stale state.

Retain a private backup of malformed files before any manual repair. Deleting pending records discards their local recovery source. Deleting raw sync ACK files triggers byte-reconciled raw replay, while deleting native mirror intent/ACK files can discard non-idempotent outcome evidence and is not a safe retry procedure. Deleting recall-ledger files loses historical prompt-block stability. Restore server access and let normal replay reconcile data before considering local state removal.

## Verification

`tests/hook-queue.test.mjs` exercises offline persistence/restart, file permissions, policy-before-write and replay filtering, overflow without loss, concurrent flushes, two consumers, uncertain timeout, bounded shutdown, and interrupted temporary recovery. `tests/sync.test.mjs` covers filtering persisted JSONL, fail-closed filters, ancestry ACK, deterministic outage replay, serialized sync/commit, and cancellation between writes. `tests/session-mirror.test.mjs` additionally covers positive append readback, durable unknown outcomes, restart reconciliation, duplicate-source conflicts, incomplete/truncated native views and guarded commit submission. These tests use local temporary files and controlled handlers; they do not prove paid live VLM extraction or perform production memory writes.
