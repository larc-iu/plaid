"""split_token: one UD token made several, as a plan.

The survey's b2f0ee67: a token whose text held a line break was made ONE
multi-word token of ten words where the user wanted ten tokens, and 27 values
and 10 dependencies went with the words set_words replaced. split_token cuts a
token into tokens and keeps what is on its words, as the Text Editor's split
does when a space is typed inside a token: the token keeps its row on the part
holding most of its letters, its words go with it, a multi-word token with as
many words as parts deals them out one to a part, and a part left without a
word gets a bare one.

The staging and the refusals run on the fake client. What the split does to
the stored rows is proved in a private core, with the UD rule that a word is
as wide as its token declared, since only the core cascades.
"""

import copy

import pytest

from live import live_client, seed  # noqa: F401 - fixture
from plaid_agent.core.tools import ToolError
from plaid_agent.ud.plan import execute_plan, validate_ops
from plaid_agent.ud.project import load_document, load_project, render_document
from plaid_agent.ud.shape import t_set_words, t_split_token
from plaid_agent.ud.toolkit import call_tool
from plaid_agent.ud.tools import Workspace, t_set_field, t_set_head
from plaid_agent.ud.trace import describe_step
from ud_fixtures import (DEPREL, FEATS, FORM, LEMMA, SENT_LAYER, TEXT_ID, TEXT_LAYER, TOK_LAYER, UPOS,
                         WORD_LAYER, XPOS, FakeClient, project_raw)

#         0         1         2         3         4
#         0123456789012345678901234567890123456789012345
BODY = 'Ella vende pan dulce. Mi casa. cannot. a bcd.'


def _doc():
    """Four sentences, one token to split in each: "vende pan" a multi-word
    token of two annotated words (made where two tokens were meant), "Mi
    casa" and "a bcd" one annotated word over a space, "cannot" one word with
    no space in it."""
    words = [('w1', 0, 4, 1), ('w2a', 5, 14, 1), ('w2b', 5, 14, 2), ('w3', 15, 20, 1), ('w4', 20, 21, 1),
             ('w5', 22, 29, 1), ('w6', 29, 30, 1), ('w7', 31, 37, 1), ('w8', 37, 38, 1),
             ('w9', 39, 44, 1), ('w10', 44, 45, 1)]
    lemmas = {'w1': 'ella', 'w2a': 'vender', 'w2b': 'pan', 'w3': 'dulce', 'w4': '.', 'w5': 'mi casa',
              'w6': '.', 'w7': 'cannot', 'w8': '.', 'w9': 'a bcd', 'w10': '.'}
    upos = {'w1': 'PRON', 'w2a': 'VERB', 'w2b': 'NOUN', 'w3': 'ADJ', 'w4': 'PUNCT', 'w5': 'NOUN',
            'w6': 'PUNCT', 'w7': 'VERB', 'w9': 'NOUN'}
    deps = [('w2a', 'w2a', 'root'), ('w2a', 'w1', 'nsubj'), ('w2a', 'w2b', 'obj'), ('w2b', 'w3', 'amod'),
            ('w2a', 'w4', 'punct'), ('w5', 'w5', 'root'), ('w5', 'w6', 'punct'), ('w7', 'w7', 'root'),
            ('w7', 'w8', 'punct'), ('w9', 'w9', 'root'), ('w9', 'w10', 'punct')]
    return {
        'id': 'sd1', 'name': 'Partes', 'version': 1,
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': TEXT_ID, 'body': BODY},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': [{'id': 's1', 'begin': 0, 'end': 21},
                                              {'id': 's2', 'begin': 22, 'end': 30},
                                              {'id': 's3', 'begin': 31, 'end': 38},
                                              {'id': 's4', 'begin': 39, 'end': 45}], 'span_layers': []},
                {'id': TOK_LAYER, 'tokens': [
                    {'id': 't1', 'begin': 0, 'end': 4},
                    {'id': 't2', 'begin': 5, 'end': 14, 'metadata': {'form': 'vende pan'}},
                    {'id': 't3', 'begin': 15, 'end': 20}, {'id': 't4', 'begin': 20, 'end': 21},
                    {'id': 't5', 'begin': 22, 'end': 29}, {'id': 't6', 'begin': 29, 'end': 30},
                    {'id': 't7', 'begin': 31, 'end': 37}, {'id': 't8', 'begin': 37, 'end': 38},
                    {'id': 't9', 'begin': 39, 'end': 44}, {'id': 't10', 'begin': 44, 'end': 45}],
                 'span_layers': []},
                {'id': WORD_LAYER,
                 'tokens': [{'id': i, 'begin': b, 'end': e, 'precedence': p} for i, b, e, p in words],
                 'span_layers': [
                     {'id': FORM, 'spans': [{'id': 'f2a', 'value': 'vende', 'tokens': ['w2a']},
                                            {'id': 'f2b', 'value': 'pan', 'tokens': ['w2b']}]},
                     {'id': LEMMA, 'spans': [{'id': 'l' + w, 'value': v, 'tokens': [w]} for w, v in lemmas.items()],
                      'relation_layers': [{'id': DEPREL, 'relations': [
                          {'id': f'r-{d}', 'source': 'l' + h, 'target': 'l' + d, 'value': v}
                          for h, d, v in deps]}]},
                     {'id': UPOS, 'spans': [{'id': 'u' + w, 'value': v, 'tokens': [w]} for w, v in upos.items()]},
                     {'id': XPOS, 'spans': []},
                     {'id': FEATS, 'spans': [{'id': 'x2b', 'value': 'Number=Sing', 'tokens': ['w2b']}]},
                 ]},
            ]}],
    }


