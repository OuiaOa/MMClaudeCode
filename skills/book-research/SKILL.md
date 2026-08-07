---
name: book-research
description: Research for fiction — historical period, real location, real profession, real technology, real legal system, real cultural practice. Load when the user says "research for my book", "is this historically accurate", "what was [place] like in [year]", "how does [process] actually work", "fact-check my setting", or asks about real-world details to put in a novel. Distinct from `deep-research` (general research) — this skill is for fictional authenticity, not for analytical reports.
---

# Book Research

A skill for verifying and gathering real-world details that go into a novel. The user is writing fiction and needs the world to feel authentic — period, place, profession, technology, law, language.

## When to load this skill

- User asks "is this historically accurate" or "what was [X] like in [Y]"
- User wants to know how a real process works (how a forge operates, how a ship is navigated, how a court case proceeds)
- User is writing about a real place and wants local color
- User wants to fact-check a setting detail before it goes into the manuscript
- User wants to gather sensory details (smells, sounds, textures) of a real environment

Do NOT load for: pure worldbuilding (invented settings with no real-world anchor — that's `book-continuity` or character work), contemporary factual research for non-fiction, academic citations.

## What this skill provides

### Real-world anchors (not invention)

The whole point is to prevent invention. If the user is writing a novel set in 1880s London, the skill should help them verify cobblestone types, gas lighting, currency, slang, food, clothing. If the user is writing sci-fi, the skill should help them ground the invented tech in real physics/chemistry/biology.

### Three-tier source ladder

- **Tier 1 — Primary sources**: diaries, letters, photographs, newspapers of the era. Search via archive.org, British Newspaper Archive, Library of Congress, HathiTrust.
- **Tier 2 — Scholarly secondary**: academic books and articles. Prefer university press monographs over popular history.
- **Tier 3 — Popular reference**: Wikipedia, Britannica, well-researched popular history. Use for orientation, not for direct quotation.

For fiction, the user usually wants Tier 3 (orientation) + one Tier 1 anchor for each major setting detail. Cite in the manuscript's afterword if the user wants to be thorough.

### Sensory detail kits

For a setting, gather: 5 smells, 5 sounds, 5 textures, 5 visual textures (light quality, surface patterns), 3 tastes, 3 ambient temperatures. These don't all appear in the book, but they inform the writing.

### Period language

Slang, idioms, common phrases of the era. The user should NOT write whole sentences in period dialect (readers find it unreadable) but should seed 2-3 era-appropriate phrases per scene where characters speak.

## Process

1. Establish: what is the setting (place + time), what is the protagonist's situation, what specific details does the user need? Ask before searching.
2. Search authoritative sources. Prefer the user's stated region/period expertise; if none, use the tier ladder above.
3. Distinguish **facts** (verifiable), **probable** (consistent with evidence but not certain), and **invented** (the user is making it up). Mark which is which in the output. The skill's job is to make the boundary clear.
4. Output as a structured note file (`book/research/[topic].md`) the user can keep open while drafting.

## Output format

```markdown
# Research: [Topic]

## Setting
- Place: ...
- Time period: ...
- Protagonist's context: ...

## Facts (verified)
- ... [with source URL]

## Probable (consistent with evidence, not certain)
- ...

## Invented (user's call)
- ...

## Sensory detail kit
- Smells: ...
- Sounds: ...
- Textures: ...
- Light/visual: ...
- Tastes: ...
- Temperature: ...

## Era language seeds
- "..." (period: source)
- ...

## Sources
- [Title](URL) — tier 1/2/3, accessed YYYY-MM-DD
```

## Anti-patterns to flag

- **The Google-search loop** — generic search engines surface the same popular-history articles. For primary sources, go to archives directly.
- **The anachronism sneak** — even small period details (zippers weren't common until 1890s; bottled water post-1980s; "OK" as a word post-1839) date a scene. The skill should flag these.
- **The invented-but-believable** — when a detail is plausible but invented, mark it as such. Don't let plausible invention get confused with research.

## Handoff

After research notes are written, suggest loading `book-continuity` to record the facts in the project's canon (character bible / world bible), or loading `book-author` to return to the guided workflow.