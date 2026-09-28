# Frame files

The PropBank-style rolesets the concept picker offers, one flat JSON object per
language: roleset id to its argument descriptions.

```json
"give-01": { "ARG0": "giver", "ARG1": "thing given", "ARG2": "entity given to" }
```

Copied from UMR-Writer (github.com/umr4nlp/umr-annotation-tool,
`umr_annot_tool/resources/frames_*.json`, MIT, Jin Zhao and Brandeis
University), which flattened them from the PropBank frame files of each
language. English 8733 rolesets, Chinese 16891, Arabic 10073 (10041 here, see
below), Portuguese 1410.
The Chinese file came with a colon after each key (`"ARG0:"`) and the
Portuguese one with the arguments wrapped in `{ args, examples, name }`. Both
were rewritten to the shape above, and `frames.test.js` holds every file to it.

Loaded on demand by `src/domain/lexicon.js`, keyed by the project's language.

## Arabic

Upstream's Arabic ids came from the Arabic PropBank's Buckwalter names, and
1382 kept Latin letters for أ إ آ ؤ ذ ء (`تXكير-01` for تذكير) while 106 lost
a verb's vowel class to a doubled hyphen (`نزح--01`). `fix-arabic.mjs` repairs
them from upstream's `frames_arabic.json` into `arabic.json`, and records every
changed id in `arabic-renames.json`. A repaired id that another roleset
already holds with the same arguments is merged into it (32). One that holds
different arguments keeps its doubled hyphen (22). Six ids spelling English
words in Arabic and Latin letters (`دeفeند-01`) are left as they are. Rerun
the script when the upstream file changes. Its header says how.
