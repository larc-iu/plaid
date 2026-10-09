"""A pending plan survives an edit to a sentence it does not touch (ruling umr-assist-stale-plan).

Approval used to refuse a plan whenever its document's version had moved, and
every write in a document moves it, so fixing an attribute in sentence 2 while
reading a card about sentence 5 cost another model turn. Now the plan records a
fingerprint of each sentence its changes depend on. When the version has
moved, approval reads the document again and compares only those. A change
over the whole document (a concept-wide scope, a respelling of the text) stays
pinned to the whole document. A refused plan is settled as out of date.

The same in every assistant, so each case runs against all three apps.
"""

import copy

import pytest

import fixtures as igt_fx
import ud_fixtures as ud_fx
import umr_fixtures as umr_fx
from test_service_flow import Helper

from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.service import changed_sentences, stale_documents


def _layer(raw, layer_id):
    """The layer with this id anywhere in a document read."""
    stack = [raw]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get('id') == layer_id and ('spans' in node or 'relations' in node or 'tokens' in node):
                return node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    raise KeyError(layer_id)


def _span(raw, span_id):
    stack = [raw]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get('id') == span_id and 'tokens' in node and 'value' in node:
                return node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    raise KeyError(span_id)


# --- the three apps ---------------------------------------------------------------

def _igt():
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.service import AssistantService
    from plaid_agent.igt.tools import Workspace
    return dict(app='igt', pid=igt_fx.PID, did='d1', service=AssistantService,
                client=igt_fx.FakeClient, load=load_project, workspace=Workspace,
                # s1.w2 gam: a gloss on a word of sentence 1.
                plan=('set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss',
                                    'value': 'fish'}),
                sentence='s-1',
                other=lambda raw: _layer(raw, igt_fx.GLOSS)['spans'].append(
                    {'id': 'sp-g4', 'value': 'fish.PL', 'tokens': ['w-4']}),
                same=lambda raw: _layer(raw, igt_fx.GLOSS)['spans'].append(
                    {'id': 'sp-g3', 'value': 'see', 'tokens': ['w-3']}),
                whole=('respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'}))


def _ud():
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.service import AssistantService
    from plaid_agent.ud.tools import Workspace
    return dict(app='ud', pid=ud_fx.PID, did='ud1', service=AssistantService,
                client=ud_fx.FakeClient, load=load_project, workspace=Workspace,
                plan=('set_field', {'document': 'Viaje', 'refs': ['s2.w1'], 'field': 'lemma',
                                    'value': 'correr'}),
                sentence='us-2',
                other=lambda raw: _span(raw, 'sp-u1').update(value='AUX'),
                same=lambda raw: _layer(raw, ud_fx.LEMMA)['spans'].append(
                    {'id': 'sp-l6', 'value': '!', 'tokens': ['uw-6']}),
                # Confirm everything waiting in the document: a scope.
                whole=('confirm', {'document': 'Viaje'}))


def _umr():
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.service import AssistantService
    from plaid_agent.umr.tools import Workspace
    return dict(app='umr', pid=umr_fx.PID, did='umr1', service=AssistantService,
                client=umr_fx.FakeClient, load=load_project, workspace=Workspace,
                plan=('set_attributes', {'document': 'Story', 'sentence': 1, 'var': 's1b',
                                         'line': ':aspect state'}),
                sentence='ms-1',
                other=lambda raw: _span(raw, 'mc-r')['metadata']['umr']['attrs'].append(
                    {'rel': ':aspect', 'value': 'activity', 'order': 1}),
                same=lambda raw: _span(raw, 'mc-d')['metadata']['umr']['attrs'].append(
                    {'rel': ':polarity', 'value': '-', 'order': 1}),
                whole=('set_attribute_for_concept', {'document': 'Story', 'concept': 'bark-01',
                                                     'rel': ':aspect', 'value': 'state',
                                                     'overwrite': True}))


APPS = {'igt': _igt, 'ud': _ud, 'umr': _umr}


