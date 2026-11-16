"""Many values and many links in one call each, on a real core (BRIEF SP item
2): a job fills two word fields on every word of five analysed sentences and
links every morpheme to its lexicon entry, its scripted piece staging all of
it in two calls, one set_field of items and one link_entry of items. The
writes land, and the report counts every value and link as if each had been
staged by a call of its own.

Runs on the session's core (``live.py``), or the one PLAID_TEST_URL names."""

import time
import uuid

import pytest

from fixtures import MORPH_LAYER, WORD_LAYER
from job_fixtures import Model, call, document, job_project, plan_row, reply, use
from live import _skip_or_fail, core_url, login, seed
from test_job_live_entries import WORKER, _runner

from plaid_agent.core.job import Job, run_job

ROLE, ANIM = 'sl-role', 'sl-anim'
NAMES = {ROLE: 'Role', ANIM: 'Animacy'}
#: Five sentences, every word analysed by a person and linked to nothing.
WORDS = [['kata', 'pa'], ['ka', 'pata', 'ta'], ['pa', 'ka'], ['kapa', 'ta', 'ka'], ['pa', 'ta']]
GLOSS = {'ka': 'go', 'ta': 'PST', 'pa': 'dog'}
ENTRIES = [{'id': f'vi-{f}', 'form': f, 'metadata': {'gloss': g}} for f, g in GLOSS.items()]


def _morphs(word):
    return [word[i:i + 2] for i in range(0, len(word), 2)]


def _project():
    p = job_project()
    words = next(tk for tk in p['text_layers'][0]['token_layers'] if tk['id'] == WORD_LAYER)
    for layer, name in NAMES.items():
        words['span_layers'].append({'id': layer, 'name': name, 'config': {'igt': {'scope': 'Word'}}})
    return p


def _document():
    return document('d1', 'Story', [{'words': [(w, [(m, GLOSS[m]) for m in _morphs(w)], 'human') for w in ws]}
                                    for ws in WORDS])


@pytest.fixture
def world():
    try:
        admin = login()
    except Exception as e:  # noqa: BLE001
        _skip_or_fail(f'no core: {e}')
    from plaid_client import PlaidClient
    email = f'job-items-{uuid.uuid4().hex[:8]}@example.org'
    admin.users.create(email, 'job-items-pass-1', False)
    writer = PlaidClient.login(core_url(), email, 'job-items-pass-1')
    lexicon = {'id': 'v1', 'name': 'Lexicon', 'project': 'p1', 'items': ENTRIES}
    s = seed(admin, _project(), {'d1': _document()}, {'v1': lexicon}, name=f'job items {uuid.uuid4().hex[:6]}')
    admin.projects.add_writer(s.project_id, email)
    yield admin, writer, s
    s.delete()


def _job(admin, writer, s):
    from plaid_client import PlaidClient
    made = writer.jobs.create(s.project_id, 'igt', 'Fill Role and Animacy on every word, and link every morpheme.')
    claimed = admin.jobs.claim(WORKER, 'fake/m', ['igt'])
    assert claimed and claimed['job']['id'] == made['id']
    admin.jobs.add_decisions(made['id'], WORKER, [plan_row('document', ids=s.ids, fills=(ROLE, ANIM))])
    offset = {'s': 0.0}

    def wait(sec):
        offset['s'] += sec
    return Job(admin, claimed, WORKER, client_for=lambda token: PlaidClient(core_url(), token), model='fake/m',
               sleep=wait, now=lambda: time.time() + offset['s'])


def _role(si, wi):
    return 'agent' if wi == 1 else 'patient'


def _animacy(word):
    return 'animate' if 'pa' in _morphs(word) else 'inanimate'


VALUES = [{'ref': f's{si}.w{wi}', 'field': NAMES[layer], 'value': _role(si, wi) if layer == ROLE else _animacy(w)}
          for si, ws in enumerate(WORDS, start=1) for wi, w in enumerate(ws, start=1) for layer in (ROLE, ANIM)]
LINKS = [{'ref': f's{si}.w{wi}.m{mi}', 'entry_form': m} for si, ws in enumerate(WORDS, start=1)
         for wi, w in enumerate(ws, start=1) for mi, m in enumerate(_morphs(w), start=1)]


def _answer(asked, n, kwargs):
    if 'Your piece' not in asked:
        return reply('Done.')
    if n == 1:
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'items': VALUES})])
    if n == 2:
        return reply(calls=[call(2, 'link_entry', {'document': 'Story', 'items': LINKS})])
    return reply('Filled Role and Animacy on every word and linked every morpheme.')


def _held(admin, s):
    raw = admin.documents.get(s.ids['d1'], include_body=True)
    back = {real: fixture for fixture, real in s.ids.items()}
    layers = {tk['id']: tk for tl in raw['text_layers'] for tk in tl['token_layers']}
    values = {(back[sp['tokens'][0]], back[sl['id']]): sp['value'] for sl in layers[s.ids[WORD_LAYER]]['span_layers']
              if sl['id'] in (s.ids[ROLE], s.ids[ANIM]) for sp in sl.get('spans') or []}
    links = {back[ln['tokens'][0]]: back[ln['vocab_item']['id']] for v in layers[s.ids[MORPH_LAYER]].get('vocabs') or []
             for ln in v.get('vocab_links') or []}
    return values, links


def test_two_fields_on_every_word_and_every_link_are_staged_in_two_calls_and_counted_one_by_one(world, monkeypatch):
    admin, writer, s = world
    model = use(monkeypatch, Model(_answer))
    job = _job(admin, writer, s)
    finished = run_job(job, _runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    piece = [c for c in model.calls if 'Your piece' in c['asked']]
    assert [c['n'] for c in piece] == [1, 2, 3], 'two calls staged everything, the third ended the piece'
    said = [m['content'] for m in piece[-1]['kwargs']['messages'] if m['role'] == 'tool']
    # Nothing refused, nothing to say per item (the loop's own "[Staged: ...]"
    # line aside).
    assert [[x for x in a.splitlines() if not x.startswith('[Staged')] for a in said] == [
        [f'Staged {len(VALUES)} of {len(VALUES)} values. {len(VALUES)} changes staged in all, applied when you end.'],
        [f'Staged {len(LINKS)} of {len(LINKS)} links. {len(VALUES) + len(LINKS)} changes staged in all, applied '
         'when you end.']], said
    values, links = _held(admin, s)
    assert values == {(f'd1-s{si}w{wi}', layer): _role(si, wi) if layer == ROLE else _animacy(w)
                      for si, ws in enumerate(WORDS, start=1) for wi, w in enumerate(ws, start=1)
                      for layer in (ROLE, ANIM)}, 'every value landed'
    assert links == {f'd1-s{si}w{wi}m{mi}': f'vi-{m}' for si, ws in enumerate(WORDS, start=1)
                     for wi, w in enumerate(ws, start=1) for mi, m in enumerate(_morphs(w), start=1)}, \
        'every morpheme linked to its entry'
    report = finished['report']
    per_field = len(VALUES) // 2
    assert sorted(report['totals']['fields'], key=lambda f: f['field']) == [
        {'field': 'Animacy', 'id': s.ids[ANIM], 'values': per_field},
        {'field': 'Role', 'id': s.ids[ROLE], 'values': per_field}]
    assert report['totals']['links'] == len(LINKS)
    assert report['totals']['changes'] == len(VALUES) + len(LINKS)
    (doc,) = report['documents']
    assert doc['counts']['links'] == len(LINKS) and doc['counts']['changes'] == len(VALUES) + len(LINKS)
    assert doc['left'] == [] and not doc.get('refused') and not doc['skipped']
