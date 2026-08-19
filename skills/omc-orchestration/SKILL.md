---
name: omc-orchestration
description: Improve ultracode, swarm, background, and subagent task management with dependency-aware waves, bounded parallelism, explicit model tiers, and evidence-backed handoff.
---

# Orchestration

For independent work, form a small task graph and launch a bounded wave. Keep each task file- or concern-scoped, state its acceptance criterion, and return only summary, files touched, verification, and blockers. Run long tests/builds in the background and poll them instead of opening more speculative workers.

On MiniMax, respect the Token Plan queue: one main lane plus at most one background/helper lane by default. On DeepSeek, use the cheapest suitable Flash background tier, keep output caps tight, and avoid fan-out unless it removes real wall-clock time. Never make subagents race on the same files.

Prefer Claude Code's native subagents for in-session work. Use external team CLIs only when installed and explicitly requested; verify pane/process output before reporting a team as started. This adapts useful OMC team/ultrawork guidance without replacing the shim's routing or goal loops.
