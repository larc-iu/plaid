"""The chat drafts an unattended job with the user (BRIEF-JB, 2026-11-13):
``propose_job`` stages a JOB CARD on the reply, validated at staging by
core's own rules, never beside a plan of changes; the page starts the job and
tells the service how the card ended (op ``job``), and the model hears of it
in its next turn."""

import pytest
from fixtures import FakeClient, fake_ws
from test_service_flow import Helper, _service
from test_single_writer import TAB, _req, _store

from plaid_agent.core import turn as turn_mod
from plaid_agent.core.agent import TurnResult
from plaid_agent.core.conversation import (assistant_item, build_meta, find_job_card, user_item)
from plaid_agent.core.plan import plan_line
from plaid_agent.igt.toolkit import call_tool

GLOSS = {'action': 'draft', 'documents': ['Text 1'], 'brief': 'Gloss ka as "go".'}


def _draft(ws, **args):
    return call_tool(ws, 'propose_job', {**GLOSS, **args})


# --- staging ------------------------------------------------------------------------------

def test_a_draft_stages_one_card_and_the_plan_line_says_so():
    ws = fake_ws(FakeClient())
    out = _draft(ws, brief='  Gloss ka as "go".  ')
    assert out.startswith('Drafted the job card.'), out
    card = ws.job_card
    assert card['documents'] == [{'id': 'd1', 'name': 'Text 1'}] and card['count'] == 1 and not card['all']
    assert 'tasks' not in card and card['brief'] == 'Gloss ka as "go".'
    assert len(card['id']) == 36 and card['id'][14] == '7'
    assert plan_line(ws) == '[Plan of this turn: a job card, 1 document.]'
    assert not ws.ops
    assert call_tool(ws, 'plan_status', {}).startswith('This turn drafted a job card (1 document) '
                                                       'and plans no changes beside it.')


def test_all_documents_are_counted_and_not_listed():
    ws = fake_ws(FakeClient())
    _draft(ws, documents=['all'])
    assert ws.job_card['all'] is True and ws.job_card['count'] == 1 and 'documents' not in ws.job_card
    assert plan_line(ws) == '[Plan of this turn: a job card, all 1 document.]'


def test_a_second_draft_in_the_turn_replaces_the_first():
    ws = fake_ws(FakeClient())
    _draft(ws)
    first = ws.job_card['id']
    out = _draft(ws, brief='Leave loanwords.')
    assert 'in place of the one drafted earlier in this turn' in out
    assert ws.job_card['brief'] == 'Leave loanwords.' and ws.job_card['id'] != first


def test_what_the_tool_tells_the_model_has_no_semicolon_or_em_dash():
    """REV-JB-6: the help, the refusals and the result, as the no-semicolons
    rule asks of model-facing text."""
    from plaid_agent.igt import jobcard
    from plaid_agent.igt.toolkit import TOOLS
    schema = str(next(t for t in TOOLS if t['function']['name'] == 'propose_job'))
    texts = [call_tool(fake_ws(FakeClient()), 'propose_job', {'action': 'help'}), schema,
             jobcard.READER_REFUSAL, _draft(fake_ws(FakeClient()))]
    for text in texts:
        assert ';' not in text and '\u2014' not in text, text


def test_help_reads_the_limits_core_publishes():
    client = FakeClient()
    ws = fake_ws(client)
    ws.job_facts = lambda: {'instructions_max_chars': 1234, 'documents_max': 7}
    text = call_tool(ws, 'propose_job', {'action': 'help'})
    assert 'At most 1,234 characters.' in text and 'at most 7' in text
    assert ws.job_card is None


@pytest.mark.parametrize('args, said', [
    ({'documents': None}, 'Name the documents, or ["all"]'),
    ({'documents': ['Text 9']}, 'Text 9'),
    ({'brief': '   '}, 'Write the brief'),
    ({'action': 'start'}, 'action is help or draft'),
])
def test_each_refusal_says_what_to_change(args, said):
    ws = fake_ws(FakeClient())
    out = _draft(ws, **args)
    assert out.startswith('Error') and said in out, out
    assert ws.job_card is None


