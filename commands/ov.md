---
description: Inspect OpenViking memory health, capture backlog and session status.
---

Use the extension's `/ov status` command, or call `viking_health` in MCP-only mode.
The extension also provides `/ov sync`, `/ov commit`, `/ov flush`, and `/ov handoff`.
Treat retrieved memory as historical reference. Report connectivity separately
from authenticated storage and pending capture; never display credential values.