@pytest.fixture
def ws():
    client = FakeClient(documents={'sd1': _doc()})
    from ud_fixtures import PID
    return Workspace(client, load_project(client, PID))


# --- staging --------------------------------------------------------------------

def test_a_multiword_token_with_as_many_words_as_parts_deals_them_out(ws):
    out = t_split_token(ws, document='Partes', ref='s1.w2-3')
    assert out == ('Planned splitting s1.w2-3 "vende pan" into 2 tokens: "vende", "pan". Each of its words goes '
                   'to its own token, in order ("vende" to "vende", "pan" to "pan"), keeping its values and '
                   'dependencies.')
    [op] = ws.ops
    assert op['pieces'] == [[0, 5], [6, 9]] and op['dealt'] and op['keep'] == 0 and op['new_parts'] == []
    assert op['form_meta'] == ['delete', None]
    assert op['label'] == ('split "vende pan" into "vende" | "pan" (each word on its own token, with its values '
                           'and dependencies)')
    validate_ops(ws.ops)


def test_one_word_stays_on_the_longest_part_and_says_what_it_holds(ws):
    out = t_split_token(ws, document='Partes', ref='s2.w1')
    assert out == ('Planned splitting s2.w1 "Mi casa" into 2 tokens: "Mi", "casa". "casa" keeps its word and '
                   'every value and dependency on it. "Mi" gets a new word with no annotation. What it holds '
                   'was made for "Mi casa" (lemma "mi casa", upos "NOUN"): check it against "casa" once this '
                   'is applied.')
    [op] = ws.ops
    assert op['keep'] == 1 and op['new_parts'] == [0] and 'form_meta' not in op
    assert op['forms'] == ['Mi', 'casa'] and op['after_ids'][0] is None


def _ws_with_forms(spans):
    """The document with more Form spans: ``{word id: value}``."""
    doc = _doc()
    form = doc['text_layers'][0]['token_layers'][2]['span_layers'][0]
    form['spans'] += [{'id': 'f' + w, 'value': v, 'tokens': [w]} for w, v in spans.items()]
    client = FakeClient(documents={'sd1': doc})
    from ud_fixtures import PID
    return Workspace(client, load_project(client, PID))


def test_a_form_span_the_kept_part_no_longer_spells_is_named_first():
    """H16-UD-TOOLS-1: the word's Form span spelled the whole token. The kept
    part is shorter, so of what it holds the Form span is surely wrong, and
    the reply and the card both name it."""
    ws = _ws_with_forms({'w5': 'Mi kaza'})
    out = t_split_token(ws, document='Partes', ref='s2.w1')
    assert out.endswith('What it holds was made for "Mi casa" (form "Mi kaza", lemma "mi casa", upos "NOUN"): '
                        'check it against "casa" once this is applied.')
    assert ws.ops[0]['label'] == ('split "Mi casa" into "Mi" | "casa" ("casa" keeps its word s2.w1 with its form '
                                  '"Mi kaza", values and dependencies, "Mi" gets a new word with none)')


