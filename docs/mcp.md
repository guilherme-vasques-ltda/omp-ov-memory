# Optional MCP fallback

`servers/mcp-proxy.mjs` is a clean Apache-2.0 stdio MCP implementation backed by the same client and eleven tool definitions as the OMP extension. The packaged legacy OMP manifest does not automatically load `mcp.json`; it is a manual opt-in configuration. Enable it only in a host that needs tools without the extension, to avoid duplicate `viking_*` tools.

The fallback provides explicit tool calls. Automatic capture, context-hook recall, ledger injection, handoff injection and compaction handling require the extension.

## Start the server

Use Node 22.19 or newer. Install the package dependencies before launching the source checkout.

```sh
npm ci
OPENVIKING_SESSION_ID=my-session node /absolute/path/omp-ov-memory/servers/mcp-proxy.mjs
```

Configure your MCP host to run the same command with `node` and the absolute script path as its first argument. Set the process working directory to the actual project, because workspace routing and session scope depend on it. Keep credentials in environment variables or supported OpenViking configuration files; never put real keys in committed MCP JSON.

An illustrative host configuration:

```json
{
  "mcpServers": {
    "omp-ov-memory": {
      "command": "node",
      "args": ["/absolute/path/omp-ov-memory/servers/mcp-proxy.mjs"],
      "env": {
        "OPENVIKING_URL": "http://127.0.0.1:1933",
        "OPENVIKING_SESSION_ID": "my-session"
      }
    }
  }
}
```

The precise host configuration format may differ. The packaged `mcp.json` is an opt-in fallback descriptor; it is not an instruction to enable a second copy beside the extension.

## Identity and session behavior

The proxy first resolves the actual authenticated user through `/api/v1/system/status`. It never invents or impersonates a user ID for session isolation. With the default scoped configuration, it uses:

```text
viking://user/<authenticated-user>/omp-ov-memory/sessions/<workspace-and-session-hash>
```

Use the extension's original session ID and the same workspace routing to read its private memory or expand a known archive. `OPENVIKING_SESSION_ID` accepts 1–160 letters, digits, periods, underscores or hyphens. If omitted, the proxy creates a random session ID, so each new proxy process has a fresh isolated namespace. Choose a stable explicit ID to resume memory across restarts.

The engine session is initialized when a remember or archive tool needs it. Archive listing is limited to descriptors verified in this process. Scoped `viking_remember` creates notes under the scoped path; shared mode retains native message extraction. Credentials and plugin configuration follow the same precedence as the extension.

## Protocol

Transport is newline-delimited UTF-8 JSON-RPC 2.0 on stdin/stdout. Stdout contains protocol messages only. Supported methods are:

- `initialize`, `ping`, `tools/list`, `tools/call`.
- `notifications/initialized` and `notifications/cancelled`.

The server supports protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`. Unknown versions receive `2025-11-25` so the client can negotiate or disconnect. Tool definitions include input schemas and MCP tool annotations. Extension `details` are returned as MCP `structuredContent` alongside readable text content.

Malformed JSON, invalid requests, unknown methods and invalid call envelopes produce JSON-RPC errors. Tool argument validation, unavailable memory and operation failures produce tool results with `isError: true`. The server caps each input message at 2 MiB and concurrent calls at 32.

Cancellation aborts cooperative tool work and suppresses its later response. A request already submitted to OpenViking may still complete, particularly a write; the cancellation error says so. Writes are never automatically replayed. On EOF or termination, the proxy allows a bounded two-second drain and closes the engine/client.

## Verification

`tests/mcp-proxy.test.mjs` spawns the real proxy in a child Node process with an isolated home directory and a local fake OpenViking HTTP server. It verifies initialization, discovery of all eleven tools, authenticated HTTP requests, workspace/session paths, create/read/edit, scoped remember, archive behavior, protocol errors and cancellation. This proves the stdio-to-shared-client execution path without relying on a configured manifest as evidence of execution.