def test_the_limits_are_core_s_as_published():
    ws = fake_ws(FakeClient())
    ws.job_facts = lambda: {'instructions_max_chars': 10, 'documents_max': 0}
    out = _draft(ws, brief='x' * 11)
    assert 'The brief is 11 characters, and a job\'s brief is at most 10.' in out
    ws.job_facts = lambda: {'instructions_max_chars': 2000, 'documents_max': 1}
    assert _draft(ws).startswith('Drafted')
    ws.job_card = None
    ws.documents = lambda: [{'id': 'd1', 'name': 'Text 1'}, {'id': 'd2', 'name': 'Text 2'}]
    out = _draft(ws, documents=['all'])
    assert 'A job takes at most 1 documents, and this names 2.' in out, out


def test_unreadable_limits_leave_them_to_core():
    ws = fake_ws(FakeClient())

    def fails():
        raise RuntimeError('403')
    ws.job_facts = fails
    assert _draft(ws, brief='x' * 5000).startswith('Drafted')


def test_a_card_has_no_task_types():
    """The owner's ruling 11: a job is its documents and its brief. A tasks
    argument is not one propose_job takes."""
    ws = fake_ws(FakeClient())
    out = _draft(ws, tasks=['gloss'])
    assert out.startswith('Error') and 'It takes: action, documents, brief.' in out, out
    from plaid_agent.igt.toolkit import TOOLS
    schema = next(t for t in TOOLS if t['function']['name'] == 'propose_job')
    assert 'tasks' not in schema['function']['parameters']['properties']


def test_an_active_job_is_named_with_a_link_to_its_page():
    client = FakeClient()
    job = client.jobs.create('p1', 'igt', 'Gloss the words.')
    ws = fake_ws(client)
    out = _draft(ws)
    assert 'This project already has a job, waiting to start' in out
    assert f'[the job](#/projects/p1/jobs/{job["id"]})' in out
    assert ws.job_card is None


def test_another_projects_workspace_drafts_nothing():
    ws = fake_ws(FakeClient())
    ws.writable = False
    assert _draft(ws).startswith('Error') and ws.job_card is None


# --- a plan or a card, never both: the first staged stands ----------------------------------

def test_a_reader_is_refused_at_staging_with_the_line_the_card_says():
    """The owner's ruling (REV-JB question 3): a reader's card is a dead end,
    so staging refuses it, by the page's own rule (canStartJob: a writer, a
    maintainer or an administrator, from the project's lists as core gives
    them)."""
    from fixtures import project_raw
    for role, admin, may in ((None, False, False), ('readers', False, False), ('writers', False, True),
                             ('maintainers', False, True), (None, True, True)):
        raw = project_raw()
        if role:
            raw[role] = ['u@x']
        ws = fake_ws(FakeClient(project=raw))
        ws.requester_id = 'u@x'
        ws.requester_is_admin = lambda admin=admin: admin
        out = _draft(ws)
        assert out.startswith('Drafted the job card.') == may, (role, admin, out)
        if not may:
            assert 'Starting a job needs write access.' in out and ws.job_card is None


def test_a_turn_that_read_the_web_drafts_no_card_as_it_plans_no_change():
    """REV-JB-3: the web-read refusal add_op owes a plan, asked of a draft by
    the same function."""
    from types import SimpleNamespace

    from plaid_agent.core.workspace import WEB_READ_REFUSAL
    for read in ({'read_untrusted': True}, {'web': SimpleNamespace(read=True)}):
        ws = fake_ws(FakeClient())
        for k, v in read.items():
            setattr(ws, k, v)
        assert WEB_READ_REFUSAL in _draft(ws), read
        assert ws.job_card is None
        planned = call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'gloss', 'value': 'go'})
        assert WEB_READ_REFUSAL in planned


def test_a_card_is_refused_in_a_turn_that_planned_changes():
    ws = fake_ws(FakeClient())
    call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    out = _draft(ws)
    assert 'This turn planned 1 change, and a turn holds a plan or a job card, not both.' in out
    assert 'discard_plan first' in out and ws.job_card is None and ws.ops


