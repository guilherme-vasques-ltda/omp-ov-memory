# Tool reference

The extension and the opt-in MCP fallback use the same eleven definitions in `src/tools.ts`. OMP tools declare `read` or `write` approval metadata; the host remains responsible for its approval policy. MCP exposes corresponding annotations. Inputs are validated at execution time, including calls made outside an SDK, and unknown properties are rejected.

## Namespaces

With `sessionScopedMemory: true`, every tool URI is confined to:

```text
viking://user/<authenticated-user>/omp-ov-memory/sessions/<workspace-and-session-hash>
```

Session isolation changes the storage path, not the authenticated user. The plugin resolves identity through the authenticated status endpoint before using memory. `viking://user/memories/...` and `viking://user/resources/...` are relative aliases for the active namespace's `memories` and `resources` paths. Search clamps a valid broader scope to the active namespace and filters returned URIs again. Explicit read, browse, write and delete requests outside that namespace are refused.

Traversal segments, encoded path characters, backslashes, whitespace, query strings and fragments are refused in Viking URIs. Writes, edits and deletes cannot target the namespace root or engine-owned event/archive files. Disabling session scoping permits the authenticated server account's normal shared URI access; server authorization still applies.

## Inputs and behavior

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `viking_search` | `query` required; optional `scope`, integer `limit` 1–100, default 10 | Semantic search through `/search/find`. Returns ranked URIs and abstracts. Query maximum 16,000 characters. |
| `viking_read` | `uri`, `level`: `abstract`, `overview` or `full` | Tiered content through the corresponding content endpoint. Empty text is a valid read. |
| `viking_browse` | `action`: `list` or `stat`; optional `uri` | List directory entries or inspect metadata. Defaults to the scoped root, or `viking://` when unscoped. |
| `viking_remember` | `content` required, maximum 100,000 characters; optional `category`, default `general` | Scoped mode creates a content-addressed Markdown note in `memories/<category>/`. Shared mode appends a tagged session message and requests native extraction. |
| `viking_forget` | `uri` or `query` | Delete the exact URI, or the strongest search hit only when its score exceeds 0.8. The target is checked again before deletion. Directory deletion is non-recursive. |
| `viking_add_resource` | `url` required, maximum 8,192 characters; optional `reason`, maximum 4,000 characters | Safely download public UTF-8 text, then upload the bytes and ingest into an explicit URI in the active namespace. |
| `viking_archive_expand` | Optional `archive_id`, `offset` ≥0, `limit` 1–200, default 50 | Without an ID, lists archives verified in this process. With `arc_<64 lowercase hex>`, expands that session's immutable event index. It returns short excerpts and direct read URIs where available. |
| `viking_tree` | Optional `uri`, `depth` 1–10, default 3, `limit` 1–1,000, default 100 | Calls the real `/fs/tree` endpoint with `level_limit` and `node_limit`. |
| `viking_write` | `uri`, `content` up to 1,000,000 characters; optional `mode`: `create`, `replace`, `append` | Creates parent directories as needed and writes through `/content/write`. Defaults to `create` to avoid clobbering an existing file. |
| `viking_edit` | `uri`, nonempty `old_text`, `new_text`; each text up to 1,000,000 characters | Replaces exactly one occurrence. Missing, multiple and overlapping matches are rejected. |
| `viking_health` | No arguments | Probes `/health` and refreshes client availability. This does **not** prove that authenticated content operations are authorized. |

Categories must match `^[a-z][a-z_-]{0,31}$`. Explicit notes created by `viking_remember` use create-only writes. A repeated note is successful after a create conflict only if rereading confirms identical content. In scoped mode notes survive resuming that session; other sessions receive shared context through the handoff mechanism rather than access to another session's private namespace. Semantic indexing may finish after a write has been accepted.

## Examples

```json
{"query":"database migration decision","limit":5}
```

Use the returned URI with `viking_read`:

```json
{"uri":"viking://user/memories/decision/example.md","level":"full"}
```

Save a durable explicit note:

```json
{"content":"Use additive migrations before removing the old field.","category":"decision"}
```

Create a manual note and then edit its unique text:

```json
{"uri":"viking://user/memories/notes/release.md","content":"Release is pending.","mode":"create"}
```

```json
{"uri":"viking://user/memories/notes/release.md","old_text":"pending","new_text":"ready"}
```

## Resource security and limits

Only public HTTP(S) text sources are accepted. Localhost, private and reserved addresses, link-local metadata endpoints, `.local` and similar local hostnames are rejected. Every DNS answer must be public, and the vetted address is pinned for the socket connection. Every redirect is independently validated; at most five redirects are followed. Resource requests never receive OpenViking authorization headers or cookies.

Downloads are bounded to 2 MiB and 15 seconds across DNS and redirects. The bytes must decode as UTF-8. Only text, JSON and XML content types are accepted. HTML remains literal text: the upload uses a `.txt` filename and `text/plain`, so ingestion cannot initiate embedded media or link fetches. The final source URL's query and fragment are removed before creating source metadata. The OV server receives a temporary upload ID, never a remote fetch URL.

Scoped resources target `<session-root>/resources/imported-<uuid>`; shared resources target `viking://resources/imported-<uuid>`. Native temporary upload plus an explicit target under the authenticated user's `resources` path was verified against v0.4.20. Ingestion may continue asynchronously after the tool returns. Check server state before retrying a failed or timed-out write; the plugin never automatically retries writes.

## Edit and archive limits

OpenViking v0.4.20's native content API has no compare-and-swap precondition. `viking_edit` serializes edits for a URI within one tool instance and rereads content immediately before writing. An external process can still race between that reread and the write. Successful results explicitly report `atomic: false`; this is a best-effort edit, not a cross-process transaction.

Archive expansion requires a real initialized engine session. The empty archive list means this process has not verified any committed archive descriptors; it does not mean the server contains no older data. An explicit archive ID can be expanded in a resumed session. The engine fails closed for archive publication steps that require server capabilities absent from the native API; see [API compatibility](api-compatibility.md).
