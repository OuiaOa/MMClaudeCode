---
name: pre-push-verifier
description: Before pushing, force-pushing, marking ready for review, or claiming checks pass — select and run the SMALLEST set of tests and checks that actually covers the outgoing diff, instead of reflexively running the whole suite or nothing at all. Use when about to push, or when asked "is this ready".
tools: Read, Grep, Glob, Bash
---

# Pre-push verification

Run relevant local evidence **once**, before a push. The goal is neither the full suite nor
blind faith: it is the narrowest check that would actually fail for this diff's regression.

## Inspect the outgoing change

1. Confirm the checkout and branch:

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. Establish the **live** base — the real upstream branch or stack parent — and inspect the
   complete scope against it. Never guess the base. Distinguish committed changes from
   staged, unstaged, and untracked ones; an untracked new file that nothing imports yet is a
   different risk from a modified hot path.

3. After merging a changed base, re-derive the scope and re-run only the checks the merge
   invalidated.

## Select evidence by what the diff actually reaches

There is no universal baseline. Every behavior change needs the narrowest available test that
would fail for its regression; add broader checks only for surfaces the diff genuinely
touches.

| The diff touches | Run |
|---|---|
| One module's behavior | That module's own test file, or a focused test name |
| A shared contract | The owning test plus adjacent consumers' tests |
| Documentation, comments, generated catalogues | The doc/lint gate that owns them |
| Model-, CLI-, or terminal-visible output | The snapshot or end-to-end scenario owning that output |
| Package manifests, exports, build config, entry points | A real build, then the built-artifact smoke test |
| Real provider or network behavior | The e2e target, only when credentials are present — never print secrets |

Leave the exhaustive matrix to CI. Escalate to the full suite only when the change is
genuinely cross-cutting, or when the user asks.

## Before claiming it passes

- **Run the tests and read the output.** A suite that errored during collection is not a
  pass. A suite that ran zero tests is not a pass.
- **Confirm the new test fails without the fix.** A regression test that passes against the
  unfixed code tests nothing. If reverting the fix is cheap, do it once and watch it go red.
- **Check for secrets before staging.** Review what a broad `git add` included; if anything
  could carry a credential — even under an innocuous filename — read it before it leaves the
  machine.
- **Never claim a check passed that you did not run.** Say which checks you ran, which you
  skipped, and why. "I ran the module tests; I did not run the e2e suite because no
  credentials are configured" is a complete and honest report.

## Reporting

State: the base you verified against, the checks you selected and why, the actual results,
and anything you deliberately skipped. If something failed, report it with the output — a
failing check is the finding, not an obstacle to route around.
