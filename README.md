# mmclaude

Claude Code driven by **MiniMax M3 and M2.x tiers** instead of Anthropic models, with native
multimodal input, per-task thinking, token-usage tracking and optional local caps.

Your normal `claude` is untouched — this installs a separate profile under `~/.mmclaude`
and never reads your Anthropic credentials.

## Install

Three commands per platform — download, unpack, install. `mmclaude setup` prompts for your
MiniMax API key and finishes the rest.

**Linux / macOS / WSL**

```bash
cd ~/Downloads
curl -L -o mmclaude.zip https://github.com/OuiaOa/MMClaudeCode/archive/refs/heads/main.zip
unzip -q mmclaude.zip && cd MMClaudeCode-main
./install.sh
mmclaude setup
```

**Windows 11 (PowerShell)**

```powershell
cd $HOME\Downloads
curl.exe -L -o mmclaude.zip https://github.com/OuiaOa/MMClaudeCode/archive/refs/heads/main.zip
tar -xf mmclaude.zip
cd MMClaudeCode-main
powershell -ExecutionPolicy Bypass -File .\install.ps1
# open a new terminal so PATH updates
mmclaude setup
```

**macOS GUI alternative** — `Finder` double-click on `install.command` does the same as the
three shell lines above.

**Prerequisites** — Node 20+ (`node --version`) and the Claude Code CLI already installed
(`claude --version`). `mmclaude setup` will prompt you to install either automatically if they're
missing and the installer can reach npm. Full step-by-step with troubleshooting is in
[INSTALL.md](INSTALL.md).

MiniMax M3 accepts supported image and video blocks directly. No separate vision provider or
vision key is required.

## Use

```
mmclaude run                      launch Claude Code
mmclaude run --effort ultracode   full fan-out
mmclaude status                   shim state and stored keys
mmclaude-usage                    live 5-hour and weekly Token Plan percentages
mmclaude cap 10                   optional local dollar cap
```

On first `mmclaude run` your existing memories, session transcripts and permissions are imported
from `~/.claude`. The walk is recursive: subagent transcripts (`<session>/subagents/*.jsonl`)
and tool-result blobs (`<session>/tool-results/*`) come across too, so subagent sessions
appear in `--resume`. Transcripts are scrubbed of thinking-block signatures where needed;
native image and video blocks are passed through to MiniMax M3 for new requests.
Re-run manually any time with `mmclaude-import --force`. If `~/.claude` is missing or lives
elsewhere, run `mmclaude-import --source <path>` (or pass `--source` through `mmclaude run`).

Sessions are keyed by directory, so `cd` into a project and `mmclaude run --resume` finds its
history — including sessions originally created by the Claude Code desktop app, which writes
to the same `~/.claude/projects` tree.

## How it works

Claude Code is pointed at a local shim on `127.0.0.1:8788` rather than at Anthropic. The shim:

- **translates thinking.** M3 receives `thinking: {type: "disabled"}` for the default tier and
  `thinking: {type: "adaptive"}` for thinking tiers. M2.7/M2.5 tiers remain thinking-enabled.
- **routes by Claude tier.** Default uses M3 non-thinking; Fable and Opus use M3 thinking;
  Sonnet uses M2.7 thinking; Haiku uses M2.7-highspeed thinking; background work uses M2.5
  thinking when the account exposes it, otherwise M2.7-highspeed.
- **passes multimodal input natively.** M3 image and video blocks are forwarded directly, so
  there is no vision sidecar, image-description cache, or second provider to configure.
- **keeps a token ledger.** Each request records input, output and total tokens by tier and
  thinking mode. The live MiniMax Token Plan is queried separately; no artificial USD
  cost is inferred from the prepaid plan.
- **holds the key.** The real API key never enters Claude Code's environment; Claude Code
  authenticates to the shim with a locally generated sentinel.

## Claude Desktop / Cowork

The shim also works as a Gateway for Claude Desktop and Cowork — it's the same
Anthropic-compatible `/v1/messages` endpoint the CLI already uses, so no separate mode or
process is needed. In Desktop's Gateway settings:

- **Gateway URL**: `http://127.0.0.1:8788` (or your configured `port`/`bind`)
- **Auth**: either `Authorization: Bearer <sentinel>` or `x-api-key: <sentinel>` — the sentinel
  is the same one at `~/.config/mmclaude/sentinel` the CLI profile already uses.
