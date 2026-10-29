"""An approved change to a lexicon entry's fields or structure is written over
the entry as the plan read it, so approval refuses it, nothing written, when
the entry has changed since (R1-7). Entries sit outside every document, so no
document version pins them: the plan pins each one it changes itself."""
import copy

import pytest

from fixtures import VOCAB, lexicon_raw
from igt_rules_live import base_project, entry, seeded, workspace
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_rule_restate_live import _doc

from plaid_agent.igt.toolkit import call_tool


def _docs():
    return [_doc('d0', 'Doc A', [('Ali', '', [('Ali', '')]), ('gam', '', [('gam', '')])])]


def test_an_example_added_after_the_plan_is_not_written_over(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name='entry changed since: example')
    try:
        call_tool(ws, 'senses', {'action': 'promote_example', 'entry_form': 'Ali', 'document': 'Doc A',
                                 'ref': 's1.w1'})
        # The person adds a usage example of their own to "Ali" in the lexicon screen.
        doc = workspace(c, s).doc('Doc A')
        mine = {'document': doc.id, 'token': doc.sentences[0].words[1].id}
        c.vocab_items.patch_metadata(s.ids['vi-ali'], [{'op': 'set', 'path': ['examples'], 'value': [mine]}])
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'changed since the plan was made' in ' '.join(h.errors), (h.errors, h.done)
        assert (entry(c, s, 'vi-ali').get('metadata') or {}).get('examples') == [mine]
    finally:
        s.delete()


def test_a_field_set_since_the_plan_is_not_written_over(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name='entry changed since: field')
    try:
        call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'plan'})
        call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'G'})
        c.vocab_items.patch_metadata(s.ids['vi-ali'], [{'op': 'set', 'path': ['gloss'], 'value': 'person'}])
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'changed since the plan was made' in ' '.join(h.errors), (h.errors, h.done)
        assert (entry(c, s, 'vi-ali').get('metadata') or {}).get('gloss') == 'person'
        # Nothing of the plan was written.
        w = workspace(c, s).doc('Doc A').sentences[0].words[1]
        assert 'Gloss' not in {k for k in w.fields}, w.fields
    finally:
        s.delete()


def test_an_entry_left_alone_since_the_plan_takes_the_change(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name='entry changed since: none')
    try:
        call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'plan'})
        # Another entry changing is no reason to refuse.
        c.vocab_items.patch_metadata(s.ids['vi-gam'], [{'op': 'set', 'path': ['gloss'], 'value': 'other'}])
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert (entry(c, s, 'vi-ali').get('metadata') or {}).get('gloss') == 'plan'
    finally:
        s.delete()


def test_a_headword_corrected_since_the_plan_is_not_renamed_over(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name='entry changed since: rename form')
    try:
        call_tool(ws, 'rename_entry', {'entry_form': 'Ali', 'new_form': 'Aly'})
        c.vocab_items.update(s.ids['vi-ali'], 'Alí')  # the person's correction in the lexicon screen
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'changed since the plan was made' in ' '.join(h.errors), (h.errors, h.done)
        assert entry(c, s, 'vi-ali')['form'] == 'Alí'
    finally:
        s.delete()


def test_a_type_set_since_the_plan_is_not_overwritten_by_a_rename(live_client):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name='entry changed since: rename type')
    try:
        # "-gam" names a suffix, so the rename of the untyped entry also sets its type.
        call_tool(ws, 'rename_entry', {'entry_form': 'gam#1', 'new_form': '-gam'})
        c.vocab_items.patch_metadata(s.ids['vi-gam'], [{'op': 'set', 'path': ['morphType'], 'value': 'enclitic'}])
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'changed since the plan was made' in ' '.join(h.errors), (h.errors, h.done)
        assert (entry(c, s, 'vi-gam').get('metadata') or {}).get('morphType') == 'enclitic'
    finally:
        s.delete()


def _with_senses():
    lex = copy.deepcopy(lexicon_raw())
    lex['items'].append({'id': 'vi-ali-s1', 'form': 'Ali', 'metadata': {'gloss': 'one', 'parent': 'vi-ali',
                                                                        'senseOrder': 1}})
    return lex


@pytest.mark.parametrize('tool', ['delete_entry', 'merge_entries'])
def test_an_entry_that_gained_a_sense_since_the_plan_is_not_removed(live_client, tool):
    """A delete or a merge repairs the senses it read (freed, or moved to the survivor). A sense a person
    adds under the entry since would be left under an entry that no longer exists."""
    c = live_client
    s, _ws = seeded(c, base_project(), _docs(), lexicon=_with_senses(), name=f'entry changed since: {tool} sense')
    try:
        # The seed copies metadata as given: point the sense at the entry's real id.
        c.vocab_items.patch_metadata(s.ids['vi-ali-s1'], [{'op': 'set', 'path': ['parent'], 'value': s.ids['vi-ali']}])
        ws = workspace(c, s)
        args = ({'entry_id': s.ids['vi-ali']} if tool == 'delete_entry'
                else {'keep_id': s.ids['vi-gam'], 'remove_id': s.ids['vi-ali']})
        call_tool(ws, tool, args)
        c.vocab_items.create(s.ids[VOCAB], 'Ali', {'gloss': 'mine', 'parent': s.ids['vi-ali'], 'senseOrder': 2})
        _p, h, _ = approve(c, s.project_id, ws)
        assert h.errors and 'got a sense since the plan was made' in ' '.join(h.errors), (h.errors, h.done)
        assert entry(c, s, 'vi-ali')
        assert (entry(c, s, 'vi-ali-s1').get('metadata') or {}).get('parent') == s.ids['vi-ali']
    finally:
        s.delete()


@pytest.mark.parametrize('tool', ['delete_entry', 'merge_entries'])
def test_an_entry_whose_senses_are_as_read_is_removed(live_client, tool):
    c = live_client
    s, _ws = seeded(c, base_project(), _docs(), lexicon=_with_senses(), name=f'entry changed since: {tool} same')
    try:
        c.vocab_items.patch_metadata(s.ids['vi-ali-s1'], [{'op': 'set', 'path': ['parent'], 'value': s.ids['vi-ali']}])
        ws = workspace(c, s)
        args = ({'entry_id': s.ids['vi-ali']} if tool == 'delete_entry'
                else {'keep_id': s.ids['vi-gam'], 'remove_id': s.ids['vi-ali']})
        call_tool(ws, tool, args)
        # A sense under another entry is no reason to refuse.
        c.vocab_items.create(s.ids[VOCAB], 'gam', {'gloss': 'mine', 'parent': s.ids['vi-gam'], 'senseOrder': 1})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        ids = {it['id'] for it in c.vocab_layers.get(s.ids[VOCAB], include_items=True)['items']}
        assert s.ids['vi-ali'] not in ids
    finally:
        s.delete()