def test_changes_are_refused_once_a_card_is_staged_by_every_route():
    ws = fake_ws(FakeClient())
    _draft(ws)
    one = call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    many = call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss',
                                       'value': 'X'})
    rule = call_tool(ws, 'set_field_for_form', {'form': 'gam', 'field': 'Gloss', 'value': 'X'})
    guideline = call_tool(ws, 'guidelines', {'action': 'add', 'title': 'Ka', 'body': 'Gloss ka as go.'})
    for out in (one, many, rule, guideline):
        assert 'This turn staged a job card, and a turn holds a job card or changes, not both.' in out, out
    assert not ws.ops and ws.job_card is not None


def test_discard_plan_takes_the_card_back_so_changes_can_be_planned():
    ws = fake_ws(FakeClient())
    _draft(ws)
    assert call_tool(ws, 'discard_plan', {}).startswith('Discarded the job card.')
    assert ws.job_card is None
    out = call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    assert not out.startswith('Error') and plan_line(ws) == '[Plan of this turn: 1 change.]'


# --- the turn carries the card, and a newer card replaces a waiting one -------------------------

def _drafting_turn(monkeypatch, args=None, text='Here is the job.'):
    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        said = kit.call_tool(ws, 'propose_job', {**GLOSS, **(args or {})})
        assert said.startswith('Drafted'), said
        return TurnResult(text, [{'role': 'assistant', 'content': text}], [])
    monkeypatch.setattr(turn_mod, 'run_turn', fake_run_turn)


def _send(svc, client, rid, text='Draft a glossing job.', create=False):
    helper = Helper(request_id=rid)
    svc.process_request(_req(client, 'send', text=text, create=create), helper)
    assert not helper.errors, helper.errors
    return helper


def _writer_client():
    """The fake core, with the user the turns act for (u@x) a writer of the
    project, as a user who may start a job is."""
    from fixtures import project_raw
    return FakeClient(project={**project_raw(), 'writers': ['u@x']})


def _card_turn(monkeypatch, client, svc=None, rid='r1', create=True, **args):
    svc = svc or _service()
    _drafting_turn(monkeypatch, args)
    _send(svc, client, rid, create=create)
    conv, _meta = _store(client).load('c1')
    return svc, conv


def test_the_reply_carries_the_card_waiting(monkeypatch):
    client = _writer_client()
    _svc, conv = _card_turn(monkeypatch, client)
    reply = conv['display'][-1]
    assert reply['plan'] is None and reply['job']['status'] is None
    assert 'tasks' not in reply['job'] and reply['job']['documents'] == [{'id': 'd1', 'name': 'Text 1'}]


def test_the_service_reads_cores_limits_with_its_own_client(monkeypatch):
    client = _writer_client()
    svc = _service()
    svc.client = client
    _card_turn(monkeypatch, client, svc=svc)
    assert ('worker', {}) in client.jobs.calls


def test_a_newer_card_replaces_one_still_waiting(monkeypatch):
    client = _writer_client()
    svc, conv = _card_turn(monkeypatch, client)
    first = conv['display'][-1]['job']['id']
    _svc, conv = _card_turn(monkeypatch, client, svc=svc, rid='r2', create=False, brief='Leave loanwords.')
    _, old = find_job_card(conv, first)
    assert old['job']['status'] == 'replaced' and old['job']['settled_at']
    assert conv['display'][-1]['job']['status'] is None


# --- how a card ends: op job ------------------------------------------------------------------

