"""The ud assistant numbers a sentence's words as the app's grid does.

A surface token another app made has no UD word until a write makes one, and
plaid-ud's ``buildSentenceRows`` (sentenceRows.js) shows it as one stand-in
word with no annotation, numbered in its place, in the grid, a reader's view
and the export. The assistant's reader (``ud/project.py`` ``parse_document``)
must show the same words under the same CoNLL-U ids, or a plan row titled
"word 2" points at what the grid calls word 3. This runs the app's own row
builder (``ud_rows_mirror.mjs``) over fixture documents with random syntactic
words taken away and compares, word by word.

A write naming a stand-in makes its UD word first, in the same batch, as the
app's grid does (ConlluDocument ``_makeWords``).

A sentence holding no word at all (a punctuation-only line igt left
untokenized) has no row in the app, so the rows after it number on without a
gap. The assistant leaves it out and numbers the same way, and its
``merge_sentences`` takes it in, as the app's boundary toggle does.
"""

import copy
import json
import os
import random
import subprocess
import tempfile

import pytest

from live import Seeded, live_client, seed  # noqa: F401 - fixture
from plaid_agent.ud.plan import execute_plan
from plaid_agent.ud.project import load_document, load_project, parse_document
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace
from test_enhanced_mirror import _camel, _node
from ud_fixtures import DEPREL, LEMMA, PID, SENT_LAYER, TOK_LAYER, WORD_LAYER, document_raw, project_raw, ud_client

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'ud_rows_mirror.mjs')
CASES = 40


def bare(raw: dict, gone_ids) -> dict:
    """``raw`` with the syntactic words ``gone_ids`` taken away, with every
    span on them and every relation touching those spans, as a word another
    app made after the last UD open stands."""
    raw = copy.deepcopy(raw)
    gone = set(gone_ids)
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            if tk['id'] != WORD_LAYER:
                continue
            tk['tokens'] = [t for t in tk['tokens'] if t['id'] not in gone]
            spans = set()
            for sl in tk.get('span_layers') or []:
                spans |= {sp['id'] for sp in sl.get('spans') or [] if set(sp['tokens']) & gone}
                sl['spans'] = [sp for sp in sl.get('spans') or [] if sp['id'] not in spans]
            for sl in tk.get('span_layers') or []:
                for rl in sl.get('relation_layers') or []:
                    rl['relations'] = [r for r in rl.get('relations') or []
                                       if r['source'] not in spans and r['target'] not in spans]
    return raw


def gapped(raw: dict, first: bool = False) -> dict:
    """``raw`` with a sentence holding no word: the final "." of sentence 1
    cut off into a sentence of its own with its token and words taken away,
    or with ``first`` every word of sentence 1 taken away."""
    raw = copy.deepcopy(raw)
    layers = {tk['id']: tk for tl in raw['text_layers'] for tk in tl['token_layers']}
    if first:
        lo, hi = 0, 13
    else:
        layers[SENT_LAYER]['tokens'] = [{'id': 'us-1', 'begin': 0, 'end': 12, 'metadata': {'sent_id': 'train-1'}},
                                        {'id': 'us-gap', 'begin': 12, 'end': 13},
                                        *layers[SENT_LAYER]['tokens'][1:]]
        lo, hi = 12, 13
    gone = [t['id'] for t in layers[WORD_LAYER]['tokens'] if lo <= t['begin'] and t['end'] <= hi]
    raw = bare(raw, gone)
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            if tk['id'] in (TOK_LAYER, WORD_LAYER):
                tk['tokens'] = [t for t in tk['tokens'] if not (lo <= t['begin'] and t['end'] <= hi)]
    return raw


def _word_ids(raw):
    layer = next(tk for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == WORD_LAYER)
    return [t['id'] for t in layer['tokens']]


