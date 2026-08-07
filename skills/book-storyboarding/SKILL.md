---
name: book-storyboarding
description: Plot, scene, and chapter structure for fiction. Load when the user says "outline my book", "beat sheet", "three-act structure", "scene breakdown", "act structure", "character arc", "story structure", "where does this chapter fit", "Save the Cat", "Hero's Journey", or asks for help planning a novel's plot. Triggers for fiction only — does NOT trigger for non-fiction outlining, project planning, or task decomposition (those are handled by other skills).
---

# Book Storyboarding

A skill for structuring a novel, novella, or long-form fiction at the plot level. The user is working on a book (or short fiction with chapter structure) and wants help shaping it before or during drafting.

## When to load this skill

- User asks for help outlining a novel, novella, or chapter-structured story
- User wants a beat sheet, scene breakdown, or chapter structure
- User is at the planning stage and needs a structural framework
- User has written material and wants help figuring out where it fits in the arc
- User names a structure (Save the Cat, Hero's Journey, three-act, five-act, Kishōtenketsu, Freytag)

Do NOT load for: non-fiction book outlining (load `deep-research` or `task-planner` instead), screenwriting (different skill), short-story brainstorming (different scale).

## What this skill provides

### Structural frameworks (pick the one the user names, or default to three-act)

- **Three-act** — Setup, Confrontation, Resolution (most common for commercial fiction)
- **Save the Cat** — 15 beats (Opening Image, Theme Stated, Catalyst, Debate, Break Into Two, B Story, Fun & Games, Midpoint, Bad Guys Close In, All Is Lost, Dark Night of the Soul, Break Into Three, Finale, Final Image)
- **Hero's Journey** — Departure, Initiation, Return (12 stages)
- **Kishōtenketsu** — Introduction, Development, Twist, Conclusion (no conflict; East Asian structure)
- **Seven-point** — Hook, Plot Turn 1, Pinch 1, Midpoint, Pinch 2, Plot Turn 2, Resolution

### Scene/sequence scaffolding

For each scene ask: what is the POV character's **want** in this scene? What's the **obstacle**? What **changes** by the end of the scene? (Every scene must change something.) Ask the user to write one-line scene cards on index cards or in a list before drafting prose.

### Character arc

Three concentric arcs:
- **Outer (plot) arc** — what the character *does* (external goal)
- **Inner (moral/emotional) arc** — how the character *changes* (internal growth)
- **Thematic arc** — what the book is *about* (the question it asks)

The inner arc should be the *opposite* of the outer at the start, and they should meet by the end. If they don't, the book feels flat.

### Chapter pacing

- Chapter length: 2,000–6,000 words is typical for adult fiction; each chapter should have a hook at the end (a question, a reveal, a cliffhanger, a beat reversal)
- Scene/sequel rhythm: a high-tension *scene* (action, conflict) followed by a *sequel* (reaction, decision, new goal)
- Midpoint reversal: the book should pivot around the 50% mark. What changes for the protagonist at the midpoint?

## Process

1. Ask the user the **single most important question first**: what is the book about in one sentence? If they can't answer it, help them find it before anything else.
2. Pick a structural framework (default three-act). State the framework explicitly so the user knows what they're getting.
3. Walk through the framework with the user, one beat/scene at a time, asking what *they* want to happen (the skill is not a creative-writing AI — it's a structural consultant).
4. Produce a one-page outline (or update an existing one) with: chapter numbers, scene summaries, character arcs, midpoint, climax.
5. Save the outline to `book/outline.md` (or wherever the user prefers). Remind the user to commit it to version control.

## Anti-patterns to flag (kindly)

- **The sagging middle** — Act 2 is usually too long. Ask the user what's the *worst* thing that can happen to the protagonist at the midpoint. If they can't answer it, the middle will sag.
- **The deus ex machina ending** — endings should be set up by the character's earlier choices, not by sudden external rescue.
- **The unchanged protagonist** — if the protagonist is exactly the same at the end as the start, the book didn't do its job. The change should be visible by the midpoint reversal.
- **The over-planned outline** — outlines are guides, not contracts. If the user is writing more than ~500 words of outline per chapter, they're over-planning and should just draft.

## Output format

When producing an outline, use this format:

```
# Book Outline — [Working Title]

## Premise
[One sentence]

## Structure
[Framework name]

## Characters
- [Name] — outer goal, inner arc, thematic question

## Outline
1. **Chapter 1 — [Title]**
   - POV: [character]
   - Scene: [one-line summary]
   - Want / obstacle / change: [W / O / C]
   - Beat: [framework beat name]
2. ...
```

## Handoff

After outline is complete, suggest the user invoke `book-author` (the orchestrator skill) for the full guided workflow, or load `book-research` if they need to verify historical/setting facts before drafting.