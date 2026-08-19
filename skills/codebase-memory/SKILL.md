---
name: codebase-memory
description: Use the local codebase-memory-mcp structural index for architecture, symbol, call-chain, impact, and cross-file questions before broad text search. Fall back to focused repository inspection when the MCP server is unavailable.
---

# Codebase memory

If `/mcp` shows `codebase-memory-mcp`, use its structural tools first for repository-wide questions: architecture, definitions, callers/callees, routes, dependencies, impact, and semantic code search. This reduces context waste and makes background/subagent work more targeted.

If it is unavailable, use focused `rg`, file reads, tests, and version-control history. Say “structural index unavailable” only when it matters; do not block a small task on optional infrastructure.

The server is local-only and has no model or API key. Do not run its installer automatically. If the user opts in, install it from the upstream project and restart the session so the shim-owned MCP config can be detected.