def test_a_form_span_that_spells_the_kept_part_is_not_named():
    ws = _ws_with_forms({'w5': 'casa'})
    t_split_token(ws, document='Partes', ref='s2.w1')
    assert ws.ops[0]['label'] == ('split "Mi casa" into "Mi" | "casa" ("casa" keeps its word s2.w1 with its '
                                  'values and dependencies, "Mi" gets a new word with none)')


def test_a_multiword_token_kept_whole_names_its_forms_and_counts_its_new_words(ws):
    """H16-UD-TOOLS-1 and 2: more parts than words keeps every word on the
    longest part, their Form spans with them, and two new parts each get a
    word."""
    out = t_split_token(ws, document='Partes', ref='s1.w2-3', parts=['ven', 'de', 'pan'])
    assert ws.ops[0]['label'] == ('split "vende pan" into "ven" | "de" | "pan" ("ven" keeps its 2 words with '
                                  'their forms "vende", "pan", values and dependencies, "de", "pan" each get a '
                                  'new word with none)')
    assert '(form "vende", form "pan", lemma "vender", upos "VERB", lemma "pan", upos "NOUN", …)' in out


def test_parts_cut_a_token_with_no_space(ws):
    out = t_split_token(ws, document='Partes', ref='s3.w1 "cannot"', parts=['can', 'not'])
    assert out.startswith('Planned splitting s3.w1 "cannot" into 2 tokens: "can", "not". "can" keeps its word')
    assert ws.ops[0]['pieces'] == [[0, 3], [3, 6]]


@pytest.mark.parametrize('parts, said', [
    (None, '"cannot" holds no space to split at. Give parts: the new tokens\' texts in order, e.g. '
           '["can", "not"].'),
    (['cannot'], 'Give parts: two or more texts that spell the token in order, e.g. ["can", "not"].'),
    (['can', 'nt'], 'The parts must spell "cannot" in order, without the spaces between them. After "can" '
                    'comes "not", not "nt". Nothing was planned.'),
    (['can', 'no'], 'The parts leave out "t" at the end of "cannot". Every letter goes in a part. Nothing was '
                   'planned.'),
])
def test_parts_that_do_not_spell_the_token_are_refused(ws, parts, said):
    with pytest.raises(ToolError) as e:
        t_split_token(ws, document='Partes', ref='s3.w1', parts=parts)
    assert str(e.value) == said and ws.ops == []


def test_set_words_over_a_space_points_at_split_token(ws):
    with pytest.raises(ToolError, match=r'To make tokens of it, use split_token on s2\.w1\.$'):
        t_set_words(ws, document='Partes', ref='s2.w1', forms=['Mi', 'casa'])


def test_a_token_is_reshaped_once_per_plan_either_way(ws):
    t_split_token(ws, document='Partes', ref='s1.w2-3')
    with pytest.raises(ToolError, match='already reshapes this token'):
        t_set_words(ws, document='Partes', ref='s1.w2-3', forms=['vende'])
    ws.ops.clear()
    t_set_words(ws, document='Partes', ref='s1.w2-3', forms=['vende'])
    with pytest.raises(ToolError, match='already reshapes this token'):
        t_split_token(ws, document='Partes', ref='s1.w2-3')


def test_a_second_split_of_the_same_token_replaces_the_first(ws):
    """A split restates every cut, so the second split of one token in a
    plan is the correction of the first, not a clash (UD.md, 2026-10-16)."""
    t_split_token(ws, document='Partes', ref='s3.w1', parts=['ca', 'nnot'])
    out = t_split_token(ws, document='Partes', ref='s3.w1 "cannot"', parts=['can', 'not'])
    assert out.startswith('Planned splitting'), out
    [op] = ws.ops
    assert op['kind'] == 'split_token' and [op['surface'][a:b] for a, b in op['pieces']] == ['can', 'not']


