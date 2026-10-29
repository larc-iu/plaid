"""An approved change to a lexicon entry's fields or structure is written over
the entry as the plan read it, so approval refuses it, nothing written, when
the entry has changed since (R1-7). Entries sit outside every document, so no
document version pins them: the plan pins each one it changes itself."""
from fixtures import VOCAB  # noqa: F401
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
