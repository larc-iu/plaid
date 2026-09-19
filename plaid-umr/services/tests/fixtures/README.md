# Fixtures for `test_umr_ancast.py`

- `umr_test.txt`, `umr_gold.txt`: the AnCast sample pair, taken unchanged from
  [umr4nlp/ancast](https://github.com/umr4nlp/ancast) (MIT licence). They are
  what `python -m ancast -p umr_test.txt -g umr_gold.txt -s doc` is run over,
  and the test asserts the service reproduces the numbers it prints.
- `english_raw.json`, `english_expected.umr`: generated, do not edit by hand.
  `test/fixtures/umr/english_umr-0001.umr` (the released English UMR corpus)
  put through the app's own import plan and its own exporter, written by
  `node services/tests/make_umr_raw_fixture.mjs` on Node 24. Regenerate them
  whenever `src/domain/sentenceGraph.js` or `src/domain/format/` changes what
  the exporter writes.
