# Agents

Claude Code subagent definitions that ship with the dsv4shim profile. Each `.md` file is one
agent: YAML frontmatter (`name`, `description`, `tools`) followed by the instructions the
agent runs under. Claude Code discovers them under `<config-dir>/agents/`.

## Where these came from

Adapted from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
whose `.agents/skills/` tree and `docs/defensive-patterns.md` encode bug classes and review
discipline learned building that harness.

**The harness does not ship general-purpose subagents.** It ships eleven skills for
developing *that repository*, most of them bound to its own structure — its `AGENTS.md`
conventions, its Agent Notes tree, its pnpm gates, its bilingual doc pairing. Copying them
verbatim yields agents full of paths that do not exist here.

What ported is the methodology, restated to stand alone:

| Agent | Adapted from |
|---|---|
| `cot-leakage-trimmer` | `dsh-trim-cot-leakage` |
| `deep-code-reviewer` | `dsh-code-review` |
| `simplification-hunter` | `dsh-find-simplifications` |
| `lifecycle-auditor` | `docs/defensive-patterns.md` |
| `prose-auditor` | `dsh-prose-standard` |
| `pre-push-verifier` | `dsh-pre-push-checks` |

Dropped as unportable: `dsh-doc-site-sync`, `dsh-translate-docs`, `dsh-archive-agent-notes`,
`dsh-merging-stacked-prs`, `record-browser-gif`, and `dsh-doc-standards` — each depends on
repository-specific tooling, a doc-site layout, or an Agent Notes tree that has no counterpart
outside that project.

## Why `cot-leakage-trimmer` matters most here

It is the one directly aimed at running a reasoning model. Models that think at length before
answering carry that voice into the prose they write: comments arguing their own correctness,
docs narrating what changed rather than what is, citations to a design discussion no reader
can see. Linters cannot detect any of it, and every future reader pays for it.

## Adding one

Keep the frontmatter minimal — `name` and `description` are what Claude Code matches against,
so the description should say *when to use this*, not what it is. Restrict `tools` to what
the agent genuinely needs; a review agent that cannot write is a feature.
