# Translation-quality benchmark corpus

This directory holds the prose corpus used by the translation-quality
benchmark (`test/quality/`): one JSON file per category, each containing
exactly 10 paragraphs. The corpus exists to measure where translation
quality decays with output length, so that
`DEFAULT_OUTPUT_TOKEN_BUDGET` in `src/core/constants.ts` can be
calibrated empirically rather than guessed.

## Licensing and attribution

**The text in these corpus files is NOT covered by the repository's MIT
code license.** Each `<category>.json` file records its own license in
its `license` field, and that license applies to the `text` of the
paragraphs in that file. Expected values:

- `Public domain` — no restrictions.
- `CC BY 4.0` (or another CC BY version) — attribution required; the
  `attribution` field carries the exact credit line.
- `CC BY-SA 4.0` — attribution + share-alike; redistribution of the
  paragraph text must stay under a compatible license.
- `MIT (original work)` — paragraphs authored originally for this
  repository; these follow the repo's MIT license like any other
  original file.

When redistributing or quoting corpus text, honor the per-file license,
not the repo license.

## Provenance fields

Every corpus file carries the same top-level metadata so a reviewer can
re-verify the source without any out-of-band knowledge:

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `category`    | Corpus category slug; also the prefix of every paragraph id in the file. |
| `license`     | License of the paragraph text (see above).                               |
| `attribution` | Exact source: work, author, edition/revision, and credit line if the license requires one. |
| `sourceUrl`   | URL the text was fetched from, or the repo URL for original work.        |
| `retrieved`   | ISO date (`YYYY-MM-DD`) the text was fetched or authored.                 |

Each paragraph has an `id` of the form `<category>_<source>_<nnn>`
(e.g. `fiction_austen_001`), a `chars` count that must equal
`text.length`, and the paragraph `text` itself.

## Recency rule (training-data contamination)

The benchmark scores model translations, so text that appears verbatim
in model training data would inflate quality scores: the model could
reproduce a memorized translation instead of producing one. To mitigate
this:

- **Fetched sources must have been created or substantially revised on
  or after 2025-06.** Older public-domain or CC material is too likely
  to be in training corpora (often together with published
  translations). The `attribution` field must identify the
  edition/revision that satisfies this rule.
- **The `fiction`, `children`, `historic`, and `marketing` categories
  are authored originally for this repository** (license
  `MIT (original work)`), because recent freely-licensed prose in those
  registers is scarce. Original text is guaranteed absent from training
  data.

The schema and validation rules live in `test/quality/corpus.ts`; the
unit tests in `test/quality/corpus.test.ts` exercise them without
depending on the real corpus files, so this directory may be empty
while category files land in parallel PRs.