def _cases():
    r = random.Random(7)
    base = document_raw()
    ids = _word_ids(base)
    out = [bare(base, ids), bare(base, ['uw-2a', 'uw-2b']), bare(base, ['uw-2b']), bare(base, ['uw-1', 'uw-5']),
           gapped(base), gapped(base, first=True), bare(gapped(base), ['uw-5'])]
    while len(out) < CASES:
        out.append(bare(base, [i for i in ids if r.random() < 0.4]))
    return out


def _python_rows(raw):
    p = load_project(ud_client(), PID)
    doc = parse_document(raw, p)
    return [{'n': s.index, 'id': s.id, 'words': [[w.index, w.id, w.form, w.virtual] for w in s.words]}
            for s in doc.sentences]


@pytest.fixture(scope='module')
def compared():
    node = _node()
    raws = _cases()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'cases.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump([_camel(raw) for raw in raws], fh)
        run = subprocess.run([node, RUNNER, path], capture_output=True, text=True, timeout=300)
    if run.returncode != 0:
        pytest.fail(f'plaid-ud\'s domain modules would not run:\n{run.stderr[:2000]}')
    return raws, json.loads(run.stdout)


def test_the_cases_reach_partly_and_wholly_bare_sentences(compared):
    raws, js = compared
    py = [_python_rows(raw) for raw in raws]
    flags = [[w[3] for s in rows for w in s['words']] for rows in py]
    assert sum(all(f) for f in flags if f) >= 1
    assert sum(any(f) and not all(f) for f in flags) > CASES // 3


def test_the_assistant_numbers_every_word_as_the_grid_does(compared):
    raws, js = compared
    for raw, rows in zip(raws, js):
        assert _python_rows(raw) == rows


def _bare_ws():
    client = ud_client(documents={'ud1': bare(document_raw(), ['uw-3'])})
    ws = Workspace(client, load_project(client, PID))
    out = call_tool(ws, 'read_document', {'document': 'Viaje'})
    assert '4\tmar\t_\t' in out
    return ws


def _ops(batch):
    return [kind for kind, _ in batch]


def test_a_write_naming_a_stand_in_makes_its_word_in_the_same_batch():
    """A stand-in (s1.w4 "mar") is written as the editor writes it: the first
    write on it makes the UD word over its token, first among its words, with
    its lemma copied from its form, in the same batch (ConlluDocument
    ``_makeWords``). A lemma planned on it is that lemma, and a head it is
    given or gives hangs off it. The word is made once for the plan."""
    ws = _bare_ws()
    for name, args in (('set_field', {'refs': ['s1.w4'], 'field': 'upos', 'value': 'NOUN'}),
                       ('set_feature', {'refs': ['s1.w4'], 'feature': 'Number', 'value': 'Sing'}),
                       ('set_head', {'ref': 's1.w4', 'head': 1, 'deprel': 'obl'}),
                       ('set_head', {'ref': 's1.w5', 'head': 4, 'deprel': 'punct'})):
        got = call_tool(ws, name, {'document': 'Viaje', **args})
        assert got.startswith('Planned'), (name, got)
    assert all(op.get('virtual_at') or op.get('head_virtual_at') for op in ws.ops)
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    calls = [c for batch in ws.client.batches for c in batch]
    made = [p for k, p in calls if k == 'tokens.create']
    assert len(made) == 1
    assert made[0]['args'] == ('u-word', 'u-text', 9, 12) and made[0]['kwargs']['precedence'] == 0
    word = made[0]['kwargs']['id']
    lemmas = [p for k, p in calls if k == 'spans.create' and p['args'][0] == 'u-lemma']
    assert [(p['args'][1], p['args'][2], p['args'][3]['provSource']) for p in lemmas] == [
        ([word], 'mar', 'rule:lemma-from-form')]
    lemma = lemmas[0]['kwargs']['id']
    values = [(p['args'][0], p['args'][2]) for k, p in calls
              if k == 'spans.create' and p['args'][1] == [word] and p['args'][0] != 'u-lemma']
    assert sorted(values) == [('u-feats', 'Number=Sing'), ('u-upos', 'NOUN')]
    arcs = [p['args'][1:4] for k, p in calls if k == 'relations.create']
    assert ('sp-l1', lemma, 'obl') in arcs and (lemma, 'sp-l4', 'punct') in arcs
    # The word is made before anything names it.
    first = _ops(ws.client.batches[0])
    assert first[0] == 'tokens.create'


