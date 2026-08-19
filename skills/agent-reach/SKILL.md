---
name: agent-reach
description: Use source-aware internet access for GitHub, YouTube, RSS, Reddit, X/Twitter, Bilibili, LinkedIn and other supported platforms. Prefer it for platform research, search, transcripts, and current facts.
---

# Agent Reach

Agent Reach is a capability router, not a second model. First check availability with `agent-reach doctor`. When it is installed, use the platform-specific command it reports as healthy and preserve the source URL in the answer.

Routing defaults:

- ordinary webpage: `mmclaude web <url>` (Defuddle/clean reader)
- GitHub repository/code: `gh repo view`, `gh search`, or Agent Reach's GitHub path
- YouTube/video: `yt-dlp`/Agent Reach transcript path; do not invent a transcript
- RSS/Atom: use the feed parser path
- Reddit/X/other logged-in platforms: only use credentials or a browser session the user has explicitly configured; never automate login or ask for cookies in chat

Use `agent-reach doctor` before claiming a channel is available. Cookies, proxies, external search keys, and desktop browser sessions are opt-in. The skill may guide setup but must not silently install system packages or upload credentials.
