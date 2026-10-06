"""The research extractor against a database a real core wrote.

Every fate a machine write can meet is made here through the real API: a
service run, an approved assistant plan (with its reference, and one from
before references, found by its label), an adopted guess and an untagged
machine run, then edits, reviews, reshapes and deletes by a person, by the
requester, by another run. The conversation records are built with the
service's own functions (`plaid_agent.core.conversation`, `core.trace`) and
stored through the client, so the store holds them exactly as it holds a
real one. The extractor then reads the core's database file read-only.

Needs a core at PLAID_TEST_URL (dev account) and its database file at
PLAID_TEST_DB, else skipped (PLAID_AGENT_REQUIRE_LIVE makes that a failure).
"""

import json
import os
import uuid
from pathlib import Path

import pytest

from live import URL, _skip_or_fail, login, reachable

DB = os.environ.get('PLAID_TEST_DB')


@pytest.fixture(scope='module')
def world(tmp_path_factory):
    if not DB or not Path(DB).is_file():
        _skip_or_fail('PLAID_TEST_DB does not name the database file of the core under test')
    if not reachable():
        _skip_or_fail(f'no Plaid server at {URL}')
    from plaid_client import PlaidClient
    from plaid_client.ids import uuid7
    from plaid_client.provenance import confirmed_inferred, stamp_inferred as inferred
    from plaid_agent.core.conversation import (assistant_item, conv_key, error_item, meta_key, build_meta,
                                               proposed_changes, replace_undecided, settle_plan, DROPPED)
    from plaid_agent.core.trace import tracer_for, trace_step
    from plaid_agent.research.records import proposed_keys

    admin = login()
    me = admin.users.get('a@b.com')['id']
    other_email = f'r1-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(other_email, 'r1-password-1', False)
    other = PlaidClient.login(URL, other_email, 'r1-password-1')

    pid = admin.projects.create(f'R1 extract {uuid.uuid4().hex[:6]}')['id']
    admin.projects.add_writer(pid, other_email)
    admin.projects.set_config(pid, 'plaid', 'research', {'telemetry': True})
    tl = admin.text_layers.create(pid, 'Text')['id']
    words = admin.token_layers.create(tl, 'Word')['id']
    gloss = admin.span_layers.create(words, 'Gloss')['id']
    doc = admin.documents.create(pid, 'Doc')['id']
    body = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn'
    text = admin.texts.create(tl, doc, body)['id']
    toks = []
    for i in range(len(body.split())):
        toks.append(admin.tokens.create(words, text, i * 3, i * 3 + 2)['id'])

    service = 'igt:assist:stub-model'
    source = f'service:{service}'
    detail = {'model': 'stub-model', 'version': '0.0.0+feedface'}
    conv_id = str(uuid.uuid4())
    ids = {}

    # A service run: machine glosses on words 0 to 4, and it deletes a
    # human gloss on word 13 (made first).
    human = admin.spans.create(gloss, [toks[13]], 'HUMAN')['id']
    with admin.operation('Run stub', kind='service-run', ref='service:stub-svc'):
        for i in range(5):
            ids[f'm{i}'] = admin.spans.create(gloss, [toks[i]], f'm{i}',
                                              metadata=inferred('service:stub-svc'))['id']
        admin.spans.delete(human)
    ids['run_deleted'] = human

    # An approved plan with its reference: glosses on words 5 to 10.
    plan_id = uuid7()
    ops = [{'kind': 'set_span', 'token_id': toks[i], 'value': f'a{i}', 'label': f'gloss w{i}'}
           for i in range(5, 11)]
    with admin.operation('Assistant: gloss 6 words', kind='assistant-plan',
                         ref=f'conv:{conv_id}/plan:{plan_id}/{source}'):
        for i in range(5, 11):
            ids[f'a{i}'] = admin.spans.create(gloss, [toks[i]], f'a{i}',
                                              metadata=confirmed_inferred(source, detail=detail))['id']

    # A plan from before references: an untagged operation with the label.
    legacy_id = str(uuid.uuid4())
    legacy_ops = [{'kind': 'set_span', 'token_id': toks[11], 'value': 'L', 'label': 'gloss w11'}]
    with admin.operation('Assistant: gloss 1 word'):
        ids['legacy'] = admin.spans.create(gloss, [toks[11]], 'L',
                                           metadata=confirmed_inferred(source, detail=detail))['id']

    # A guess adopted, and an untagged machine run (before kinds).
    with other.operation('Take guess', kind='guess-adoption'):
        ids['adopted'] = other.spans.create(gloss, [toks[12]], 'G', metadata=confirmed_inferred('rule:x'))['id']
    with admin.operation('Old run'):
        ids['untagged'] = admin.spans.create(gloss, [toks[12]], 'U', metadata=inferred('service:old-svc'))['id']

    # What happened afterwards.
    other.spans.update(ids['a5'], 'fixed')                       # edited by a person
    with admin.operation('Run again', kind='service-run', ref='service:stub-svc'):
        admin.spans.update(ids['a6'], 'redo')                    # edited by a machine
        admin.spans.delete(ids['a8'])                            # deleted by a machine
    other.spans.delete(ids['a7'])                                # deleted by a person
    admin.spans.update(ids['a9'], 'mine')                        # edited by the requester
    # a10 is left alone: unchanged.
    other.spans.set_metadata(ids['m0'], confirmed_inferred('service:stub-svc'))   # reviewed
    other.spans.set_tokens(ids['m1'], [toks[13]])                # reshaped
    other.spans.update(ids['adopted'], 'G2')                     # an adopted guess corrected
    other.spans.delete(ids['untagged'])                          # an untagged run's output removed

    # The conversation, written with the service's own functions.
    tracer = tracer_for((), {'set_field'}, lambda n, a: n, {})
    keys = proposed_keys('igt')

    def plan_payload(pid_, ops_, summary='gloss'):
        return {'id': pid_, 'summary': summary, 'labels': [o['label'] for o in ops_], 'ops': ops_,
                'changes': [], 'documents': [{'id': doc, 'name': 'Doc', 'version': 1}]}

    def with_proposed(p):
        p['proposed'], p['proposed_count'] = proposed_changes(p['ops'], *keys)
        return p

    def item(plan=None, steps=(), text='ok', version='0.0.0+feedface'):
        it = assistant_item(text, plan, [], list(steps), '', 'stub-model', {'sent': 10, 'received': 5},
                            version=version, service=service)
        it['elapsed_ms'] = 1200
        return it

    steps1 = [trace_step(tracer, 'c1', 'query', {}, failed=True),
              trace_step(tracer, 'c2', 'query', {}),
              trace_step(tracer, 'c3', 'search', {}, failed=True),
              trace_step(tracer, 'c4', 'set_field', {}, planned=6)]
    messages = [{'role': 'user', 'content': 'q1'},
                {'role': 'assistant', 'content': '', 'tool_calls': []},
                {'role': 'tool', 'tool_call_id': 'c1',
                 'content': 'Error: Query rejected: HTTP 400 :find must be a list of vars'},
                {'role': 'tool', 'tool_call_id': 'c2', 'content': '3 rows'},
                {'role': 'tool', 'tool_call_id': 'c3', 'content': DROPPED},
                {'role': 'tool', 'tool_call_id': 'c4', 'content': 'Planned.'}]
    conv = {'messages': messages, 'display': [
        {'kind': 'user', 'text': 'please gloss', 'where': {'kind': 'document', 'id': doc, 'name': 'Doc'}},
        item(with_proposed(plan_payload(plan_id, ops)), steps1),
        {'kind': 'user', 'text': 'and the legacy one'},
        # A plan from an older service: a UUIDv4 id, no `proposed`, no service.
        {**assistant_item('ok', plan_payload(legacy_id, legacy_ops, 'gloss 1 word'), [], [], '', 'stub-model'),
         'status': 'applied', 'as_human': False},
        {'kind': 'user', 'text': 'discard me'},
        item(with_proposed(plan_payload(uuid7(), ops[:2]))),
        {'kind': 'user', 'text': 'stale'},
        item(with_proposed(plan_payload(uuid7(), ops[:1]))),
        {'kind': 'user', 'text': 'partial'},
        item(with_proposed(plan_payload(uuid7(), ops[:2]))),
        {'kind': 'user', 'text': 'replaced'},
        item(with_proposed(plan_payload(uuid7(), ops[:3]))),
        {'kind': 'user', 'text': 'stop'},
        error_item('Stopped.', stopped=True, model='stub-model', service=service),
        {'kind': 'user', 'text': 'fail'},
        error_item('The model did not answer.', model='stub-model', service=service),
        {'kind': 'user', 'text': 'loop'},
        item(None, [trace_step(tracer, 'c5', 'lexicon_entry', {}, failed=True)] * 3,
             text='Found some.\n\n*(Stopped after the same step failed 3 times.)*'),
        {'kind': 'user', 'text': 'newest'},
    ]}
    conv = settle_plan(conv, 1, 'applied', '(note) applied', as_human=False)
    conv = settle_plan(conv, 5, 'discarded', '(note) discarded')
    conv = settle_plan(conv, 7, 'stale', '(note) stale')
    conv = settle_plan(conv, 9, 'partial', '(note) partial', written=[0], outcome='1 of 2 changes written.')
    newest = item(with_proposed(plan_payload(uuid7(), ops[:1])))
    conv = {'messages': conv['messages'], 'display': replace_undecided(conv['display']) + [newest]}
    meta = build_meta(None, conv_id, conv, service, 'stub-model', version='0.0.0+feedface')
    admin.user_data.put(me, conv_key('igt', pid, conv_id), conv)
    admin.user_data.put(me, meta_key('igt', pid, conv_id), meta)

    admin.events.create(pid, [{'type': 'plan.opened', 'data': {'conversation': conv_id}},
                              {'type': 'suggestion.adopted', 'document_id': doc, 'target_id': toks[12],
                               'data': {'value': 'a very long suggested value indeed', 'source': f'user:{me}',
                                        'field': 'gloss'}}])

    from plaid_agent.research.extract import extract
    root = tmp_path_factory.mktemp('r1')
    out = root / 'out'
    manifest = extract(DB, out, root / 'salt', projects=[pid], quiet=True)

    def rows(name):
        return [json.loads(line) for line in (out / name).read_text().splitlines() if line.strip()]

    # An entity a later run rewrote has a row for each run: keep the first.
    writes = {}
    for w in rows('writes.jsonl'):
        writes.setdefault(w['target_id'], w)
    return {'out': out, 'root': root, 'manifest': manifest, 'rows': rows, 'ids': ids, 'writes': writes,
            'plan_id': plan_id, 'legacy_id': legacy_id, 'emails': [me, other_email], 'pid': pid}