def test_a_word_the_split_moves_keeps_taking_writes_and_its_neighbours_are_renumbered(ws):
    t_split_token(ws, document='Partes', ref='s2.w1')
    # The kept word is still a word with an id, so a value on it is planned,
    # named with its form since the split renumbers it.
    t_set_field(ws, document='Partes', refs=['s2.w1 "Mi casa"'], field='upos', value='DET')
    assert ws.ops[-1]['token_id'] == 'w5'
    # The word the split makes has no id until the plan runs.
    with pytest.raises(ToolError) as e:
        t_set_head(ws, document='Partes', ref='s2.w2', head=3, deprel='punct')
    assert ('s2.w2 is "." now, but this plan\'s split_token renumbers s2: once it is applied, "." is w3'
            in str(e.value))
    with pytest.raises(ToolError) as e:
        t_set_field(ws, document='Partes', refs=['s2.w3'], field='upos', value='PUNCT')
    assert ('once this plan\'s split_token runs its words are w1 "Mi", w2 "casa", w3 "."' in str(e.value))


def test_the_tool_is_on_the_table_with_its_trace(ws):
    out = call_tool(ws, 'split_token', {'document': 'Partes', 'ref': 's3.w1', 'parts': ['can', 'not']})
    assert out.startswith('Planned splitting')
    assert describe_step('split_token', {'document': 'Partes', 'ref': 's3.w1', 'parts': ['can', 'not']}) \
        == 'Planned splitting s3.w1 into \u201ccan\u201d + \u201cnot\u201d in \u201cPartes\u201d'
    assert 'at its spaces' in describe_step('split_token', {'document': 'Partes', 'ref': 's2.w1'})


# --- in a real core ----------------------------------------------------------------

@pytest.fixture
def partes(live_client):
    """The document in a private core, its tree drawn, and the word layer
    holding the rule plaid-ud declares on it: a word is as wide as its token."""
    from live import Seeded
    raw = project_raw()
    words = raw['text_layers'][0]['token_layers'][2]
    words['config'] = {'plaid': {'role': 'morpheme'}}
    s = seed(live_client, raw, {'sd1': _doc()}, {}, name='ud-agent split_token test')
    lemma = next(sl for sl in words['span_layers'] if sl['id'] == LEMMA)
    doc = _doc()
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


def test_a_split_shares_its_plan_with_a_scope_over_its_document(partes):
    """A split deletes no word, so a corpus-wide change over the same
    document may share its plan, both orders, and both land (UD.md,
    2026-10-16). A set_words, which deletes its token's words, may not."""
    s = partes
    project, _before = _read(s)
    ws = Workspace(s.client, project)
    call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'pan', 'replacement': 'pane', 'whole': True})
    t_split_token(ws, document='Partes', ref='s2.w1')
    assert [o['kind'] for o in ws.ops] == ['replace_scope', 'split_token']
    validate_ops(copy.deepcopy(ws.plan_payload()['ops']))
    counts = execute_plan(s.client, copy.deepcopy(ws.plan_payload()['ops']), source='test', label='both',
                          project=project)
    assert counts.get('split tokens') == 1, counts
    _, doc = _read(s)
    assert [r[2] for r in _rows(doc, 1) if r[0] == 'pan'] == ['pane']
    assert [r[0] for r in _rows(doc, 2)] == ['Mi', 'casa', '.']
    # The other order is the same plan, and a set_words still clashes.
    ws = Workspace(s.client, load_project(s.client, s.project_id))
    t_split_token(ws, document='Partes', ref='s3.w1', parts=['can', 'not'])
    out = call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'dulce', 'replacement': 'dulcis',
                                             'whole': True})
    assert [o['kind'] for o in ws.ops] == ['split_token', 'replace_scope'], out
    ws.ops.clear()
    t_set_words(ws, document='Partes', ref='s1.w2-3', forms=['vende'])
    out = call_tool(ws, 'replace_in_field', {'field': 'lemma', 'pattern': 'dulce', 'replacement': 'dulcis',
                                             'whole': True})
    assert out.startswith('Error: This plan already reshapes a token in a document this replacement reaches'), out


