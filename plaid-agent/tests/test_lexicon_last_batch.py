"""An entry rename, merge or delete moves the version of every document
linking the entry, so approval writes them last, in a batch of their own
after every document write, with the repairs a delete or a merge carries.

A Delete entry refused at approval (a link made since the plan read it, or
links in a project this one cannot open) then leaves the lexicon as it was:
no sense freed and no reference cleared for an entry that stays (R1-3). And a
plan renaming or merging away an entry linked in a document it also writes
to applies, where its own document writes used to meet the version the
rename had just moved (R1-5)."""
import copy

from fixtures import VOCAB, lexicon_raw
from igt_rules_live import base_project, entry, seeded, workspace
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_rule_restate_live import _doc

from plaid_agent.igt.toolkit import call_tool


def _lexicon():
    lex = copy.deepcopy(lexicon_raw())
    # A sense of "Ali", which a delete of "Ali" makes a headword of its own.
    lex['items'].append({'id': 'vi-ali-s1', 'form': 'Ali', 'metadata': {'gloss': 'Ali (name)', 'parent': 'vi-ali',
                                                                        'senseOrder': 1}})
    return lex


def _doc_linked(did, name, item=None):
    d = _doc(did, name, [('Ali', '', [('Ali', '')]), ('gam', '', [('gam', '')])])
    if item:
        d['text_layers'][0]['token_layers'][1]['vocabs'] = [{'id': VOCAB, 'name': 'Lexicon', 'vocab_links': [
            {'id': f'{did}-l0', 'vocab_item': {'id': item}, 'tokens': [f'{did}-w0']}]}]
    return d


def _with_sense(c, s):
    # The seed copies metadata as given: point the sense at the entry's real id.
    c.vocab_items.patch_metadata(s.ids['vi-ali-s1'], [{'op': 'set', 'path': ['parent'], 'value': s.ids['vi-ali']}])


def test_a_delete_refused_for_a_link_made_since_leaves_its_senses(live_client):
    c = live_client
    docs = [_doc_linked('d0', 'Doc A', 'vi-ali'), _doc_linked('d1', 'Doc B')]
    s, _ws = seeded(c, base_project(), docs, lexicon=_lexicon(), name='lexicon last: link since')
    try:
        _with_sense(c, s)
        ws = workspace(c, s)
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-ali']})
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'G'})
        assert any(op['kind'] == 'set_entry_metadata' for op in ws.ops), ws.ops
        # Meanwhile someone links "Ali" in a document the plan never read.
        c.vocab_links.create(s.ids['vi-ali'], [workspace(c, s).doc('Doc B').sentences[0].words[0].id], {})
        _p, h, _ = approve(c, s.project_id, ws)
        # The field value stands, written before the lexicon's batch: partly applied.
        said = ' '.join(h.errors + [d.get('message') or '' for d in h.done])
        assert 'Partly applied: 1 of 3' in said and 'got a link after this plan was read' in said, said
        assert (entry(c, s, 'vi-ali-s1').get('metadata') or {}).get('parent') == s.ids['vi-ali']
        assert entry(c, s, 'vi-ali')
    finally:
        s.delete()


def test_a_delete_refused_for_links_elsewhere_leaves_its_senses(live_client):
    c = live_client
    s, _ws = seeded(c, base_project(), [_doc_linked('d0', 'Doc A', 'vi-ali')], lexicon=_lexicon(),
                    name='lexicon last: elsewhere')
    other, _ = seeded(c, base_project(), [_doc_linked('e0', 'Other')], name='lexicon last: elsewhere B')
    try:
        _with_sense(c, s)
        # The lexicon is linked into the other project too, where a word is linked to "Ali".
        c.projects.link_vocab(other.project_id, s.ids[VOCAB])
        c.vocab_links.create(s.ids['vi-ali'], [other.ids['e0-w0']], {})
        ws = workspace(c, s)
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-ali']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'linked in projects this assistant cannot open' in ' '.join(h.errors), h.errors
        assert (entry(c, s, 'vi-ali-s1').get('metadata') or {}).get('parent') == s.ids['vi-ali']
    finally:
        s.delete()
        other.delete()


def test_a_delete_with_its_repairs_beside_a_document_write_applies(live_client):
    c = live_client
    s, _ws = seeded(c, base_project(), [_doc_linked('d0', 'Doc A', 'vi-ali')], lexicon=_lexicon(),
                    name='lexicon last: delete applies')
    try:
        _with_sense(c, s)
        ws = workspace(c, s)
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-ali']})
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'G'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        items = {it['id'] for it in c.vocab_layers.get(s.ids[VOCAB], include_items=True)['items']}
        assert s.ids['vi-ali'] not in items
        assert not (entry(c, s, 'vi-ali-s1').get('metadata') or {}).get('parent')
        w = workspace(c, s).doc('Doc A').sentences[0].words[0]
        assert w.link is None and w.fields['Gloss'].value == 'G', (w.link, w.fields)
    finally:
        s.delete()


def test_a_rename_of_a_linked_entry_beside_a_write_in_its_document_applies(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), [_doc_linked('d0', 'Doc A', 'vi-ali')], name='lexicon last: rename')
    try:
        call_tool(ws, 'rename_entry', {'entry_form': 'Ali', 'new_form': 'Aly'})
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert entry(c, s, 'vi-ali')['form'] == 'Aly'
        assert workspace(c, s).doc('Doc A').sentences[0].words[1].fields['Gloss'].value == 'fish'
    finally:
        s.delete()


def test_respell_all_into_the_lexicon_of_a_linked_word_applies(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), [_doc_linked('d0', 'Doc A', 'vi-ali')], name='lexicon last: respell')
    try:
        call_tool(ws, 'respell_all', {'pattern': 'Ali', 'replacement': 'Aly', 'lexicon': True})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert entry(c, s, 'vi-ali')['form'] == 'Aly'
        assert workspace(c, s).doc('Doc A').body.startswith('Aly')
    finally:
        s.delete()


def test_a_merge_of_a_linked_entry_beside_an_update_in_its_document_applies(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), [_doc_linked('d0', 'Doc A', 'vi-ali')], name='lexicon last: merge')
    try:
        call_tool(ws, 'merge_entries', {'keep_form': 'gam#1', 'remove_form': 'Ali'})
        call_tool(ws, 'set_orthography', {'document': 'Doc A', 'refs': ['s1.w2'], 'orthography': 'IPA',
                                          'value': 'gam'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert workspace(c, s).doc('Doc A').sentences[0].words[0].link.form == 'gam'
    finally:
        s.delete()
