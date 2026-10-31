"""A delete of an entry clears the references to it that the server held when the plan was made
(REFS_READ), and approval refuses it only for one set since (test_entry_changed_since.py). Each case
here sets the reference BEFORE planning, so nothing changed since, and approval goes through: the
plan's own delete of the referring entry or its own clearing of the reference does not count as
one set since (REV-FX-POLISH-1)."""
from igt_rules_live import base_project, entry, seeded, workspace
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_entry_changed_since import _docs

from plaid_agent.igt.toolkit import call_tool


def _project():
    p = base_project()
    p['vocabs'][0]['config']['igt']['fields']['variantOf'] = {'type': 'item', 'many': True}
    return p


def _gone(c, s, item):
    try:
        entry(c, s, item)
        return False
    except StopIteration:
        return True


def test_control_a_reference_read_at_planning_is_cleared(live_client):
    c = live_client
    s, _ws = seeded(c, _project(), _docs(), name='rev: control')
    try:
        c.vocab_items.patch_metadata(s.ids['vi-ali'], [{'op': 'set', 'path': ['variantOf'],
                                                        'value': [s.ids['vi-gam']]}])
        ws = workspace(c, s)
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-gam']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _gone(c, s, 'vi-gam')
    finally:
        s.delete()


def test_deleting_an_entry_and_its_variant_together(live_client):
    """ali is a variant of gam. The plan deletes ali, then gam."""
    c = live_client
    s, _ws = seeded(c, _project(), _docs(), name='rev: two deletes')
    try:
        c.vocab_items.patch_metadata(s.ids['vi-ali'], [{'op': 'set', 'path': ['variantOf'],
                                                        'value': [s.ids['vi-gam']]}])
        ws = workspace(c, s)
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-ali']})
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-gam']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _gone(c, s, 'vi-gam') and _gone(c, s, 'vi-ali')
    finally:
        s.delete()


def test_clearing_the_reference_then_deleting(live_client):
    """The plan clears ali's variantOf (which named gam), then deletes gam."""
    c = live_client
    s, _ws = seeded(c, _project(), _docs(), name='rev: clear then delete')
    try:
        c.vocab_items.patch_metadata(s.ids['vi-ali'], [{'op': 'set', 'path': ['variantOf'],
                                                        'value': [s.ids['vi-gam']]}])
        ws = workspace(c, s)
        call_tool(ws, 'set_entry_field', {'entry_id': s.ids['vi-ali'], 'field': 'variantOf', 'value': ''})
        call_tool(ws, 'delete_entry', {'entry_id': s.ids['vi-gam']})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert _gone(c, s, 'vi-gam')
    finally:
        s.delete()
