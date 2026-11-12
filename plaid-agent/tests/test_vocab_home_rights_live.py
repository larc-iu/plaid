"""Section 1 of the vocabulary home spec over a real core, as the assistant
meets it: every lexicon tool, for each column (a maintainer, writer and reader
of the lexicon's home project, of a project borrowing it, and an
administrator), staged as that user and, where the assistant plans it, applied
under a DELEGATED token for that user, as an approval writes it (the
plaid_agent_package lesson H9-ACL-1: a plain login misses core's delegated-token
refusals). Where the assistant refuses, the user's own login is refused the
same write by core, so the assistant is never the stricter of the two, apart
from one choice: a borrowed lexicon is read only here for everyone (the
assistant never reads another project's roles). The same table on the fake
client: test_vocab_home_rights.py."""

import json
import threading
import uuid

import pytest
import requests
from fixtures import document_raw, lexicon_raw, project_raw, VOCAB
from live import _Session, live_client, seed  # noqa: F401 - fixture
from test_tagset_tools import _user

from plaid_client import PlaidAPIError, PlaidClient
from plaid_agent.core.plan import PlanOutOfDate
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

USERS = {'HM': 'vh-agent-hm@x.org', 'HW': 'vh-agent-hw@x.org', 'HR': 'vh-agent-hr@x.org',
         'BM': 'vh-agent-bm@x.org', 'BW': 'vh-agent-bw@x.org', 'BR': 'vh-agent-br@x.org'}
ROLE = {'M': 'add_maintainer', 'W': 'add_writer', 'R': 'add_reader'}
HOME, BORROWER = 'igt-agent vocab home H', 'igt-agent vocab home B'

# In the order they are applied, each over what the ones before it left.
WRITER_CALLS = [
    ('set_entry_field', {'entry_form': 'Ali', 'field': 'gloss', 'value': 'Ally'}),
    ('create_entry', {'form': 'kai', 'fields': {'gloss': 'go'}, 'type': 'suffix'}),
    ('senses', {'action': 'add', 'entry_form': 'Ali', 'fields': {'gloss': 'name'}}),
]
LINK_CALL = ('link_entry', {'document': 'Text 1', 'refs': ['s1.w3'], 'entry_form': 'gam', 'entry_gloss': 'net'})
MAINTAINER_CALLS = [
    ('merge_entries', {'keep_form': 'gam', 'keep_gloss': 'fish', 'remove_form': 'gam', 'remove_gloss': 'net'}),
    ('rename_entry', {'entry_form': 'Ali', 'new_form': 'Aly'}),
    ('delete_entry', {'entry_form': '-di'}),
]


def _maintainer(project):
    return (f'Only a maintainer of "{project}" can rename, merge, delete or restore entries of the lexicon '
            '"Lexicon", and the person you are acting for is not one.')


def _reader(project):
    return f'Only a writer or maintainer of "{project}" can change the lexicon "Lexicon", and the person you are acting for is a reader.'


BORROWED = 'The lexicon "Lexicon" belongs to another project and is read only here'

# Column: (where they work, what a maintainer act gets, a writer act, whether a link is planned).
TABLE = {
    'HM': ('H', None, None, True),
    'HW': ('H', _maintainer(HOME), None, True),
    'HR': ('H', _maintainer(HOME), _reader(HOME), False),
    'BM': ('B', BORROWED, BORROWED, True),
    'BW': ('B', BORROWED, BORROWED, True),
    'BR': ('B', BORROWED, BORROWED, False),
    'A': ('H', None, None, True),
}


def _without_lexicon(raw):
    """A fixture project or document with no lexicon, nor links to one."""
    if isinstance(raw, dict):
        return {k: _without_lexicon(v) for k, v in raw.items() if k != 'vocabs'}
    if isinstance(raw, list):
        return [_without_lexicon(x) for x in raw]
    return raw


@pytest.fixture(scope='module')
def people(live_client):
    return {col: _user(live_client, email) for col, email in USERS.items()}


@pytest.fixture
def world(live_client, people):
    """H holds the lexicon, B borrows it, and each person holds the role
    their column names."""
    b = seed(live_client, _without_lexicon(project_raw()), {'d1': _without_lexicon(document_raw())}, {},
             name=BORROWER)
    h = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()}, name=HOME)
    vid = h.ids[VOCAB]
    live_client.projects.link_vocab(b.project_id, vid)
    for col, email in USERS.items():
        getattr(live_client.projects, ROLE[col[1]])((h if col[0] == 'H' else b).project_id, email)
    yield {'H': h, 'B': b, 'vocab': vid}
    # The borrower first: core refuses to delete the home while it borrows.
    b.delete()
    h.delete()


