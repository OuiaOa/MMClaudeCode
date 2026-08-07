---
name: book-author
description: Orchestrator for writing a book end-to-end with the user. Load when the user says "I want to write a book", "help me write a novel", "let's write a story together", "I have an idea for a book", "start a fiction project from scratch", "guide me through writing a book", "I'm writing a [genre] novel". This is the ENTRY POINT for the book-writing skill bundle — it names and loads the appropriate sub-skill at each stage.
---

# Book Author (Orchestrator)

The top-level orchestrator for the book-writing skill bundle. When you load this skill, you're starting a guided workflow. The orchestrator does NOT do the writing itself — it loads sub-skills and walks the user through stages.

## When to load this skill

This is the entry point. If the user says any of:
- "I want to write a book / novel"
- "Help me write [a story / a novel / a book]"
- "I have an idea for a book"
- "Guide me through writing a book"
- "Let's start a fiction project"
- "I'm writing a [genre] novel and want help"

…then load this skill first. It will load sub-skills as needed.

Do NOT load for: editing an existing draft only (load `book-prose-craft` or `book-continuity`), non-fiction (load M3's `task-planner` or `deep-research`), screenwriting (different skill set).

## The stages

The orchestrator walks the user through six stages. Each stage loads a specific sub-skill. Do NOT skip stages without the user's explicit decision.

```
┌─ Stage 1: Premise    →  book-storyboarding
├─ Stage 2: Research   →  book-research
├─ Stage 3: Outline    →  book-storyboarding (continued)
├─ Stage 4: Draft      →  book-prose-craft (per scene)
├─ Stage 5: Continuity →  book-continuity
└─ Stage 6: Polish     →  ai-tells-remover + book-prose-craft
```

### Stage 1 — Premise

**Sub-skill to load: `book-storyboarding`**

Goal: get the user's one-sentence premise. If they have one, validate it (does it have a character, a want, an obstacle, a stakes?). If they don't, help them find one.

Output: one-sentence premise, working title, basic character sketch.

Stage gate: do not proceed until the user has a one-sentence premise they're happy with.

### Stage 2 — Research

**Sub-skill to load: `book-research`**

Goal: verify the real-world anchors of the setting (period, place, profession, technology). For pure fantasy / sci-fi, skip this stage unless the user wants to ground specific details.

Output: research notes file (`book/research/[topic].md`) with facts, probables, invented (clearly marked).

Stage gate: optional for non-realistic settings; required for historical or contemporary realistic fiction.

### Stage 3 — Outline

**Sub-skill to load: `book-storyboarding` (same skill as Stage 1, deeper)**

Goal: chapter-by-chapter outline using a structural framework (three-act, Save the Cat, Hero's Journey, etc.). One line per scene. Midpoint reversal pinned down. Climax and ending sketched.

Output: `book/outline.md` with the format from `book-storyboarding`.

Stage gate: do not proceed to drafting until the outline is committed to a file (not just discussed). The user can always come back and revise the outline later.

### Stage 4 — Draft

**Sub-skill to load: `book-prose-craft` (per-scene, not all at once)**

Goal: produce prose scene by scene. The skill should help with sentence-level craft, dialogue, POV discipline. NOT rewrite — the user drafts, the skill offers targeted suggestions.

Workflow per scene:
1. User says "drafting scene 3.2" (chapter 3, scene 2)
2. Skill loads (or already loaded) `book-prose-craft`
3. User writes prose, posts it
4. Skill offers 3-5 targeted suggestions per scene (don't rewrite the whole scene)
5. User accepts/rejects, commits scene to `book/manuscript/chapter-N.md`

Stage gate: do not proceed until at least one complete scene is drafted and committed.

### Stage 5 — Continuity

**Sub-skill to load: `book-continuity`**

Goal: three-pass check (character state, plot threads, factual consistency). Output a report. User fixes Errors, considers Warnings, decides on Notes.

Output: `book/continuity-report-[date].md`.

Stage gate: do not proceed to polish until all Errors are fixed or marked "intentional".

### Stage 6 — Polish

**Sub-skills to load: `ai-tells-remover` first, then `book-prose-craft`**

Goal: remove AI fingerprints, then craft-level polish. Run `ai-tells-remover` on each chapter, accept the unambiguous fixes. Then run `book-prose-craft` for any last-mile sentence-level work.

Output: `book/manuscript/polished/chapter-N.md`.

Stage gate: the book is "done" when the user says it's done. The skill should not push for endless revision.

## How to load sub-skills

When you need to load a sub-skill, **announce it explicitly** to the user. Say "Loading `book-research` to verify the period details for 1880s London." Then *behave as if* that skill's content is in your context — its rules, output formats, anti-patterns. The Skills system will also auto-load the sub-skill when its description matches, but announcing the transition is part of the guided experience.

You do NOT need to literally invoke a tool. The skill content lives in your context once you read the file. But you MUST apply the skill's rules.

## When the user wants to skip stages

That's fine. Some users have an outline already, or don't need research, or want to draft out of order. The orchestrator's job is to be a guide, not a gatekeeper. If the user says "skip Stage 2, I know the setting", respect that and move on. Note the skip in your memory so you can return to it if needed.

## When the user gets stuck

If the user is stuck at any stage for more than a few turns, offer to:
- Switch sub-skills (if dialogue is stuck, load `book-prose-craft` for help even during outlining)
- Take a break (save current state to files)
- Roll back to an earlier stage (often the premise needs work, not the draft)

## Memory across stages

The orchestrator should remember: the premise, the working title, the structural framework chosen, the chapter count, the user's preferred voice/POV/tense, any specific decisions made. Use these to keep later stages consistent with earlier ones.

## Anti-patterns in the orchestrator

- **Don't write the book for the user.** The skill offers suggestions; the user writes.
- **Don't rush stages.** Each gate exists for a reason. If the user wants to skip, they can — but don't skip without asking.
- **Don't load all six sub-skills at once.** Load on demand, when the stage requires it. This keeps context focused.
- **Don't pretend to be authoritative about the user's vision.** The skill is a consultant. The user knows their book better than the skill does.

## Handoff

When the book is done (user says so), offer:
- A final continuity pass
- A summary of what was learned about the user's writing process
- Suggestions for next projects
- An exit message: "You've finished a book. Take a breath."