- **Discover Models**: `GET /v1/models` returns four logical tiers — Fable, Opus, Sonnet,
  Haiku — each a Claude-looking model ID (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`,
  `claude-haiku-4-5-20251001` by default; see `desktop.tierModelIds` below to change them).

The tiers resolve to the configured MiniMax profiles: M3 thinking for Fable/Opus, M2.7 thinking
for Sonnet, M2.7-highspeed thinking for Haiku, and M2.5 thinking (with M2.7-highspeed fallback)
for background work. An explicit client preference still wins.

Everything else — streaming, tool calls, native images/video, long contexts —
works exactly as it does for the CLI, since Desktop and the CLI share this one endpoint.

## Files

| | |
|---|---|
| `~/.config/mmclaude/` | keys (0600), `config.json`, caps, probe results |
| `~/.local/share/mmclaude/` | code, `usage.jsonl` ledger and service logs |
| `~/.mmclaude/` | the isolated Claude Code profile |

## Tests

```bash
node test-shim.mjs        # unit tests against a mock endpoint, no spend
./e2e/run-e2e.sh all      # real sessions against the real API (costs a few cents)
```

## Configuration

`~/.config/mmclaude/config.json`. Every key below is read at shim start; restart after
editing (`mmclaude stop && mmclaude start`, or `systemctl --user restart mmclaude-shim`).

| key | meaning |
|---|---|
| `port` | shim listen port (loopback only). `MMCLAUDE_PORT` overrides. |
| `model` | the only model allowed. Anything else is refused, so a stray config cannot bill a pricier model. |
| `modelSlots` | maps the sentinel model ids Claude Code sends to a slot: `main`, `subagent`, `background`. |
| `denyModelPatterns` | hard-refused non-MiniMax model names. |
| `effort.slotDefaults` | thinking policy per slot. The default profile is non-thinking; configured tiers enable thinking. |
| `effort.translate` | Claude Code's effort vocabulary → MiniMax thinking on/off. |
| `effort.autoLevel` | the level treated as "no preference". Claude Code sends a level on *every* request, so explicit-vs-default is otherwise unobservable. |
| `effort.heuristic` | scoring for auto-escalation; `enabled: false` turns it off entirely. |
| `rates` | Kept at zero for Token Plan use; usage is reported in tokens, not fabricated USD. |
| `balanceUrl` | MiniMax Token Plan remains API endpoint, polled for live quota snapshots. |
| `cap.dailyUsd` | Optional local dollar-style guard; Token Plan quota remains authoritative. |
| `trafficPolicy` | Concurrency, start pacing and helper output limits. Defaults to two active agent lanes and one background lane, so ultracode/swarm queues instead of bursting. |
| `pausePolicy` | Pauses new upstream work when the live Token Plan interval is nearly exhausted, then refreshes at the provider's `end_time` so long-running goals can resume without losing their Claude session. |
| `desktop.tierModelIds` | external Claude-looking model IDs Desktop discovers via `/v1/models`, one per logical tier (`opus`/`sonnet`/`fable`/`haiku`). Optional — omitting it falls back to the same IDs built into `shim.mjs`. |
| `effort.tierDefaults` | reasoning-effort default per Desktop tier, used only when the client sends no explicit effort of its own. Optional, same fallback pattern as above. |

### Sibling-safe ports

`port` is the preferred port. At startup MMClaude checks whether it is live or reserved by
another local service and walks upward to the next usable port when necessary. It also remembers
the selected port in `~/.local/share/mmclaude/active-port.json`, so the profile, statusline and
updater keep following an automatic shift.

Installed sibling configs with a numeric `port` in `~/.config`, `~/.local/share`, or the local
Codex workspace are treated as reservations even when the sibling is stopped. Every shim also
records its claim in the shared `~/.config/codex-port-reservations.json` registry; future local
programs can participate by writing an entry with their name and port. Set
`CODEX_SHIM_PORT_REGISTRY` only when testing or intentionally using a separate registry.

The statusline and `mmclaude-usage` show MiniMax's provider-reported 5-hour and weekly
remaining percentages. They do not label the local response-token ledger as plan usage; the
ledger is retained only for request diagnostics. The pause policy is deliberately conservative: it waits for the rolling window and keeps the
same Claude request open. MiniMax documents Token Plan and pay-as-you-go as separate API-key
modes, so the shim never silently switches to a potentially billed fallback key. If you choose
to use pay-as-you-go Credits instead, change the configured key explicitly and restart the shim.

## Troubleshooting

**`shim is not responding`** — `mmclaude status`, then `mmclaude start`. On Linux with systemd:
`journalctl --user -u mmclaude-shim -n 50`. Otherwise the log is
`~/.local/share/mmclaude/shim.log`.

**Images are rejected** — check that the request is using MiniMax M3 and that the image is in a
supported image block format. No separate vision key is needed.

**`daily cap reached`** — `mmclaude cap 10` to raise it. Note `0` means *disabled*, not zero.

**A session will not resume** — transcripts imported from `~/.claude` are scrubbed of thinking
signatures and images, but a session created by a much older client may still not replay.
Starting fresh in the same directory always works; your code and `CLAUDE.md` are what matter.

**Usage looks wrong** — `mmclaude-usage` shows the local token ledger and the latest Token Plan
snapshot. Token Plan quota is authoritative; the ledger is the per-request detail.

## Known limitations

- **No image generation through this Claude-compatible path.** Image and video understanding are
  native on MiniMax M3; document support depends on the upstream block type.
- **`/cost` inside Claude Code reports $0.** It prices from an embedded table keyed on model
  name, which a `minimax-*` id misses. Use `mmclaude-usage`, or the statusline.
- **Only `/v1/messages` is proxied.** Other paths are refused rather than forwarded, because
  anything forwarded would bill your key without appearing in the ledger or the cap.
- **Web search** is an Anthropic server-side tool and is not available.
- **Caps are per machine.** Four machines at $5/day is a $20/day ceiling in aggregate.

## Development

```bash
node test-shim.mjs        # 77 unit tests against mock endpoints — no network, no spend
./e2e/run-e2e.sh all      # real sessions against the real API (a few cents)
./e2e/run-e2e.sh tools    # tool coverage only, no vision
./package.sh out.tar.gz   # build a portable archive
```

The shim calibrates itself from `probe-results.json`, written by `probe.mjs` during setup —
the endpoint's real effort enum, whether the usage object reports the cache split, and whether
`count_tokens` exists were all determined by measurement, because the published documentation
contradicts itself on two of them and is silent on the third.

## Licence

MIT — see [LICENSE](LICENSE).

By Ouia Oa.
