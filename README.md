# claude-dsv4f

Claude Code driven by **DeepSeek V4 Flash 0731** instead of Anthropic models, with per-task
thinking effort, image support, spend tracking and daily caps.

Your normal `claude` is untouched — this installs a separate profile under `~/.claude-dsv4f`
and never reads your Anthropic credentials.

## Install

**New here? Read [INSTALL.md](INSTALL.md)** — step-by-step for Windows 11, macOS and Linux,
including prerequisites and troubleshooting. The short version:

**Linux / macOS / WSL**

```bash
tar -xzf claude-dsv4f-*.tar.gz
cd claude-dsv4f && ./install.sh
dsv4f setup
```

**Windows 11 (PowerShell)**

```powershell
tar -xzf claude-dsv4f-*.tar.gz
cd claude-dsv4f
powershell -ExecutionPolicy Bypass -File .\install.ps1
# open a new terminal so PATH updates
dsv4f setup
```

Requires Node 20+ and the Claude Code CLI already installed. `dsv4f setup` prompts for your
DeepSeek API key (hidden — never echoed, never in argv or shell history), probes the endpoint
to calibrate itself, writes the profile, and starts the shim.

Optionally `dsv4f key deepinfra` to enable screenshots — DeepSeek's endpoint cannot accept
images, so they are transcribed by a vision model first.

## Use

```
dsv4f run                      launch Claude Code
dsv4f run --effort ultracode   full fan-out
dsv4f status                   shim state and stored keys
dsv4f-usage                    spend, burn rate, balance
dsv4f cap 10                   daily DeepSeek cap
dsv4f cap vision 3             daily vision cap
```

On first `dsv4f run` your existing memories, session transcripts and permissions are imported
from `~/.claude`. Transcripts are scrubbed of thinking-block signatures (which DeepSeek cannot
validate) and image blocks (unsupported), without which old sessions cannot be resumed.
Re-run manually any time with `dsv4f-import --force`.

Sessions are keyed by directory, so `cd` into a project and `dsv4f run --resume` finds its
history — including sessions originally created by the Claude Code desktop app, which writes
to the same `~/.claude/projects` tree.

## How it works

Claude Code is pointed at a local shim on `127.0.0.1:8788` rather than at Anthropic. The shim:

- **translates effort levels.** Claude Code emits `low|medium|high|xhigh`; the endpoint accepts
  `low|medium|high|xhigh|ultra|max` (measured, not documented). Ultracode means `xhigh`, which
  DeepSeek treats as an unknown variant, so it is rewritten to `max` — that rewrite is what
  makes ultracode work at all.
- **chooses effort per task.** Background calls (titles, summaries) run with thinking off;
  routine turns at `high`; detected-hard turns at `ultra`; `ultrathink` or ultracode at `max`.
  A level you set explicitly is never overridden.
- **routes images.** Image blocks are swapped for text descriptions from a vision model.
  Descriptions are cached by image hash and replayed byte-identically, which both avoids
  re-describing and keeps the prompt prefix stable for DeepSeek's 50x cache-hit discount.
  Say what you need from a screenshot, or write `VISION: <what to look for>`.
- **keeps the ledger.** Neither provider exposes a usage API, so per-request cost is computed
  locally, per provider, and enforced against separate daily caps.
- **holds the key.** The real API key never enters Claude Code's environment; Claude Code
  authenticates to the shim with a locally generated sentinel.

## Files

| | |
|---|---|
| `~/.config/claude-dsv4f/` | keys (0600), `config.json`, caps, probe results |
| `~/.local/share/claude-dsv4f/` | code, `usage.jsonl` ledger, vision cache |
| `~/.claude-dsv4f/` | the isolated Claude Code profile |

## Tests

```bash
node test-shim.mjs        # 77 unit tests against a mock endpoint, no spend
./e2e/run-e2e.sh all      # real sessions against the real API (costs a few cents)
```

## Configuration

`~/.config/claude-dsv4f/config.json`. Every key below is read at shim start; restart after
editing (`dsv4f stop && dsv4f start`, or `systemctl --user restart claude-dsv4f-shim`).

| key | meaning |
|---|---|
| `port` | shim listen port (loopback only). `DSV4F_PORT` overrides. |
| `model` | the only model allowed. Anything else is refused, so a stray config cannot bill a pricier model. |
| `modelSlots` | maps the sentinel model ids Claude Code sends to a slot: `main`, `subagent`, `background`. |
| `denyModelPatterns` | hard-refused substrings. Ships with `deepseek-v4-pro`. |
| `effort.slotDefaults` | effort per slot. Background is `none` (thinking off). |
| `effort.translate` | Claude Code's vocabulary → the endpoint's. `xhigh → max` is what makes ultracode work. |
| `effort.autoLevel` | the level treated as "no preference". Claude Code sends a level on *every* request, so explicit-vs-default is otherwise unobservable. |
| `effort.heuristic` | scoring for auto-escalation; `enabled: false` turns it off entirely. |
| `rates` | USD per million tokens, with the cache-hit/miss split. |
| `peakSurcharge` | DeepSeek announced 2× peak pricing but has not activated it. Enable if it goes live. |
| `cap.dailyUsd` | DeepSeek daily cap. Overridden by the `cap` file / `dsv4f cap`. |
| `vision.*` | model, endpoint, rates, `dailyCapUsd`, and `promptVersion` — bumping the last invalidates every cached description. |

## Troubleshooting

**`shim is not responding`** — `dsv4f status`, then `dsv4f start`. On Linux with systemd:
`journalctl --user -u claude-dsv4f-shim -n 50`. Otherwise the log is
`~/.local/share/claude-dsv4f/shim.log`.

**Images say "description unavailable"** — no DeepInfra key on this machine. `dsv4f key
deepinfra`, or ignore it if this box does not need screenshots.

**`daily cap reached`** — `dsv4f cap 10` to raise it. Note `0` means *disabled*, not zero.

**A session will not resume** — transcripts imported from `~/.claude` are scrubbed of thinking
signatures and images, but a session created by a much older client may still not replay.
Starting fresh in the same directory always works; your code and `CLAUDE.md` are what matter.

**Costs look wrong** — `dsv4f-usage --reconcile` cross-checks the local ledger against actual
balance drawdown and derives your real cache-hit ratio. Neither provider exposes a usage API,
so the ledger is the only per-request record.

## Known limitations

- **No image *generation*, and no document blocks.** DeepSeek's Anthropic-compatible endpoint
  accepts neither; images are transcribed to text, documents are dropped with a note.
- **`/cost` inside Claude Code reports $0.** It prices from an embedded table keyed on model
  name, which a `deepseek-*` id misses. Use `dsv4f-usage`, or the statusline.
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