def _seed_card(client, brief='Gloss ka as "go".'):
    store = _store(client)
    card = {'id': '0190f000-0000-7000-8000-000000000001', 'all': False, 'count': 1,
            'documents': [{'id': 'd1', 'name': 'Text 1'}], 'brief': brief,
            'summary': '1 document', 'status': None}
    item = assistant_item('Here is the job.', None, [], [], '', 'fake/model', service='igt:assist:fake')
    item['job'] = card
    conv = {'messages': [{'role': 'user', 'content': 'job'}, {'role': 'assistant', 'content': 'Here is the job.'}],
            'display': [user_item('job'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model'))
    return card['id']


def _settle(client, card_id, rid='r5', tab=TAB, **fields):
    helper = Helper(request_id=rid)
    _service().process_request(_req(client, 'job', tab=tab, card_id=card_id, **fields), helper)
    conv, meta = _store(client).load('c1')
    return helper, conv, meta


def test_a_start_is_read_back_from_core_with_the_brief_as_sent():
    client = FakeClient()
    card_id = _seed_card(client)
    client.jobs.create('p1', 'igt', 'Gloss ka as "go".', ['d1'], id=card_id)
    helper, conv, meta = _settle(client, card_id, outcome='started')
    assert helper.done[0]['kind'] == 'done' and not helper.errors
    card = conv['display'][-1]['job']
    assert card['status'] == 'started' and card['job_id'] == card_id and card['sent_brief'] == 'Gloss ka as "go".'
    assert conv['messages'][-1] == {'role': 'user', 'content': '(note) The user started the job with the brief as '
                                                                'drafted.'}
    assert meta['holder']['tab'] == TAB


def test_an_edited_brief_is_what_the_model_hears():
    client = FakeClient()
    card_id = _seed_card(client)
    client.jobs.create('p1', 'igt', 'Gloss ka as "come".', ['d1'], id=card_id)
    _helper, conv, _meta = _settle(client, card_id, outcome='started')
    assert conv['display'][-1]['job']['sent_brief'] == 'Gloss ka as "come".'
    assert conv['messages'][-1]['content'] == ('(note) The user changed the brief and started the job. The brief '
                                               'as sent:\nGloss ka as "come".')


def test_a_settled_card_keeps_five_names_and_its_count():
    """REV-JB-8: as a settled plan drops its documents, a settled card keeps
    the names it shows (five) and the count, ended or replaced."""
    from plaid_agent.core.conversation import job_card_settling, replace_undecided_cards
    docs = [{'id': f'd{i}', 'name': f'Text {i}'} for i in range(1, 13)]
    item = {'kind': 'assistant', 'job': {'id': 'c', 'all': False, 'count': 12, 'documents': docs, 'status': None}}
    stored = {'messages': [], 'display': [item]}
    for card in (job_card_settling('c', 'discarded')(stored)['display'][0]['job'],
                 replace_undecided_cards([item])[0]['job']):
        assert card['documents'] == docs[:5] and card['count'] == 12, card


def test_a_start_core_does_not_hold_is_not_recorded():
    client = FakeClient()
    card_id = _seed_card(client)
    helper, conv, _meta = _settle(client, card_id, outcome='started')
    assert helper.errors and conv['display'][-1]['job']['status'] is None
    assert conv['messages'][-1]['role'] == 'assistant'


def test_a_discard_and_a_failure_are_recorded_with_their_notes():
    client = FakeClient()
    card_id = _seed_card(client)
    _helper, conv, _meta = _settle(client, card_id, outcome='discarded')
    assert conv['display'][-1]['job']['status'] == 'discarded'
    assert conv['messages'][-1]['content'] == '(note) The user discarded the job card. No job was started.'

    client = FakeClient()
    card_id = _seed_card(client)
    _helper, conv, _meta = _settle(client, card_id, outcome='failed', reason='This project already has a job.',
                                   active_job='j-1')
    card = conv['display'][-1]['job']
    assert card['status'] == 'failed' and card['reason'] == 'This project already has a job.'
    assert card['active_job'] == 'j-1'
    assert conv['messages'][-1]['content'] == '(note) The job did not start: This project already has a job.'


def test_a_card_whose_job_core_holds_is_recorded_started_whatever_the_page_says():
    """REV-JB-1: a press after a reload (or after the first start went
    unrecorded) is refused job-active naming the card's own job, or the page
    says discarded. Core holds the job under the card's id, so it started."""
    for fields in ({'outcome': 'failed', 'reason': 'This project already has a job.',
                    'active_job': '0190f000-0000-7000-8000-000000000001'},
                   {'outcome': 'failed', 'reason': 'This project has no documents.'},
                   {'outcome': 'discarded'}):
        client = FakeClient()
        card_id = _seed_card(client)
        client.jobs.create('p1', 'igt', 'Gloss ka as "go".', ['d1'], id=card_id)
        helper, conv, _meta = _settle(client, card_id, **fields)
        card = conv['display'][-1]['job']
        assert not helper.errors and card['status'] == 'started', fields
        assert card['job_id'] == card_id and 'reason' not in card and 'active_job' not in card
        assert conv['messages'][-1]['content'] == '(note) The user started the job with the brief as drafted.'


def test_a_card_whose_job_already_ended_is_recorded_started():
    """The first press made the job and it ended before the second press,
    whose create core answers id-taken: the card started (and its job ended),
    and no second job is made."""
    client = FakeClient()
    card_id = _seed_card(client)
    client.jobs.create('p1', 'igt', 'Gloss ka as "go".', ['d1'], id=card_id)
    client.jobs.cancel(card_id)
    assert client.jobs.get(card_id)['state'] == 'cancelled'
    _helper, conv, _meta = _settle(client, card_id, outcome='started')
    assert conv['display'][-1]['job']['status'] == 'started'
    assert [j['id'] for j in client.jobs.list('p1')] == [card_id]


def test_a_card_whose_job_cannot_be_read_waits():
    client = FakeClient()
    card_id = _seed_card(client)

    def down(job_id):
        raise ConnectionError('no answer')
    client.jobs.get = down
    helper, conv, _meta = _settle(client, card_id, outcome='failed', reason='x')
    assert helper.errors and conv['display'][-1]['job']['status'] is None


def test_an_ended_card_answers_done_again_and_refuses_another_end():
    client = FakeClient()
    card_id = _seed_card(client)
    _settle(client, card_id, outcome='discarded')
    helper, conv, _meta = _settle(client, card_id, rid='r6', outcome='discarded')
    assert helper.done[0]['kind'] == 'done'
    assert sum(1 for m in conv['messages'] if 'discarded the job card' in str(m.get('content'))) == 1
    helper, conv, _meta = _settle(client, card_id, rid='r7', outcome='failed', reason='x')
    assert helper.done[0] == {'kind': 'refused', 'why': 'decided', 'message': 'This job card was already decided.',
                              'meta': helper.done[0]['meta']}
    assert conv['display'][-1]['job']['status'] == 'discarded'


def test_another_tab_holding_the_conversation_is_refused():
    client = FakeClient()
    card_id = _seed_card(client)
    store = _store(client)
    conv, meta = store.load('c1')
    from plaid_agent.core.conversation import now_iso
    store.save('c1', conv, {**meta, 'holder': {'tab': 'tab-b', 'at': now_iso()}})
    helper, conv, _meta = _settle(client, card_id, outcome='discarded')
    assert helper.done[0]['why'] == 'held' and conv['display'][-1]['job']['status'] is None


def test_an_unknown_card_or_outcome_is_an_error():
    client = FakeClient()
    _seed_card(client)
    helper, _conv, _meta = _settle(client, 'nope', outcome='discarded')
    assert helper.errors == ['No such job card in this conversation']
    helper, _conv, _meta = _settle(client, 'nope', outcome='approved')
    assert helper.errors == ['Unknown outcome: approved']


# --- the turn's own account of the draft --------------------------------------------------

def test_the_step_says_a_job_was_drafted_and_the_result_ends_with_the_card_line(monkeypatch):
    from test_nothing_planned import APPS, _reply, _run
    ws, kit, _plan, _read = APPS['igt']()
    out, _sent = _run(monkeypatch, ws, kit, [_reply(('propose_job', GLOSS)), _reply(text='Here is the job.')])
    (step,) = out.steps
    assert step['label'] == 'Drafted a job', step
    (result,) = [m['content'] for m in out.messages if m.get('role') == 'tool']
    assert result.endswith('\n[Plan of this turn: a job card, 1 document.]'), result