def test_plans_and_their_statuses(world):
    plans = world['rows']('plans.jsonl')
    by_status = sorted(p['status'] for p in plans)
    assert by_status == ['applied', 'applied', 'discarded', 'partial', 'replaced', 'stale', 'undecided']
    tagged = next(p for p in plans if p['plan_id'] == world['plan_id'])
    assert tagged['group_link'] == 'ref' and tagged['proposed_count'] == 6 and tagged['proposed_source'] == 'record'
    assert tagged['proposed_at'] and tagged['settled_at_source'] == 'record'
    assert tagged['seconds_to_settle'] is not None and tagged['seconds_to_settle'] >= 0
    assert tagged['model'] == 'stub-model' and tagged['service'] == 'igt:assist:stub-model'
    legacy = next(p for p in plans if p['plan_id'] == world['legacy_id'])
    assert legacy['group_link'] == 'label' and legacy['proposed_source'] == 'derived_from_ops'
    assert legacy['proposed_at'] is None and legacy['settled_at_source'] == 'audit_group_start'
    partial = next(p for p in plans if p['status'] == 'partial')
    assert partial['partly_applied'] and partial['rows_written'] == 1
    assert world['manifest']['linking']['applied_unlinked'] == 1  # the partial plan wrote nothing here


def test_every_fate(world):
    w, ids = world['writes'], world['ids']
    fate = {k: w[ids[k]]['fate'] for k in ids if ids[k] in w}
    assert fate['a5'] == 'edited_by_person'
    assert w[ids['a5']]['first_edit']['value_after'] == 'fixed'
    assert w[ids['a5']]['first_edit']['by_requester'] is False
    assert fate['a6'] == 'edited_by_machine'
    assert fate['a7'] == 'deleted_by_person'
    assert fate['a8'] == 'deleted_by_machine'
    assert fate['a9'] == 'edited_by_person' and w[ids['a9']]['first_edit']['by_requester'] is True
    assert fate['a10'] == 'unchanged' and w[ids['a10']]['final_value_same'] is True
    assert fate['m0'] == 'reviewed_by_person' and w[ids['m0']]['first_review']['prov_after'] == 'verified'
    assert w[ids['m0']]['prov_written'] == 'machine'
    assert fate['m1'] == 'reshaped'
    assert fate['m2'] == 'unchanged'
    assert fate['run_deleted'] == 'deleted_by_run'
    assert fate['adopted'] == 'edited_by_person' and w[ids['adopted']]['unit_kind'] == 'guess-adoption'
    assert fate['untagged'] == 'deleted_by_person' and w[ids['untagged']]['unit_kind'] == 'untagged-machine'
    assert fate['legacy'] == 'unchanged' and w[ids['legacy']]['legacy'] is True
    for k in ('a5', 'a7'):
        ev = w[ids[k]]['first_event']
        assert ev['after_s'] >= 0 and ev['actor'].startswith('u-')


