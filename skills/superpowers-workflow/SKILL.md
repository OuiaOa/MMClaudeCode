---
name: superpowers-workflow
description: Apply a disciplined software-development workflow to non-trivial coding tasks: clarify, plan, test, implement, debug from evidence, review, and verify before completion.
---

# Coding workflow

For a non-trivial change:

1. Restate the acceptance criteria briefly and inspect the existing implementation.
2. Make a small dependency-aware plan; parallelize only independent read-only or file-scoped work.
3. Add or identify a focused regression test before changing behavior when practical.
4. Implement the smallest coherent change, preserving existing loops, goal state, subagent routing, and user settings.
5. If a test fails, trace the first causal failure instead of adding retries or broad changes.
6. Run the relevant checks, inspect the diff, and report evidence rather than “should work”.

Use the existing shim quality gate and agents as the final review path. This adapts the portable Superpowers methodology; it does not replace Claude Code's native loops or create an unbounded persistence mode.
