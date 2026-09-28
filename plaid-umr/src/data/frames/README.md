# Frame files

The PropBank-style rolesets the concept picker offers, one flat JSON object per
language: roleset id to its argument descriptions.

```json
"give-01": { "ARG0": "giver", "ARG1": "thing given", "ARG2": "entity given to" }
```

Copied from UMR-Writer (github.com/umr4nlp/umr-annotation-tool,
`umr_annot_tool/resources/frames_*.json`, MIT, Jin Zhao and Brandeis
University), which flattened them from the PropBank frame files of each
language. English 8733 rolesets, Chinese 16891, Arabic 10073, Portuguese 1410.
The Chinese file came with a colon after each key (`"ARG0:"`) and the
Portuguese one with the arguments wrapped in `{ args, examples, name }`. Both
were rewritten to the shape above, and `frames.test.js` holds every file to it.

Loaded on demand by `src/domain/lexicon.js`, keyed by the project's language.
