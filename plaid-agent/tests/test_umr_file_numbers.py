"""A UMR document imported from a file that numbers its own sentences (an
excerpt starting at snt5) goes by the file's numbers everywhere: the app
shows its first sentence as 5, its variables are ``s5…``, and the assistant
reads it as s5, takes s5 back, mints ``s5…`` and refuses ``s1…`` there, as the
app does (H9-NUM-2). A document numbered from 1 reads as before."""

import copy

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr import read_document, resolve_layers
from umr_fixtures import document_raw, umr_client, umr_ws


def excerpt_raw():
    """The fixture as a file numbered from snt5 imports it: records snt 5 and
    6, and every variable named for them."""
    raw = copy.deepcopy(document_raw())
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for t in tk['tokens']:
                umr = (t.get('metadata') or {}).get('umr')
                if isinstance(umr, dict) and 'snt' in umr:
                    umr['snt'] = umr['snt'] + 4
            for sl in tk.get('span_layers') or []:
                for sp in sl.get('spans') or []:
                    umr = (sp.get('metadata') or {}).get('umr') or {}
                    if umr.get('var'):
                        umr['var'] = {'s1': 's5', 's2': 's6'}[umr['var'][:2]] + umr['var'][2:]
    return raw


def _ws():
    return umr_ws(umr_client(documents={'umr1': excerpt_raw()}))


def test_the_sentences_go_by_the_files_numbers():
    raw = excerpt_raw()
    doc = read_document(raw, resolve_layers(raw))
    assert [(s.index, s.number) for s in doc.sentences] == [(1, 5), (2, 6)]
    plain = document_raw()
    assert [s.number for s in read_document(plain, resolve_layers(plain)).sentences] == [1, 2]


def test_a_read_names_the_sentences_by_the_files_numbers():
    out = call_tool(_ws(), 'read_document', {'document': 'Story'})
    assert '# sent_id = s5\n' in out and '# sent_id = s6\n' in out and '# sent_id = s1' not in out
    one = call_tool(_ws(), 'read_document', {'document': 'Story', 'sentences': ['s6']})
    assert '# sent_id = s6\n' in one and '# sent_id = s5' not in one
    ranged = call_tool(_ws(), 'read_document', {'document': 'Story', 'from_sentence': 's6'})
    assert '# sent_id = s6\n' in ranged and '# sent_id = s5' not in ranged
    gone = call_tool(_ws(), 'read_document', {'document': 'Story', 'sentences': ['s1']})
    assert 'numbers its sentences as its file does: s5, s6' in gone


def test_a_new_node_takes_the_files_number_and_the_place_is_refused():
    ws = _ws()
    out = call_tool(ws, 'apply_penman', {
        'document': 'Story', 'sentence': 's5',
        'text': '(s5b / bark-01 :ARG0 (s5d / dog :refer-number singular) :aspect performance '
                ':mod (s5z / zebra))'})
    assert out.startswith('Planned'), out
    made = [op for op in ws.ops if op['kind'] == 'create_node']
    assert [(op['var'], op['ref']) for op in made] == [('s5z', 's5.s5z')]

    ws = _ws()
    out = call_tool(ws, 'apply_penman', {
        'document': 'Story', 'sentence': 's5',
        'text': '(s5b / bark-01 :ARG0 (s5d / dog :refer-number singular) :aspect performance '
                ':mod (s1z / zebra))'})
    assert 's1z names sentence 1, and the node is in sentence 5.' in out
    assert not [op for op in ws.ops if op['kind'] == 'create_node']


def test_a_reference_by_place_is_not_taken_for_the_files_number():
    out = call_tool(_ws(), 'apply_penman', {'document': 'Story', 'sentence': 's1',
                                            'text': '(s1z / zebra)'})
    assert 'numbers its sentences as its file does' in out


def test_a_comment_an_approval_and_a_query_name_the_sentence_by_its_number():
    """The comments tool, an approval's "sentence N has changed" and a query's
    rows name a sentence by the number every other tool takes back. A comment
    on the file's snt6 read as s2, which the assistant then resolved to no
    sentence, or in a document numbered 1, 5, 6 to another one."""
    from plaid_agent.umr.query import _ref_index
    ws = _ws()
    doc = ws.doc('Story')
    second = doc.sentences[1]
    assert ws.comment_ref(doc, {'entity_type': 'token', 'entity_id': second.id}) == 's6'
    assert sorted(n for n, _print in ws.current_prints(doc.id).values()) == [5, 6]
    refs = _ref_index(ws, [doc.id])
    assert refs[second.id] == '"Story" s6'
    assert refs[second.words[0].id] == '"Story" s6 word 1'
