# Vision benchmark

Screenshots only work if the vision model is actually good at reading them. This tells you
whether yours is, before you rely on it.

```bash
node vision-bench/bench.mjs
```

That scores the model your install is configured to use, against nine fixtures. Takes about
90 seconds and costs roughly a cent.

## What it tests

The fixtures are generated locally by `gen-fixtures.mjs` — no photographs, no downloads, no
personal data, byte-reproducible so two people compare like with like. They are committed, so
you do not need Chromium unless you want to regenerate them.

Making a vision benchmark *hard* is the difficult part. Clean text on a clean background is
solved by every model worth using, and a suite everything scores 100% on ranks nothing. So
these reproduce the ways real screenshots and photos are actually difficult:

| fixture | what it catches |
|---|---|
| `01-plain-text` | baseline. If this fails, your setup is broken, not the model. |
| `02-fine-print` | 9px type — the size real UI fine print uses |
| `03-low-contrast` | pale grey on white |
| `04-photographed-form` | rotation, blur, glare, film grain, irregular hand-filled entries |
| `05-overlap` | the answer is a spatial relationship, not a string |
| `06-table` | precise cell lookup |
| `07-inverted` | a symmetric scene rotated 180° — does it notice? |
| `08-code-bug` | read code well enough to find an off-by-one |
| `09-occluded` | part of the value is genuinely hidden |

The last one matters most. It scores two things at once: reporting the part that *is* legible,
and admitting the part that is not. A model that confidently supplies the covered characters
is penalised via `mustNot`, because a plausible fabrication is worse than an admission of
uncertainty when the agent reading it cannot check.

## Comparing models

```bash
node vision-bench/bench.mjs --model google/gemini-2.0-flash-001,Qwen/Qwen3-VL-30B-A3B-Instruct
```

Prints a ranking. Useful before committing to one — price does not reliably track capability
here, and a cheaper model frequently beats a dearer one on this kind of work.

## Your own images

Point it at a directory containing your files and a `truth.json` beside them:

```json
[
  {
    "png": "receipt.jpg",
    "ask": "Transcribe the total and the invoice number.",
    "must": [["INV-2201"], ["48.75", "48,75"]],
    "bonus": [["handwritten"]],
    "mustNot": [["INV-2202"]]
  }
]
```

```bash
node vision-bench/bench.mjs --images ./my-shots
```

Each `must` entry is a list of acceptable alternatives — any one counts — which keeps scoring
fair across models that format numbers and dates differently. `bonus` is recorded but not
scored, for things it would be nice to notice but unfair to require. `mustNot` subtracts a
point, for things a model should never claim.

## Interpreting the score

Anything above ~90% is a capable setup. Below ~70% you will get descriptions that miss detail
the agent then reasons wrongly from — which is worse than no image at all, because the agent
does not know the description was poor. Check *which* fixtures failed rather than the headline
number: failing `09-occluded` by inventing hidden characters is a much worse signal than
missing a low-contrast string.