def test_plan_changes_follow_their_writes(world):
    changes = [c for c in world['rows']('plan_changes.jsonl') if c['plan_id'] == world['plan_id']]
    assert len(changes) == 6 and all(c['target_written'] for c in changes)
    assert sorted(c['fate'] for c in changes) == sorted(
        ['edited_by_person', 'edited_by_machine', 'deleted_by_person', 'deleted_by_machine',
         'edited_by_person', 'unchanged'])


def test_tool_use(world):
    calls = world['rows']('tool_calls.jsonl')
    q = [c for c in calls if c['tool'] == 'query']
    assert [c['failed'] for c in q] == [True, False]
    assert q[0]['error_class'] == 'query_rejected' and q[0]['recovered_in_turn'] is True
    s = next(c for c in calls if c['tool'] == 'search')
    assert s['failed'] and s['error_class'] == 'unknown' and not s['result_kept']
    ends = sorted(t['end'] for t in world['rows']('turns.jsonl'))
    assert ends.count('stopped') == 1 and ends.count('failed') == 1 and ends.count('stopped_repeat') == 1
    inv = json.loads((world['out'] / 'tool_inventory.json').read_text())
    assert 'set_analysis' in inv['never_used']['igt'] and 'query' not in inv['never_used']['igt']


def test_telemetry_is_pseudonymized_and_clipped(world):
    ev = world['rows']('telemetry.jsonl')
    assert sorted(e['type'] for e in ev) == ['plan.opened', 'suggestion.adopted']
    adopted = next(e for e in ev if e['type'] == 'suggestion.adopted')
    assert len(adopted['data']['value']) == 24 and adopted['data']['source'].startswith('user:u-')


