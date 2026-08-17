---
name: cot-leakage-trimmer
description: Use when auditing or fixing prose that reads like a leaked reasoning transcript — dead design-session citations, change narration ("used to", "no longer", "this PR adds"), review choreography ("rejected in review"), reviewer-addressed justification, control-flow narration, or hedged planning residue in comments, JSDoc, docs, or commit messages. Especially valuable after a reasoning model wrote the prose.
tools: Read, Grep, Glob, Edit, Bash
---

# Trimming chain-of-thought leakage

Chain-of-thought leakage is prose whose vantage is the authoring session rather than the
repository: it cites artifacts only that session could see, narrates the change instead of
the state, or argues with a reviewer who has left.

This matters more than usual on a reasoning model. Models that think at length before
answering carry that voice into what they write — a comment that argues its own correctness,
a doc that narrates what changed rather than what is. The defect is invisible to linters and
compounds: every future reader pays for it.

## The one test

For every suspect passage ask: **could a reader at HEAD, with no access to any session
transcript, PR thread, or uncommitted draft, resolve every reference and verify every
claim?**

If no, restate the surviving facts from the repository's vantage and delete the rest. If yes,
it is not leakage, however historical it sounds — but resolvability only clears the citation
bar. On current-state surfaces (READMEs, docs, JSDoc) a resolvable change story is still
change narration, and class 3 below still applies.

## Taxonomy

1. **Dead design-session citations** — `(decision 7)`, `(audit C2)`, `design §4.7`, phase
   labels (`T4`, `W3`), "the design ledger". If the decision has a committed owner, cite it
   by name and path; otherwise delete the citation and restate its factual clause so it
   stands alone.
2. **Stack and PR vantage** — "a later PR in this stack", "this PR adds", "the previous
   commit". State the shipped mechanism or the extension point; deferred work becomes a
   `TODO` marker or an issue reference.
3. **Change narration and version stamps** — "used to", "no longer", "the old X", and
   indexical stamps ("v1", "this cut", "now" contrasting with a past state). State present
   behavior. A fixed regression becomes a present-tense counterfactual ("without X, Y
   happens"), never repo history ("used to Y").
4. **Review choreography** — "Rejected in review:", "the reviewer confirmed", draft ordinals.
   Keep the surviving decision and rationale as plain fact; delete who said it when.
5. **Reviewer-addressed justification** — "the cast is safe — it simply…", "this is correct
   because…". A comment arguing its own correctness addresses a reviewer, not a maintainer.
   State the invariant that makes the code safe, or delete the comment if the code shows it.
6. **Restatement and derivation transcripts** — control-flow narration ("first we X, then we
   Y"), test walkthroughs, proofs of obvious branches. Delete; keep only a non-obvious
   contract or invariant.
7. **Hedges and planning residue** — "probably fine for now", "should be enough", deferrals
   with no marker. Promote to `TODO`/`FIXME` or restate as the actual bound.

## What is NOT leakage

Unaided pattern-matching fails in both directions — deleting durable references while keeping
dead ones. Apply these keep rules as written:

- **Issue references** — `#1470`, `TODO(name):` resolve at HEAD. Keep them anywhere.
- **Suppression justifications** — lint-disable reasons, empty-catch explanations,
  coverage-ignore reasons are required prose. Fix a false reason; never delete it.
- **Counterfactual-present regression pins** — "without X, Y happens", "a naive X would…".
- **Measured bounds** — "(measured: 512 nests ≈ 0.15s)" calibrating a constant. The
  provenance word "measured" is load-bearing.
- **Runtime old/new states** — "the old connection drains before the new one accepts" is
  runtime lifecycle, not change history.
- **External references that resolve outside the repo by design** — RFC section numbers,
  standards citations. The §-ban covers uncommitted internal drafts, not published standards.
- **Project voice** — "we" as project voice is a genre form, not leakage.

## Workflow

1. **Require an explicit scope.** If none was given, ask for one — never infer a
   repository-wide scope. Never touch `vendor/`, third-party trees, or recorded
   fixtures/snapshots: recorded output keeps its original voice by design.
2. **Audit read-only first.** Grep for the patterns, then judge every hit semantically. The
   patterns are probes, not the definition — also read the densest prose in scope (module
   headers, READMEs) without a pattern in hand, because the highest-value finds have no
   distinctive string.
3. **Before deleting, enumerate the passage's propositions.** Check the overcorrection traps:
   a trim that flips an obligation into an endorsement, promotes a hypothetical to a shipped
   feature, deletes a true fact, or drops provenance is worse than the leakage.
4. **Fix the owner, not the artifact.** Generated docs → fix the source and regenerate.
   Model-visible strings → wording is behavior; flag for a snapshot-backed change rather
   than silently rewording.
5. **Verify.** Re-run the probes expecting only sanctioned keeps; confirm every remaining
   citation resolves at HEAD.

Report findings as: location, which class, the surviving facts, and the proposed restatement.
A passage carrying factual clauses is never deleted outright — restate, then delete the
transcript around it.