def test_a_lemma_planned_on_a_stand_in_is_the_lemma_it_is_made_with():
    ws = _bare_ws()
    call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'lemma', 'value': 'marea'})
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    (batch,) = ws.client.batches
    lemma = next(p for k, p in batch if k == 'spans.create')['kwargs']['id']
    assert _ops(batch) == ['tokens.create', 'spans.create', 'spans.bulk_update']
    (update,) = batch[2][1]
    assert (update['id'], update['value']) == (lemma, 'marea')


def test_two_features_on_a_stand_in_are_each_written():
    """Each feature is a span of its own: two planned on one stand-in make
    two spans, and the second does not take over the first. Only a lemma is
    the span the word is made with (R2-UD-1)."""
    ws = _bare_ws()
    got = call_tool(ws, 'set_field', {'document': 'Viaje', 'refs': ['s1.w4'], 'field': 'features',
                                      'value': 'Gender=Masc|Number=Sing'})
    assert got.startswith('Planned'), got
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    calls = [c for batch in ws.client.batches for c in batch]
    word = next(p for k, p in calls if k == 'tokens.create')['kwargs']['id']
    feats = {p['kwargs']['id']: p['args'][2] for k, p in calls
             if k == 'spans.create' and p['args'][:2] == ('u-feats', [word])}
    for k, p in calls:
        for u in (p if k == 'spans.bulk_update' else ()):
            if u['id'] in feats and 'value' in u:
                feats[u['id']] = u['value']
    assert sorted(feats.values()) == ['Gender=Masc', 'Number=Sing'], feats


def test_reads_on_a_stand_in_plan_nothing():
    ws = _bare_ws()
    for name, args in (('del_relation', {'refs': ['s1.w4']}),
                       ('confirm', {'refs': ['s1.w4']}),
                       ('set_field', {'refs': ['s1.w4'], 'field': 'upos', 'value': ''})):
        got = call_tool(ws, name, {'document': 'Viaje', **args})
        assert got.startswith('Nothing'), (name, got)
    assert ws.ops == []


def test_a_stand_in_s_token_is_reshaped_without_deleting_a_word():
    ws = _bare_ws()
    got = call_tool(ws, 'set_words', {'document': 'Viaje', 'ref': 's1.w4', 'forms': ['ma', 'r']})
    assert got.startswith('Planned'), got
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    kinds = [k for batch in ws.client.batches for k, _ in batch]
    assert 'tokens.bulk_delete' not in kinds and 'tokens.bulk_create' in kinds


def test_a_stand_in_s_token_is_split_into_tokens_with_no_ud_word():
    ws = _bare_ws()
    got = call_tool(ws, 'split_token', {'document': 'Viaje', 'ref': 's1.w4', 'parts': ['m', 'ar']})
    assert 'None of them has a UD word yet.' in got, got
    (op,) = ws.ops
    assert (op['word_ids'], op['new_parts']) == ([], [])
    execute_plan(ws.client, ws.ops, source='s', label='l', project=ws.project)
    kinds = [k for batch in ws.client.batches for k, _ in batch]
    assert 'tokens.bulk_create' not in kinds and 'tokens.split' in kinds


def test_a_sentence_with_no_words_has_no_number(compared):
    raws, js = compared
    gap, first = _python_rows(raws[4]), _python_rows(raws[5])
    assert [(r['n'], r['id']) for r in gap] == [(1, 'us-1'), (2, 'us-2')]
    assert [(r['n'], r['id']) for r in first] == [(1, 'us-2')]
    assert (js[4], js[5]) == (gap, first)