def _read(s):
    project = load_project(s.client, s.project_id)
    return project, load_document(s.client, project, s.ids['sd1'])


def _rows(doc, n):
    """``(form, token surface, lemma, upos, feats, head, deprel)`` per word of
    sentence ``n``."""
    return [(w.form, w.token.surface, w.value('lemma'), w.value('upos'), w.value('features'), w.head, w.deprel)
            for w in doc.sentences[n - 1].words]


def test_every_split_lands_in_one_plan_with_values_and_dependencies_kept(partes):
    s = partes
    project, before = _read(s)
    ws = Workspace(s.client, project)
    t_split_token(ws, document='Partes', ref='s1.w2-3')
    t_split_token(ws, document='Partes', ref='s2.w1')
    t_split_token(ws, document='Partes', ref='s3.w1', parts=['can', 'not'])
    t_split_token(ws, document='Partes', ref='s4.w1')
    ops = copy.deepcopy(ws.plan_payload()['ops'])
    counts = execute_plan(s.client, ops, source='test', label='split tokens', project=project)
    assert counts.get('split tokens') == 4

    _, doc = _read(s)
    assert _rows(doc, 1) == [
        ('Ella', 'Ella', 'ella', 'PRON', '', 2, 'nsubj'),
        ('vende', 'vende', 'vender', 'VERB', '', 0, 'root'),
        ('pan', 'pan', 'pan', 'NOUN', 'Number=Sing', 2, 'obj'),
        ('dulce', 'dulce', 'dulce', 'ADJ', '', 3, 'amod'),
        ('.', '.', '.', 'PUNCT', '', 2, 'punct')]
    # The words are the same rows, each now alone in its token, and the
    # multi-word token's surface went with the range.
    s1 = doc.sentences[0]
    assert [w.id for w in s1.words[1:3]] == [s.ids['w2a'], s.ids['w2b']]
    assert s1.tokens[1].id == s.ids['t2'] and 'form' not in s1.tokens[1].metadata
    assert (s1.tokens[1].begin, s1.tokens[1].end, s1.tokens[2].begin, s1.tokens[2].end) == (5, 10, 11, 14)

    # "casa" is the longer part, so the token and its word stay there, the
    # word's values and dependencies with it, and "Mi" has a bare word.
    assert _rows(doc, 2) == [('Mi', 'Mi', '', '', '', None, None),
                             ('casa', 'casa', 'mi casa', 'NOUN', '', 0, 'root'),
                             ('.', '.', '.', 'PUNCT', '', 2, 'punct')]
    s2 = doc.sentences[1]
    assert s2.tokens[1].id == s.ids['t5'] and s2.words[1].id == s.ids['w5']
    assert s2.words[0].id not in s.ids.back

    assert _rows(doc, 3) == [('can', 'can', 'cannot', 'VERB', '', 0, 'root'),
                             ('not', 'not', '', '', '', None, None),
                             ('.', '.', '.', '', '', 1, 'punct')]
    assert doc.sentences[2].tokens[0].id == s.ids['t7']
    assert _rows(doc, 4) == [('a', 'a', '', '', '', None, None),
                             ('bcd', 'bcd', 'a bcd', 'NOUN', '', 0, 'root'),
                             ('.', '.', '.', '', '', 2, 'punct')]
    # Nothing else in the document moved, and every word is as wide as its
    # token (the server held the rule at the end of the batch).
    assert doc.body == BODY
    assert sum(len(x.words) for x in doc.sentences) == sum(len(x.words) for x in before.sentences) + 3
    for sent in doc.sentences:
        for tok in sent.tokens:
            assert all(not w.virtual for w in tok.words)
    # The new words carry the approval's provenance, as a set_words word does.
    raw = s.client.documents.get(s.ids['sd1'], include_body=True)
    made = [t for tl in raw['text_layers'] for tk in tl['token_layers'] if tk['id'] == s.ids[WORD_LAYER]
            for t in tk['tokens'] if t['id'] not in s.ids.back]
    assert len(made) == 3 and all((t.get('metadata') or {}).get('prov') == 'inferred' for t in made)
    assert 'vende' in render_document(doc)

