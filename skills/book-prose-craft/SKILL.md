---
name: book-prose-craft
description: Sentence-level craft for fiction prose — point of view, tense, voice, dialogue, "show don't tell", rhythm, pacing, white space, dialogue tags. Load when the user says "improve this scene", "tighten this paragraph", "show don't tell", "fix the POV", "the dialogue feels flat", "vary the sentence rhythm", "make this sing", "prose polish". Distinct from `prose` (M3 stack, general prose quality) and from `ai-tells-remover` (which targets AI fingerprints) — this skill is for fiction craft.
---

# Book Prose Craft

A skill for sentence-level fiction craft. The user has prose that works mechanically and wants it to feel more alive. This is about craft, not rules — every suggestion is a *tool*, and the user decides what fits their voice.

## When to load this skill

- User has a scene or chapter they want polished at the sentence level
- User asks "show don't tell", "vary the rhythm", "fix the POV"
- User says the dialogue is flat, the descriptions are listy, the pacing is off
- User wants to study how a craft technique applies to their text
- User asks "how do I write [specific effect]" (suspense, intimacy, dread, joy)

Do NOT load for: outlining (`book-storyboarding`), continuity (`book-continuity`), AI-pattern removal (`ai-tells-remover`), non-fiction prose (use M3 `prose`).

## What this skill provides

### POV discipline

The skill enforces consistent POV. Common failures:
- **Head-hopping** — switching POV characters within a scene without transition. Fix: scene breaks between POV shifts.
- **POV bleed** — using a POV character's knowledge outside their perspective ("Little did she know, he had…"). Fix: only show what this POV character can perceive.
- **Distance drift** — POV drifts from close (we feel sensations) to distant (we see from outside) without intent. Pick a default distance per scene and hold it.

### Tense consistency

Decide past or present, and hold it. Past is more forgiving; present is more immediate but harder to sustain. Common failure: past narration slips into present for action sequences. Fix: pick one tense and stick to it.

### Show, don't tell

A principle, not a rule. Sometimes telling is exactly right (transitions, summaries, time-skips). The skill applies it where showing adds value:
- Telling: "She was angry."
- Showing: "She put the cup down so hard the handle chipped."

For emotion: name the *physical sign* of the emotion, not the emotion itself. ("Her voice went flat" not "She was annoyed.")

### Dialogue craft

- **Each character should sound different.** If you removed attribution, could the reader tell who's speaking? If not, differentiate vocabulary, sentence length, idioms, rhythm.
- **Don't over-attribute.** "Said" is invisible. Use it. Reserve "exclaimed", "shouted", "whispered" for when the manner genuinely matters.
- **White space between dialogue and action.** A line of dialogue + a beat of action is more vivid than a line of dialogue + a tag.
- **Cut small-talk when the story doesn't need it.** Real conversation has more pauses and topic-changes than fiction can afford. Use only the dialogue that moves the scene forward.

### Sentence rhythm

Vary sentence length. A common AI tell (handled in `ai-tells-remover`) and also a common first-draft tell (humans do this too). Aim for:
- A short sentence after several long ones (for emphasis)
- A long sentence after several short ones (for breath)
- Occasional fragments, but not in every paragraph

### Adverb discipline (in dialogue tags)

"He said quietly" is weaker than "He said. The room had gone still." Cut adverbs in tags; let the surrounding action carry the manner.

### Description economy

Every description should do at least two things: establish setting AND reveal character, or establish setting AND advance plot, etc. If a description only establishes setting, cut or fold it into action.

### White space

Use line breaks deliberately. A blank line between paragraphs is a beat — use it where the reader needs a breath.

## Process

1. Ask: what's the user's specific concern? ("Dialogue feels flat" → focus on dialogue. "Pacing is slow in Chapter 3" → focus on rhythm and description economy.)
2. Read the scene with that concern in focus.
3. Make 3-5 specific suggestions. Don't rewrite the whole scene — that robs the user of their voice. Suggest targeted edits.
4. For each suggestion, explain *why* — what craft principle it serves.
5. Save suggestions as comments or as a side-by-side note. Don't overwrite the user's prose.

## Output format

For each suggestion:

```
**Suggestion N — [Where: Chapter, paragraph]**
- Concern: [what craft principle applies]
- Before: "[the user's text]"
- After: "[suggested rewrite]"
- Why: [the principle, briefly]
```

End with: "These are suggestions, not edits. Accept the ones that fit your voice; reject the ones that don't. The goal is to give you tools, not to replace your writing."

## Anti-patterns in the skill itself

- **Don't rewrite into a different voice.** If the user writes sparse Hemingway prose, don't suggest flowery Faulkner expansions. Match the user's existing voice and tighten within it.
- **Don't over-edit.** First-draft energy is precious. The skill should suggest targeted fixes, not rewrite.
- **Don't impose rules that aren't universal.** "Never use adverbs" is bad advice. "Use adverbs in dialogue tags sparingly" is good advice.

## Handoff

After craft revision, suggest loading `ai-tells-remover` for a final de-AI pass, or `book-continuity` to check the revised scene against the manuscript. Or return to `book-author` orchestrator.