def test_nobody_is_named(world):
    out = world['out']
    for f in out.iterdir():
        text = f.read_text(encoding='utf-8')
        for email in world['emails']:
            assert email not in text, f'{f.name} names a user'
        for word in ('please gloss', 'discard me', 'Query rejected', 'Found some'):
            assert word not in text, f'{f.name} holds conversation text'
    assert not (out / 'PRIVATE_text.jsonl').exists()
    assert (out / 'README.md').read_text().startswith('#')


def test_pseudonyms_are_stable_and_the_salt_stays_outside(world):
    from plaid_agent.research.extract import extract
    again = world['root'] / 'again'
    extract(DB, again, world['root'] / 'salt', projects=[world['pid']], quiet=True)
    users = lambda d: sorted({json.loads(line)['user'] for line in (d / 'plans.jsonl').read_text().splitlines()})
    assert users(again) == users(world['out'])
    with pytest.raises(SystemExit):
        extract(DB, again, again / 'salt', projects=[world['pid']], quiet=True)


def test_include_text_is_opt_in_and_separate(world):
    from plaid_agent.research.extract import extract
    out = world['root'] / 'text'
    m = extract(DB, out, world['root'] / 'salt', projects=[world['pid']], include_text=True, quiet=True)
    assert m['private_text_file'] == 'PRIVATE_text.jsonl'
    text = (out / 'PRIVATE_text.jsonl').read_text()
    assert 'please gloss' in text and 'Query rejected' in text
    assert 'please gloss' not in (out / 'turns.jsonl').read_text()
