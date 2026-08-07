---
name: ai-tells-remover
description: Detect and remove AI-writing fingerprints from prose — em-dashes, throat-clearing openers, formulaic structures ("It's not just X, it's Y"), uniform sentence length, signposting phrases, etc. Load when the user says "make this sound less AI", "humanize this prose", "stop-slop pass", "remove AI patterns", "this reads like ChatGPT", "fix the slop". Triggers for prose revision, not for new writing (new writing should aim for human voice from the start via `book-prose-craft`).
---

# AI Tells Remover

A skill for catching and removing the patterns that mark prose as AI-generated. Based on the open-source `hardikpandya/stop-slop` ruleset and the `conorbronsdon/avoid-ai-writing` patterns, distilled to the rules a writing assistant can apply.

## When to load this skill

- User has a paragraph or chapter that "reads like ChatGPT"
- User wants a stop-slop / humanize / de-AI pass on prose
- User is revising AI-drafted text into more human-sounding prose
- User wants a checklist of patterns to avoid in their own writing

Do NOT load for: technical documentation (AI tells are usually fine in docs), academic writing, code comments, marketing copy with intentional AI aesthetics.

## What this skill provides

### The rules — grouped by severity

**Tier 1 — Always fix (universal AI tells)**

1. **Em-dash overuse** — AI uses em-dashes (—) 3-5x more than human writers. Use periods, commas, parentheses, or restructure.
2. **Throat-clearing openers** — "It's important to note that…", "It's worth mentioning…", "Let's dive in…", "In today's world…", "When it comes to…" — delete entirely.
3. **Filler emphasis** — "absolutely crucial", "vital importance", "key takeaway", "game-changer", "deep dive" — replace with concrete specifics.
4. **Formulaic triads** — "fast, reliable, and secure"; "simple, powerful, and elegant"; "streamline, optimize, and revolutionize" — pick one or two, or rewrite entirely.
5. **Signposting phrases** — "First, let's explore…", "Now that we've covered…, let's move on to…", "In conclusion, …" — cut.

**Tier 2 — Strong AI fingerprint**

6. **"Not just X, but Y" / "It's not X — it's Y"** — overused by AI. Restructure to a plain assertion.
7. **"Delve into"** — high-frequency AI tell. Use "look at", "examine", "explore", or just describe.
8. **"Tapestry" / "symphony" / "kaleidoscope"** for abstract nouns — abstract metaphor pile-up. Pick one concrete image, or describe the actual thing.
9. **Symmetric contrasts** — "On one hand X. On the other hand Y." — humans rarely structure arguments this neatly; allow some asymmetry.
10. **"Navigate the complexities of"** — bureaucratic AI phrasing. Use the actual verb (handle, work through, deal with).

**Tier 3 — Pattern tells (variable; fix if heavy)**

11. **Uniform sentence length** — AI tends toward 15-20 word sentences. Mix 3-word and 40-word sentences.
12. **Three-item lists** — humans often use two or four items. Break the rule occasionally.
13. **Consistent paragraph length** — vary it. Some short paragraphs, some long.
14. **Hedged certainty** — "It's generally considered that…" — humans either know or don't; pick one.
15. **Metaphor stack** — one metaphor per paragraph is fine; three is "AI voice".

**Tier 4 — Stylistic (judgement call)**

16. **Positive spin** — AI leans upbeat. If the scene calls for bleakness or ambiguity, cut the spin.
17. **Generic examples** — "imagine a world where…" — replace with a specific, concrete image.
18. **Bullet-list conclusion** — humans rarely end with neat bullet lists in prose. End on a concrete image, a question, or a moment.

## Process

1. Ask: what is the target voice? (Casual, formal, literary, journalistic, technical?) Different rules apply.
2. Read the prose and apply Tier 1 rules first (these are unambiguous fixes).
3. Apply Tier 2 rules — flag for the user, propose rewrites.
4. Check Tier 3 patterns at the document level (not paragraph by paragraph). Flag if 3+ of these appear consistently.
5. Tier 4 is judgement — flag with a note "you decide".
6. Output a before/after for each change so the user can accept or revert.

## Output format

For each change:

```
**Tier 1 — Em-dash overuse**
- Before: "The room was dark — cold — and smelled of wet stone."
- After: "The room was dark and cold. It smelled of wet stone."
- Reason: Em-dash overuse is a high-frequency AI tell.
```

Group by tier. End with a summary count: "12 Tier 1 fixes, 4 Tier 2, 1 Tier 4 flagged for your judgement."

## Detection (optional pre-pass)

If the user has a long manuscript and wants a fast pre-check, the skill can use a detector (`baoguangsheng/fast-detect-gpt` if available as MCP, or a statistical detector). This is optional — the rule application above is the primary work.

## Anti-patterns in the skill itself

- **Don't over-apply.** Some of these rules apply to general prose too (humans overuse em-dashes sometimes). The skill should distinguish "AI tells" from "stylistic choices that AI also makes".
- **Don't strip voice.** If the user has an established voice that uses em-dashes heavily, that's their voice, not AI tell.
- **Don't replace one tell with another.** Replacing "delve into" with "examine" is fine; replacing it with "explore the depths of" is just shifting the tell.

## Handoff

After cleanup, suggest loading `book-prose-craft` for sentence-level craft revision (different angle: improving the writing, not just de-AI-ing it). Or return to `book-author` orchestrator.