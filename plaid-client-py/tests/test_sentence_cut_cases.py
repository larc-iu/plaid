"""new_words reads where core puts a sentence boundary in an edit without
asking it. This holds that reading to core's on plaid-core's shared table
(plaid-core/src/test/plaid/algos/sentence_cut_cases.json, which plaid-core's
sentence-cut-cases-test holds core to), as plaid-igt's
sentenceCutCases.test.js does for the editor's copy:

- where the edit only types, every letter it typed that a new word could take
  lies in the sentence core puts it in;
- in every edit, the twin cuts between two characters a new word could take,
  one of them typed, exactly where core begins a sentence (where a deleting
  gap meets a boundary the twin cuts both its ends and makes no word of its
  text, so a count of cuts there says nothing);
- no new word crosses a sentence core begins or overlaps a word core places.
"""

import json
from pathlib import Path

from plaid_client.workflows.igt.ignored import is_punct_char
from plaid_client.workflows.igt.new_words import is_js_space, new_text_layout, new_text_words

CASES = json.loads((Path(__file__).resolve().parents[2] / 'plaid-core' / 'src' / 'test' / 'plaid' / 'algos'
                    / 'sentence_cut_cases.json').read_text(encoding='utf-8'))['cases']


def _sentence_of(cuts, x):
    return sum(1 for b in cuts if b <= x)


def test_the_sentence_cut_agrees_with_core_on_the_shared_table():
    problems = []
    checked = pairs = 0
    for c in CASES:
        words = [{'begin': b, 'end': e} for b, e in c['words']]
        sentences = [{'begin': b, 'end': e} for b, e in c['sentences']]
        layout = new_text_layout(c['base'], c['gaps'], words, sentences)
        if layout is None:
            continue
        body, typed, covered, cut = layout
        core = c['core']
        if ''.join(body) != core['body']:
            problems.append((c['base'], c['gaps'], 'body'))
            continue
        core_cuts = [b for b in core['sentenceBegins'] if b > 0]
        twin_cuts = [x for x in range(1, len(cut)) if cut[x]]
        inserts = all(g['start'] == g['end'] for g in c['gaps'])

        def free(x):
            return not covered[x] and not is_js_space(body[x])

        for x in range(len(body)):
            if inserts and typed[x] and free(x):
                checked += 1
                if _sentence_of(twin_cuts, x) != _sentence_of(core_cuts, x):
                    problems.append((c['base'], c['gaps'], 'letter', x, core_cuts, twin_cuts))
            if x > 0 and free(x - 1) and free(x) and (typed[x - 1] or typed[x]):
                pairs += 1
                if (x in twin_cuts) != (x in core_cuts):
                    problems.append((c['base'], c['gaps'], 'between', x, core_cuts, twin_cuts))
        for b, e in new_text_words(c['base'], c['gaps'], words, None, sentences):
            if any(b < s < e for s in core_cuts):
                problems.append((c['base'], c['gaps'], 'crosses', b, e))
            if any(b < we and wb < e for wb, we in core['words']):
                problems.append((c['base'], c['gaps'], 'overlaps', b, e))
    assert problems[:5] == []
    assert checked > 400
    assert pairs > 300


def test_a_letter_typed_against_a_punctuation_word_is_free_where_core_leaves_it_in_no_word():
    # REV7-IGT-1: a word made only of punctuation (ud's `(` or `.`) takes no
    # text typed against it, so where a save only types into a text holding
    # one, a letter it typed is free for a new word exactly where core leaves
    # it in no word.
    problems = []
    checked = 0
    for c in CASES:
        if not all(g['start'] == g['end'] for g in c['gaps']):
            continue
        if not any(all(is_punct_char(ch) for ch in c['base'][b:e]) for b, e in c['words']):
            continue
        words = [{'begin': b, 'end': e} for b, e in c['words']]
        sentences = [{'begin': b, 'end': e} for b, e in c['sentences']]
        layout = new_text_layout(c['base'], c['gaps'], words, sentences)
        if layout is None:
            continue
        body, typed, covered, _ = layout
        for x in range(len(body)):
            if not typed[x] or is_js_space(body[x]):
                continue
            checked += 1
            in_word = any(b <= x < e for b, e in c['core']['words'])
            if in_word != bool(covered[x]):
                problems.append((c['base'], c['gaps'], x, in_word))
    assert problems[:5] == []
    assert checked > 500