def _plan(spec, client, tool=None):
    """Stage one change as the model would and store the card the way a
    turn does, with an approval under way."""
    from importlib import import_module
    call_tool = import_module(f'plaid_agent.{spec["app"]}.toolkit').call_tool
    ws = spec['workspace'](client, spec['load'](client, spec['pid']))
    name, args = tool or spec['plan']
    out = call_tool(ws, name, dict(args))
    assert ws.ops, out
    plan = ws.plan_payload()
    store = ConversationStore(client, 'u@x', spec['pid'], spec['app'])
    item = assistant_item('Planned.', plan, [], [], '', 'fake/model', service=f'{spec["app"]}:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'do it'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('do it'), item]}
    sid = f'{spec["app"]}:assist:fake'
    meta = build_meta(None, 'c1', conv, sid, 'fake/model',
                      pending={'kind': 'apply', 'request_id': 'r9', 'plan_id': plan['id']})
    store.save('c1', conv, meta)
    return plan, store


def _approve(spec, client, plan):
    svc = spec['service']()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = f'{spec["app"]}:assist:fake'
    helper = Helper(request_id='r9')
    svc.process_request({'op': 'send', 'requester_client': client, 'requester_id': 'u@x',
                         'project_id': spec['pid'], 'delegated_projects': [spec['pid']], 'conversation_id': 'c1',
                         'op': 'approve', **{'plan_id': plan['id']}}, helper)
    return helper


def _edit(client, spec, change):
    raw = client._documents[spec['did']]
    change(raw)
    raw['version'] += 1


@pytest.fixture(params=sorted(APPS))
def spec(request):
    return APPS[request.param]()


def test_the_plan_records_the_sentence_its_change_depends_on(spec):
    plan, _store = _plan(spec, spec['client']())
    [doc] = plan['documents']
    assert [s['id'] for s in doc['sentences']] == [spec['sentence']]
    assert all(len(s['print']) >= 16 for s in doc['sentences'])


def test_an_edit_to_another_sentence_does_not_refuse_the_plan(spec):
    client = spec['client']()
    plan, store = _plan(spec, client)
    _edit(client, spec, spec['other'])
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'applied' and helper.done[0]['applied'] >= 1
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied' and meta['pending'] is None


def test_a_version_that_moved_over_the_same_content_does_not_refuse_the_plan(spec):
    """The fingerprint of a sentence read twice is the same: nothing the
    reader builds (a cache, an index, an object's address) gets into it."""
    client = spec['client']()
    plan, _store = _plan(spec, client)
    _edit(client, spec, lambda raw: None)
    helper = _approve(spec, client, plan)
    assert not helper.errors, helper.errors


def test_an_edit_to_the_planned_sentence_refuses_it_and_names_the_sentence(spec):
    client = spec['client']()
    plan, store = _plan(spec, client)
    before = copy.deepcopy(client._documents[spec['did']])
    _edit(client, spec, spec['same'])
    helper = _approve(spec, client, plan)
    assert len(helper.errors) == 1
    error = helper.errors[0]
    assert error.startswith('Nothing was written. Sentence ') and 'has changed since the plan was made' in error
    assert error.endswith('Ask the assistant to plan again.')
    assert helper.done == []
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'stale' and meta['pending'] is None
    assert conv['messages'][-1]['content'].startswith('(note) The plan was not applied: Sentence ')
    # Nothing the plan names was written: only the test's own edit is there.
    assert before['version'] + 1 == client._documents[spec['did']]['version']


def test_a_change_over_the_whole_document_stays_pinned_to_it(spec):
    client = spec['client']()
    plan, _store = _plan(spec, client, tool=spec['whole'])
    [doc] = plan['documents']
    assert 'sentences' not in doc
    _edit(client, spec, spec['other'])
    helper = _approve(spec, client, plan)
    assert helper.errors and 'Document "' in helper.errors[0], helper.errors


# --- the comparison itself --------------------------------------------------------

def test_changed_sentences_names_the_ones_that_differ_and_gives_up_on_a_missing_one():
    recorded = [{'id': 'a', 'print': 'p1'}, {'id': 'b', 'print': 'p2'}]
    assert changed_sentences(recorded, {'a': (1, 'p1'), 'b': (4, 'p2')}) == []
    assert changed_sentences(recorded, {'a': (1, 'p1'), 'b': (4, 'zz')}) == [4]
    assert changed_sentences(recorded, {'a': (1, 'p1')}) is None
    assert changed_sentences([{'id': 'a'}], {'a': (1, 'p1')}) is None
    assert changed_sentences(['junk'], {}) is None


class _Docs:
    def __init__(self, version):
        self.version = version

    def get(self, doc_id, **kw):
        return {'id': doc_id, 'name': 'Story', 'version': self.version}


class _Client:
    def __init__(self, version):
        self.documents = _Docs(version)


def test_stale_documents_reads_again_only_when_the_version_moved():
    record = [{'id': 'd', 'name': 'Story', 'version': 3,
               'sentences': [{'id': 'a', 'print': 'p1'}, {'id': 'b', 'print': 'p2'}]}]
    reads = []

    def reread(did):
        reads.append(did)
        return {'a': (2, 'x'), 'b': (5, 'y')}

    assert stale_documents(_Client(3), record, reread=reread) == [] and reads == []
    assert stale_documents(_Client(4), record, reread=reread) == [
        'sentences 2 and 5 of document "Story" have changed since the plan was made']
    # Without the finer check the version alone decides, as before.
    assert stale_documents(_Client(4), record) == [
        'document "Story" has changed since the plan was made']

    def broken(did):
        raise RuntimeError('boom')

    assert stale_documents(_Client(4), record, reread=broken) == [
        'document "Story" has changed since the plan was made']


def test_a_plan_reaching_too_many_sentences_is_pinned_to_the_whole_document(spec, monkeypatch):
    """Each pinned sentence is stored in the conversation, so past the cap a
    document is pinned by its version alone."""
    from plaid_agent.core import workspace
    monkeypatch.setattr(workspace, 'PIN_SENTENCES_MAX', 0)
    plan, _store = _plan(spec, spec['client']())
    [doc] = plan['documents']
    assert 'sentences' not in doc and doc['version'] is not None
