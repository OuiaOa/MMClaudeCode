---
name: book-continuity
description: Continuity checking across a manuscript — character state tracking, plot-thread status, factual consistency chapter-to-chapter. Load when the user says "continuity check", "consistency pass", "chapter consistency", "did I contradict myself", "character bible", "fact-check my manuscript", "tracking threads", "what did character X know at chapter Y". Triggers for completed or in-progress fiction drafts, not for outlining (that's `book-storyboarding`).
---

# Book Continuity

A skill for catching contradictions and tracking persistent state across a long manuscript. The user has a draft (or partial draft) and needs to know: did I contradict something I established earlier? What did Character X know at Chapter Y? Is the magic system still consistent? Did I leave a plot thread dangling?

## When to load this skill

- User has written (or is writing) multiple chapters and wants a consistency pass
- User asks "did I contradict myself" or "is this consistent with what I wrote earlier"
- User wants a character bible (cumulative traits, knowledge, relationships, possessions across the manuscript)
- User wants to track open plot threads and their resolution status
- User wants to know what a specific character knew at a specific point in the story

Do NOT load for: outlining (use `book-storyboarding`), single-chapter revision (use `book-prose-craft`), research for new material (use `book-research`).

## What this skill provides

### Three passes

The skill does THREE passes on the manuscript:

**Pass 1 — Character state tracking**

For each POV character, build a running state table across chapters:
- Physical location
- Possessions (clothing, weapons, money, documents, etc.)
- Knowledge (what they know, what they don't yet know)
- Injuries / physical condition
- Emotional state (compressed: "guard up", "hopeful", etc.)
- Relationships (alive/dead, allied/hostile, romantic state)

Flag any chapter where a state change happens without narrative justification, or where the state in Chapter N+1 contradicts Chapter N.

**Pass 2 — Plot-thread inventory**

Build a list of every plot thread introduced in the manuscript. For each, note:
- Chapter introduced
- Status (open / advanced / resolved / abandoned)
- Last chapter referenced
- Resolution chapter (if resolved)

Flag: threads that are open at the end (depending on whether the book is finished — for a finished book, every open thread is either intentional ambiguity or a dangling plotline), threads that were "resolved" but never actually paid off, threads that disappear without resolution (need to check if this was intentional).

**Pass 3 — Factual consistency**

The skill should look for:
- Day-of-week errors (a Monday referenced as Tuesday)
- Date arithmetic (three days later becomes two days later)
- Weather / season inconsistencies (snow in July in a setting where July is summer)
- Travel-time errors (a 200-mile journey taking one hour)
- Timeline inconsistencies (character A says "we haven't seen each other in five years" but they saw each other last chapter)
- Object/state errors (character's left hand wounded in Ch 5, used to sign their name in Ch 8)
- Pronoun / name errors (calling a character by a different name in a later chapter)

For each error found, output: chapter, location, the error, suggested fix (or note "intentional?" for user to confirm).

## Process

1. Ask the user: how many chapters? In what format (single file, separate files, manuscript doc)? POV structure (single, multiple, rotating)?
2. Read the manuscript (or each chapter). Build the running tables.
3. Run the three passes.
4. Output a continuity report grouped by severity:
   - **Errors** (definite contradictions) — fix
   - **Warnings** (likely errors but might be intentional) — confirm
   - **Notes** (threads open at end, unresolved references, etc.) — author decides
5. Save the report as `book/continuity-report-[date].md`.

## Output format

```markdown
# Continuity Report — [Title] — [Date]

## Summary
- Chapters checked: N
- Errors found: N
- Warnings: N
- Notes: N

## Errors (definite contradictions — fix before publication)

### Chapter 12 vs Chapter 5
- **Issue**: [description]
- **Location**: Ch 12 para 4 / Ch 5 para 11
- **Suggested fix**: [edit suggestion]
- **Or**: confirm intentional

## Warnings (likely errors — confirm)

...

## Notes (open threads, unresolved references)

### Open plot threads at end of manuscript
1. [Thread name] — last referenced Ch 22 — status: open
2. ...

### Unresolved references
- Ch 8 mentions "the scar on his wrist" but no scar was established in earlier chapters
- ...

## Character state tables
[Optional — include for novels with multiple POV characters]
```

## Anti-patterns to flag

- **The over-zealous continuity bot** — flagging things that are actually intentional (e.g., unreliable narrator, deliberate foreshadowing that the reader isn't supposed to notice yet). The skill should always ask "is this intentional?" before declaring an error.
- **The state-table trap** — for novels with 30+ POV characters, the tables get unwieldy. The skill should focus on characters who actually appear in the chapter being checked, not all characters ever.
- **The "fix everything" reflex** — many "errors" are stylistic choices. The skill should report findings, not auto-fix. The author decides.

## Handoff

After the continuity report, suggest loading `ai-tells-remover` to check for AI patterns in the prose, or `book-prose-craft` for sentence-level revision. Or return to `book-author` orchestrator.