def _delegated(admin, who, project_id):
    """A delegated token for ``who`` (a logged-in client) on ``project_id``,
    minted as a delegating service gets one: the administrator runs the
    service there, the user sends it a request, the token comes in the event."""
    url = _Session.url.rstrip('/') + '/api/v1'
    sid = 'vh-agent-' + uuid.uuid4().hex[:6]
    extras = json.dumps({'schemaVersion': 1, 'tasks': ['x'], 'delegation': True})
    got, ready, opened = {}, threading.Event(), []

    def serve():
        r = requests.get(f'{url}/projects/{project_id}/services/{sid}/requests',
                         params={'service-name': 'VH agent', 'extras': extras}, stream=True,
                         headers={'Authorization': 'Bearer ' + admin.token}, timeout=60)
        opened.append(r)
        buf = b''
        for ch in r.iter_content(1):
            buf += ch
            if b'"connected"' in buf:
                ready.set()
            if b'service_request' in buf and buf.endswith(b'\n\n'):
                got['event'] = buf.decode(errors='replace')
                ready.set()
                return

    th = threading.Thread(target=serve, daemon=True)
    th.start()
    ready.wait(10)
    ready.clear()
    sub = requests.post(f'{url}/projects/{project_id}/services/{sid}/requests',
                        params={'project-ids': project_id}, json={'x': 1},
                        headers={'Authorization': 'Bearer ' + who.token}, stream=True, timeout=60)
    th.join(10)
    for r in opened + [sub]:
        r.close()
    ev = got.get('event', '')
    data = json.loads(ev.rsplit('data: ', 1)[1].split('\n')[0]) if 'data: ' in ev else {}
    assert 'delegated-token' in data, f'no delegated token: {sub.status_code} {ev[-300:]}'
    return PlaidClient(_Session.url, data['delegated-token'])


def _refused_by_core(fn):
    try:
        fn()
    except PlaidAPIError as e:
        return e.status == 403
    return False


@pytest.mark.parametrize('column', list(TABLE))
def test_section_one_two_over_a_real_core(live_client, people, world, column):
    where, on_maintainer, on_writer, links = TABLE[column]
    project_id, vid = world[where].project_id, world['vocab']
    own = live_client if column == 'A' else people[column]
    email = _Session.user if column == 'A' else USERS[column]
    token = _delegated(live_client, own, project_id)
    items = {it['form']: it['id'] for it in live_client.vocab_layers.get(vid, include_items=True)['items']}

    def stage(name, args):
        ws = Workspace(token, load_project(token, project_id))
        ws.requester_id = email
        return ws, call_tool(ws, name, args)

    def apply(ws):
        execute_plan(token, ws.plan_payload()['ops'], source='service:igt:assist:vh', label='vh',
                     project=load_project(token, project_id), requester=email)

    calls = [(c, on_writer, lambda: own.vocab_items.create(vid, 'zz', {})) for c in WRITER_CALLS]
    if links:
        calls.append((LINK_CALL, None, None))
    calls += [(c, on_maintainer, lambda: own.vocab_items.delete(items['Ali'])) for c in MAINTAINER_CALLS]
    for (name, args), said, core_write in calls:
        ws, out = stage(name, args)
        if said is None:
            assert 'Planned' in out and ws.ops, (column, name, out)
            apply(ws)
        else:
            assert said in out and ws.ops == [], (column, name, out)
            assert _refused_by_core(core_write), (column, name, 'core took what the assistant refused')
    after = {it['id']: it for it in live_client.vocab_layers.get(vid, include_items=True)['items']}
    made = [it for it in after.values() if it['form'] == 'kai']
    if on_writer is None:
        assert [it['metadata'].get('gloss') for it in made] == ['go'], column
    else:
        assert made == [], column
    if on_maintainer is None:
        # Ali renamed, -di deleted, gam "net" merged into gam "fish".
        assert after[items['Ali']]['form'] == 'Aly' and items['-di'] not in after, column
        assert [it['form'] for it in after.values()].count('gam') == 1, column
    else:
        assert after[items['Ali']]['form'] == 'Ali' and items['-di'] in after, column


def test_a_link_planned_before_the_home_ended_the_borrowing_is_out_of_date_for_that_reason(live_client, people,
                                                                                            world):
    B, vid = world['B'].project_id, world['vocab']
    token = _delegated(live_client, people['BW'], B)
    ws = Workspace(token, load_project(token, B))
    ws.requester_id = USERS['BW']
    out = call_tool(ws, *LINK_CALL)
    assert ws.ops, out
    people['HM'].projects.unlink_vocab(B, vid)
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(token, ws.plan_payload()['ops'], source='service:igt:assist:vh', label='vh',
                     project=load_project(token, B), requester=USERS['BW'])
    assert e.value.reasons == ['a lexicon this plan links words to is no longer linked to this project']
    gam = [it for it in live_client.vocab_layers.get(vid, include_items=True)['items'] if it['form'] == 'gam']
    assert len(gam) == 2, 'the entry is still there'
