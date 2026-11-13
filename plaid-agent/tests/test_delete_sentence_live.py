"""delete_sentence on a real core (BRIEF-JS), approved through the assistant
service: what goes with the sentence, what stays of its neighbours, and who
may approve it.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import copy
import uuid

from fixtures import GLOSS, MGLOSS, MORPH_LAYER, SENT_LAYER, TRANS, WORD_LAYER
from job_fixtures import document, job_project
from live import _skip_or_fail, core_url, login, seed
from test_service_flow import Helper

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.conversation import ConversationStore, assistant_item, build_meta, user_item
from plaid_agent.igt.project import load_project
from plaid_agent.igt.service import AssistantService
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace

PASSWORD = 'delete-sentence-pass-1'
#: s2 is the doubled sentence: a person's analysis, gloss, links and
#: translation on it, as on its neighbours.
SENTENCES = [
    {'words': [{'form': 'ka', 'morphs': [('k', 'K', 'e-k'), ('a', 'A')], 'gloss': ('one', 'human')}, 'ta'],
     'translation': ('First.', 'human')},
    {'words': [{'form': 'ka', 'morphs': [('k', 'K', 'e-k'), ('a', 'A')], 'gloss': ('one', 'human')}, 'ta'],
     'translation': ('Doubled.', 'human')},
    {'words': [{'form': 'sa', 'morphs': [('s', 'S', 'e-s'), ('a', 'A')], 'gloss': ('two', 'human')}],
     'translation': ('Last.', 'human')},
]
LEXICON = {'v1': {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': [
    {'id': 'e-k', 'form': 'k', 'metadata': {'gloss': 'K'}}, {'id': 'e-s', 'form': 's', 'metadata': {'gloss': 'S'}}]}}


def _admin():
    try:
        return login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')


def _user(admin, prefix):
    from plaid_client import PlaidClient
    email = f'{prefix}-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, PASSWORD, False)
    return email, PlaidClient.login(core_url(), email, PASSWORD)


def _project(reviewed=()):
    p = job_project()
    if reviewed:
        p = copy.deepcopy(p)
        p.setdefault('config', {}).setdefault('plaid', {})['review'] = {'users': list(reviewed), 'roles': []}
    return p


def _approve(client, user, project_id, ws):
    """The plan approved by ``user`` through the service, as the app sends
    an approval."""
    p = ws.plan_payload()
    store = ConversationStore(client, user, project_id, 'igt')
    item = assistant_item('Planned.', p, [], [], '', 'fake/model', service='igt:assist:fake')
    conv = {'messages': [{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': 'Planned.'}],
            'display': [user_item('x'), item]}
    store.save('c1', conv, build_meta(None, 'c1', conv, 'igt:assist:fake', 'fake/model'))
    svc = AssistantService()
    svc.cfg = ModelConfig(model='fake/model')
    svc.service_id = 'igt:assist:fake'
    h = Helper(request_id='r1', requester_id=user)
    svc.process_request({'requester_client': client, 'requester_id': user, 'project_id': project_id,
                         'delegated_projects': [project_id], 'conversation_id': 'c1', 'op': 'approve',
                         'plan_id': p['id']}, h)
    return p, h


def _state(admin, s):
    """The document as core holds it: the body, and per layer its tokens
    (id, text) and its spans (value, the text of their token)."""
    raw = admin.documents.get(s.ids['dA'], include_body=True)
    tl = raw['text_layers'][0]
    body = tl['text']['body']
    layers = {tk['id']: tk for tk in tl['token_layers']}
    texts = {t['id']: body[t['begin']:t['end']] for tk in tl['token_layers'] for t in tk['tokens']}
    out = {'body': body}
    for name, lid in (('sentences', SENT_LAYER), ('words', WORD_LAYER), ('morphemes', MORPH_LAYER)):
        tokens = sorted(layers[s.ids[lid]]['tokens'], key=lambda t: (t['begin'], t.get('precedence') or 0))
        out[name] = [t['id'] for t in tokens]
    for name, lid, sl in (('translations', SENT_LAYER, TRANS), ('glosses', WORD_LAYER, GLOSS),
                          ('morph_glosses', MORPH_LAYER, MGLOSS)):
        [spans] = [x['spans'] for x in layers[s.ids[lid]]['span_layers'] if x['id'] == s.ids[sl]]
        out[name] = sorted((sp['value'], texts[sp['tokens'][0]]) for sp in spans)
    out['links'] = sorted((l['id'], texts[l['tokens'][0]]) for v in layers[s.ids[MORPH_LAYER]].get('vocabs') or []
                          for l in v.get('vocab_links') or [])
    out['texts'] = texts
    return out


def _stage(client, s, refs=('s2',)):
    ws = Workspace(client, load_project(client, s.project_id))
    out = call_tool(ws, 'delete_sentence', {'document': 'Alpha', 'refs': list(refs)})
    assert out.startswith('Planned'), out
    return ws


def test_a_person_s_sentence_goes_with_everything_on_it_and_its_neighbours_stay_as_they_were():
    admin = _admin()
    email, writer = _user(admin, 'del-sent')
    s = seed(admin, _project(), {'dA': document('dA', 'Alpha', SENTENCES)}, LEXICON,
             name=f'delete sentence {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_writer(s.project_id, email)
        sid, w1 = s.ids['dA-s2'], s.ids['dA-s2w1']
        comments = [writer.comments.create('token', sid, 'Doubled by the transcriber?')['id'],
                    writer.comments.create('token', w1, 'Same as s1.')['id']]
        before = _state(admin, s)
        assert before['body'] == 'ka ta. ka ta. sa.'
        ws = _stage(writer, s)
        p, h = _approve(writer, email, s.project_id, ws)
        assert p['stamp_choice'] is False
        assert not h.errors, h.errors
        after = _state(admin, s)
        assert after['body'] == 'ka ta. sa.'
        # The sentence, its words, morphemes, values and links are gone.
        gone = {sid, w1, s.ids['dA-s2w2'], s.ids['dA-s2w1m1'], s.ids['dA-s2w1m2']}
        assert not gone & set(after['texts'])
        assert after['sentences'] == [s.ids['dA-s1'], s.ids['dA-s3']]
        assert after['translations'] == [('First.', 'ka ta. '), ('Last.', 'sa.')]
        assert after['glosses'] == [('one', 'ka'), ('two', 'sa')]
        assert after['morph_glosses'] == [('A', 'ka'), ('A', 'sa'), ('K', 'ka'), ('S', 'sa')]
        assert len(after['links']) == 2 and len(before['links']) == 3
        # The neighbours keep their tokens, each over its own text.
        for key in ('dA-s1', 'dA-s1w1', 'dA-s1w2', 'dA-s1w1m1', 'dA-s3', 'dA-s3w1', 'dA-s3w1m2'):
            assert after['texts'][s.ids[key]] == before['texts'][s.ids[key]], key
        # Comments are not annotations: they stay, on what no longer exists.
        assert [admin.comments.get(c)['body'] for c in comments] == ['Doubled by the transcriber?', 'Same as s1.']
        # One operation in the document's History, named by the plan.
        assert any('deleted sentence' in (e.get('message') or '') for e in admin.documents.audit(s.ids['dA']))
    finally:
        s.delete()


def test_the_only_sentences_go_and_the_document_stays_with_an_empty_text():
    admin = _admin()
    email, writer = _user(admin, 'del-all')
    s = seed(admin, _project(), {'dA': document('dA', 'Alpha', SENTENCES)}, LEXICON,
             name=f'delete all {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_writer(s.project_id, email)
        ws = _stage(writer, s, ('s1', 's2', 's3'))
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.errors, h.errors
        after = _state(admin, s)
        assert after['body'] == '' and after['sentences'] == [] and after['words'] == []
        assert admin.documents.get(s.ids['dA'])['name'] == 'Alpha'
    finally:
        s.delete()


def test_a_contributor_deletes_it_and_a_reader_cannot():
    admin = _admin()
    contributor, cc = _user(admin, 'del-contrib')
    reader, rc = _user(admin, 'del-reader')
    s = seed(admin, _project(reviewed=[contributor]), {'dA': document('dA', 'Alpha', SENTENCES)}, LEXICON,
             name=f'delete roles {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_writer(s.project_id, contributor)
        admin.projects.add_reader(s.project_id, reader)
        before = _state(admin, s)
        _p, h = _approve(rc, reader, s.project_id, _stage(rc, s))
        assert not h.done and len(h.errors) == 1 and 'HTTP 403' in h.errors[0] \
            and h.errors[0].endswith('Nothing was written.'), (h.errors, h.done)
        assert _state(admin, s)['body'] == before['body'] == 'ka ta. ka ta. sa.'
        _p, h = _approve(cc, contributor, s.project_id, _stage(cc, s))
        assert not h.errors and h.done[0]['message'] == 'Applied 1 deleted sentence.', (h.errors, h.done)
        assert _state(admin, s)['body'] == 'ka ta. sa.'
    finally:
        s.delete()


def test_a_document_changed_after_the_plan_was_made_is_not_written():
    """The plan is pinned to the whole document, as a text edit's is: an
    edit anywhere in it since refuses the deletion at approval."""
    admin = _admin()
    email, writer = _user(admin, 'del-stale')
    s = seed(admin, _project(), {'dA': document('dA', 'Alpha', SENTENCES)}, LEXICON,
             name=f'delete stale {uuid.uuid4().hex[:6]}')
    try:
        admin.projects.add_writer(s.project_id, email)
        ws = _stage(writer, s)
        admin.spans.create(s.ids[GLOSS], [s.ids['dA-s1w2']], 'three')
        _p, h = _approve(writer, email, s.project_id, ws)
        assert not h.done and h.errors == ['Nothing was written. Document "Alpha" has changed since the plan was '
                                           'made. Ask the assistant to plan again.'], (h.errors, h.done)
        assert _state(admin, s)['body'] == 'ka ta. ka ta. sa.'
    finally:
        s.delete()
