"""One check for whether a field may take a value, whatever the field (R1-1):
a document metadata field and a lexicon entry field held to a CLOSED tagset
refuse an off-list value at staging, as an annotation field's value-set rule
does, and an entry's type is one of the types the app knows, set as a field
or given to a new entry. The app never writes any of these: its Details page
will not save a metadata value the tagset refuses, its entry editor offers
the closed list only, and its Type list is FLEx's inventory."""
from igt_rules_live import base_project, entry, seeded
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_rule_restate_live import _doc

from plaid_agent.igt.toolkit import call_tool


def _project():
    p = base_project()
    igt = p['config']['igt']
    igt['documentMetadata'] = [{'name': 'Date'}, {'name': 'Genre', 'tagset': 'Genres'}]
    igt['tagsets']['Genres'] = {'delimiters': '', 'mode': 'closed',
                                'values': [{'value': 'narrative'}, {'value': 'conversation'}]}
    vcfg = p['vocabs'][0]['config']['igt']
    vcfg['fields']['pos'] = {'inline': True, 'role': 'pos', 'tagset': 'POS'}
    vcfg['tagsets'] = {'POS': {'delimiters': '', 'mode': 'closed', 'values': [{'value': 'N'}, {'value': 'V'}]}}
    return p


def _setup(c, name):
    return seeded(c, _project(), [_doc('d0', 'Doc A', [('gam', '', [('gam', '')])])], name=name)


def test_document_metadata_off_a_closed_tagset_is_refused(live_client):
    c = live_client
    s, ws = _setup(c, 'field lists: metadata')
    try:
        out = call_tool(ws, 'set_document_metadata', {'document': 'Doc A', 'field': 'Genre', 'value': 'poem'})
        assert '"poem" is not on the list Genre is held to' in out and 'narrative' in out, out
        out = call_tool(ws, 'create_document', {'name': 'Doc B', 'text': 'aa', 'metadata': {'Genre': 'poem'}})
        assert '"poem" is not on the list Genre is held to' in out, out
        assert ws.ops == []
        call_tool(ws, 'set_document_metadata', {'document': 'Doc A', 'field': 'Genre', 'value': 'narrative'})
        call_tool(ws, 'set_document_metadata', {'document': 'Doc A', 'field': 'Date', 'value': 'anything'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert (c.documents.get(s.ids['d0']).get('metadata') or {}).get('Genre') == 'narrative'
    finally:
        s.delete()


def test_entry_field_off_a_closed_lexicon_tagset_is_refused(live_client):
    c = live_client
    s, ws = _setup(c, 'field lists: entry field')
    try:
        out = call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'pos', 'value': 'ADJ'})
        assert '"ADJ" is not on the list pos is held to' in out, out
        out = call_tool(ws, 'create_entry', {'form': 'kuna', 'fields': {'pos': 'ADV'}})
        assert '"ADV" is not on the list pos is held to' in out, out
        assert ws.ops == []
        # A field set on an entry the plan creates is written onto its create, and held to the list too.
        call_tool(ws, 'create_entry', {'form': 'kuna'})
        out = call_tool(ws, 'set_entry_field', {'entry_form': 'kuna', 'field': 'pos', 'value': 'ADV'})
        assert '"ADV" is not on the list pos is held to' in out, out
        assert 'pos' not in (ws.ops[0].get('metadata') or {}), ws.ops
        call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'pos', 'value': 'V'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert (entry(c, s, 'vi-ali').get('metadata') or {}).get('pos') == 'V'
    finally:
        s.delete()


def test_an_entry_type_is_one_the_app_knows(live_client):
    c = live_client
    s, ws = _setup(c, 'field lists: type')
    try:
        out = call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'morphType', 'value': 'Suffix'})
        assert '"Suffix" is not on the list morphType is held to' in out and 'enclitic' in out, out
        out = call_tool(ws, 'create_entry', {'form': 'ra', 'fields': {'morphType': 'sufix'}})
        assert '"sufix" is not on the list morphType is held to' in out, out
        assert ws.ops == []
        call_tool(ws, 'set_entry_field', {'entry_form': 'Ali', 'field': 'morphType', 'value': 'suffix'})
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        assert (entry(c, s, 'vi-ali').get('metadata') or {}).get('morphType') == 'suffix'
    finally:
        s.delete()