def test_a_merge_takes_in_the_sentence_with_no_words_between():
    client = ud_client(documents={'ud1': gapped(document_raw())})
    ws = Workspace(client, load_project(client, PID))
    out = call_tool(ws, 'read_document', {'document': 'Viaje'})
    assert '2 sentences' in out and 'us-gap' not in out
    call_tool(ws, 'merge_sentences', {'document': 'Viaje', 'ref': 's2'})
    merge = next(op for op in ws.ops if op['kind'] == 'merge_sentences')
    assert (merge['previous_id'], merge['between_ids'], merge['sentence_id']) == ('us-1', ['us-gap'], 'us-2')

    class Batch:
        def __init__(self):
            self.merges = []
            self.tokens = self

        def merge(self, a, b):
            self.merges.append((a, b))

    from plaid_agent.ud.sentences import apply_merge_sentences
    batch = Batch()

    class B:
        def add(self, fn):
            fn(batch)

    apply_merge_sentences(merge, B(), None)
    assert batch.merges == [('us-1', 'us-gap'), ('us-1', 'us-2')]


# --- in a real core ----------------------------------------------------------------

def _partes_bare():
    """test_ud_split_token's document with "Ella" (s1.w1) left without a UD
    word, as a token another app made stands."""
    from test_ud_split_token import _doc
    raw = _doc()
    words = raw['text_layers'][0]['token_layers'][2]
    words['tokens'] = [t for t in words['tokens'] if t['id'] != 'w1']
    for sl in words['span_layers']:
        sl['spans'] = [sp for sp in sl['spans'] if 'w1' not in sp['tokens']]
        for rl in sl.get('relation_layers') or []:
            rl['relations'] = [r for r in rl['relations'] if 'lw1' not in (r['source'], r['target'])]
    return raw


@pytest.fixture
def partes_bare(live_client):
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    s = seed(live_client, raw, {'sd1': _partes_bare()}, {}, name='ud-agent stand-in features test')
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    doc = _partes_bare()
    with live_client.batched() as b:
        b.token_layers.set_config(s.ids[WORD_LAYER], 'plaid', 'role', 'syntactic-word')
        b.token_layers.set_constraints(s.ids[WORD_LAYER], 'ud', [{'type': 'coextensive'}])
        for rl in lemma['relation_layers']:
            rid = s._mint(rl['id'])
            b.relation_layers.create(s.ids[LEMMA], rl['name'], id=rid)
            Seeded._configs(b.relation_layers, rid, rl.get('config'))
        rels = doc['text_layers'][0]['token_layers'][2]['span_layers'][1]['relation_layers'][0]['relations']
        for r in rels:
            b.relations.create(s.ids[DEPREL], s.ids[r['source']], s.ids[r['target']], r['value'],
                               id=s._mint(r['id']))
    yield s
    s.delete()


def test_two_features_and_a_lemma_on_a_stand_in_all_land(partes_bare):
    """In a real core: the card's two features and its lemma are what the
    made word holds after approval (R2-UD-1)."""
    s = partes_bare
    project = load_project(s.client, s.project_id)
    ws = Workspace(s.client, project)
    out = call_tool(ws, 'read_document', {'document': 'Partes'})
    assert '1\tElla\t_\t' in out, out[:600]
    for name, args in (('set_field', {'refs': ['s1.w1'], 'field': 'features', 'value': 'Number=Sing|Person=3'}),
                       ('set_field', {'refs': ['s1.w1'], 'field': 'lemma', 'value': 'él'})):
        got = call_tool(ws, name, {'document': 'Partes', **args})
        assert got.startswith('Planned'), got
    payload = ws.plan_payload()
    assert [c['label'] for c in payload['changes']] == ['Number=Sing', 'Person=3', 'lemma = "él"']
    execute_plan(s.client, copy.deepcopy(payload['ops']), source='test', label='l', project=project)
    w = load_document(s.client, project, s.ids['sd1']).sentences[0].words[0]
    assert not w.virtual
    assert (w.value('features'), w.value('lemma')) == ('Number=Sing|Person=3', 'él')
