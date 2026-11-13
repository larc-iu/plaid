"""Documents, a client and a scripted model for the job runner's tests.

Built on the igt fixture's project (``fixtures.project_raw``) with a Status
field on its lexicon, as every vocabulary has one now. A document is written
as its sentences: each a list of words, where a word is a bare form (blank)
or ``(form, morphemes, who)`` with ``morphemes`` a list of ``(form, gloss)``
and ``who`` the provenance of every piece ('human', 'machine' or a job id),
plus the sentence's translation and its provenance.

The fake client answers reads from the fixture and records writes, so a test
that needs the document as a write left it hands that version in
(``JobClient.after_write``): reads made after the first write answer it.
"""

import contextlib
import copy
import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

from fixtures import FakeClient, GLOSS, MGLOSS, MORPH_LAYER, PID, SENT_LAYER, TEXT_ID, TEXT_LAYER, TRANS, VOCAB, \
    WORD_LAYER, lexicon_raw, project_raw

from plaid_agent.core.agent import ModelConfig
from plaid_agent.core.job import Job
from plaid_agent.igt.job import IgtRunner

STATUS = 'status'
JOB_SOURCE = 'service:igt:job:fake-m'


def job_project():
    p = project_raw()
    fields = p['vocabs'][0]['config']['igt']['fields']
    fields[STATUS] = {'inline': False, 'tagset': 'Status', 'role': 'status'}
    return p


def stamp(who, job_id=None):
    if who == 'human' or who is None:
        return {}
    if who == 'machine':
        return {'prov': 'inferred', 'provSource': 'service:igt:analyze'}
    if who.startswith('confirmed:'):
        # A job's proposal a person confirmed.
        return {**stamp(who[len('confirmed:'):]), 'provConfirmed': True}
    return {'prov': 'inferred', 'provSource': JOB_SOURCE, 'provDetail': {'model': 'm', 'version': 'v', 'job': who}}


def document(doc_id, name, sentences, version=1):
    """A raw document of ``sentences``: each ``{'words': [...], 'translation':
    (value, who) or None}``."""
    body = ''
    sent_tokens, word_tokens, morph_tokens = [], [], []
    trans_spans, gloss_spans, mgloss_spans, mlinks = [], [], [], []
    n = 0
    for si, s in enumerate(sentences, start=1):
        start = len(body)
        for wi, w in enumerate(s['words'], start=1):
            word_gloss = None
            if isinstance(w, dict):
                form, morphs, who, word_gloss = w['form'], w.get('morphs'), w.get('who'), w.get('gloss')
            else:
                form, morphs, who = (w, None, None) if isinstance(w, str) else w
            if wi > 1:
                body += ' '
            b = len(body)
            body += form
            e = len(body)
            wid = f'{doc_id}-s{si}w{wi}'
            word_tokens.append({'id': wid, 'begin': b, 'end': e})
            if word_gloss:
                gloss_spans.append({'id': f'sp-{wid}', 'value': word_gloss[0], 'tokens': [wid],
                                    'metadata': stamp(word_gloss[1])})
            # ``who`` is one provenance for every piece, or one per piece:
            # {'token': ..., 'span': ..., 'link': ...}.
            by = who if isinstance(who, dict) else {'token': who, 'span': who, 'link': who}
            for mi, m in enumerate(morphs or [], start=1):
                n += 1
                mform, mgloss = m[0], m[1]
                mid = f'{wid}m{mi}'
                morph_tokens.append({'id': mid, 'begin': b, 'end': e, 'precedence': mi,
                                     'metadata': {'form': mform, **stamp(by.get('token'))}})
                if mgloss:
                    mgloss_spans.append({'id': f'sp-{mid}', 'value': mgloss, 'tokens': [mid],
                                         'metadata': stamp(by.get('span'))})
                if len(m) > 2 and m[2]:
                    mlinks.append({'id': f'l-{mid}', 'vocab_item': {'id': m[2], 'form': mform}, 'tokens': [mid],
                                   'metadata': stamp(by.get('link'))})
        body += '.'
        sid = f'{doc_id}-s{si}'
        sent_tokens.append({'id': sid, 'begin': start, 'end': len(body)})
        if s.get('translation'):
            value, who = s['translation']
            trans_spans.append({'id': f'sp-t-{sid}', 'value': value, 'tokens': [sid], 'metadata': stamp(who)})
        body += ' '
    body = body.rstrip()
    return {
        'id': doc_id, 'name': name, 'version': version, 'metadata': {},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'text': {'id': f'{TEXT_ID}-{doc_id}', 'body': body},
            'token_layers': [
                {'id': SENT_LAYER, 'tokens': sent_tokens, 'span_layers': [{'id': TRANS, 'spans': trans_spans}]},
                {'id': WORD_LAYER, 'tokens': word_tokens, 'span_layers': [{'id': GLOSS, 'spans': gloss_spans}],
                 'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'project': PID, 'vocab_links': []}]},
                {'id': MORPH_LAYER, 'tokens': morph_tokens, 'span_layers': [{'id': MGLOSS, 'spans': mgloss_spans}],
                 'vocabs': [{'id': VOCAB, 'name': 'Lexicon', 'project': PID, 'vocab_links': mlinks}]},
            ]}],
    }


def blank(n, word='ka'):
    """``n`` sentences of two blank words each, no translation."""
    return [{'words': [f'{word}{i}', 'ta']} for i in range(1, n + 1)]


class JobClient(FakeClient):
    """The igt fake client with a lexicon holding a Status field, whose reads
    answer ``after_write[document id]`` once anything was written."""

    def __init__(self, documents, lexicon=None, project=None, **kw):
        super().__init__(project=project or job_project(), documents=documents, audit=[],
                         lexicon=lexicon or lexicon_raw(), **kw)
        self.after_write = {}
        #: vocabulary id -> the comments on its entries
        self.vocab_comments = {}
        comments = self.comments
        comments.list_in_vocab = lambda vocab_id, entity_id=None: [
            c for c in self.vocab_comments.get(vocab_id, []) if entity_id is None or c.get('entity_id') == entity_id]
        #: document id -> the document a person left once the job takes its lock
        self.on_lock = {}
        locked = self.documents.locked

        @contextlib.contextmanager
        def on_locked(document_id, **kwargs):
            if document_id in self.on_lock:
                self._holder(document_id)['documents'][document_id] = self.on_lock.pop(document_id)
            with locked(document_id, **kwargs) as held:
                yield held
        self.documents.locked = on_locked
        reads = self.documents.get

        def get(document_id, **kwargs):
            if document_id in self.after_write and self.writes:
                self.reads.append({'id': document_id, 'layers': kwargs.get('layers')})
                return copy.deepcopy(self.after_write[document_id])
            return reads(document_id, **kwargs)
        self.documents.get = get

    def note_stamp(self, kind):
        """A write in strict mode moves the client's version of its document
        to the one it leaves, as core's answer does: here the version of the
        document a test hands in as the write's result (``after_write``).
        And it is the newest change in the document's History, under the
        open operation's ref, as core places a unit by its newest write."""
        super().note_stamp(kind)
        doc = self.strict_mode_document_id
        if doc is None or kind in ('lock', 'unlock', 'read', 'operation'):
            return
        if doc in self.after_write:
            self.document_versions[doc] = self.after_write[doc].get('version')
        if self._operation_depth:
            history = self._holder(doc)['audit']
            newest = max((e.get('time') or '' for e in history), default='')
            # An operation opened inside another joins it (the outer one's ref).
            ref = next((t['ref'] for t in reversed(self.operation_tags) if t.get('ref')), None)
            history.append({'id': f'unit-{len(history) + 1}', 'ref': ref,
                            'time': max(newest_after(newest), _iso(time.time())), 'documents': [{'id': doc}]})


def _iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def newest_after(when):
    """A History time a millisecond after ``when`` (an ISO time), or ''."""
    if not when:
        return ''
    return _iso(datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() + 0.001)


def start(client, tasks=('gloss',), documents=None, note=None, now=None, id=None):
    """A job started and claimed on ``client``, held as the worker holds it
    (no heartbeat thread: a test beats by hand)."""
    if now is not None:
        client.jobs.now = now
    made = client.jobs.create(PID, 'igt', list(tasks), documents, note, id=id)
    claimed = client.jobs.claim('worker-1', 'fake/m', ['igt'])
    assert claimed['job']['id'] == made['id']
    if now is None:
        clock = {'t': __import__('time').time()}
        now = lambda: clock['t']  # noqa: E731

        def sleep(seconds):
            clock['t'] += seconds
    else:
        def sleep(seconds):
            return None
    return Job(client, claimed, 'worker-1', client_for=lambda token: client, model='fake/m', sleep=sleep, now=now)


def runner(job, **kw):
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=_count, **kw)


def recorded(job):
    """The job's record of every word it holds in its documents as they read
    now, as its stretches would have left it among its decisions, each word
    vouched for: harmonize rewrites only what the job recorded it wrote on
    that word (REV-J-B2 S3-1, REV-J-B3)."""
    from plaid_agent.igt import job as igt_job
    r = runner(job)
    project = r.project()
    docs = {d: r.read(project, d) for d in job.order}
    for d, doc in docs.items():
        # The writing row each stretch sends before its write (REV-FIX3-1),
        # every word of its sentence named (REV-B4-1). All of them before
        # the runner reads any, as a worker that resumes finds them.
        rows = []
        for s in doc.sentences:
            words = [igt_job.word_tag(w.id) for w in s.words if igt_job.job_owned(w, job.id)]
            others = [igt_job.word_tag(w.id) for w in s.words if igt_job.word_tag(w.id) not in words]
            own = igt_job.translation_state(s, project, job.id) == 'own'
            if words or own:
                text = igt_job.writing_text(d, 'translations' if own else None, words, others)
                rows.append({'form': igt_job.writing_form(s.id), 'key': igt_job.analysis_key(text),
                             'analysis': text, 'count': 1, 'document_id': d, 'sentence_id': s.id})
        if rows:
            job.add_decisions(rows)
    for d, doc in docs.items():
        r.settle(project, d, doc, own=True)
    return job


def _count(value):
    """Tokens as the tests count them: a quarter of the JSON's characters."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return len(text) // 4


# --- the scripted model ----------------------------------------------------------

def call(i, name, args):
    return SimpleNamespace(id=f'c{i}', function=SimpleNamespace(name=name, arguments=json.dumps(args)))


def reply(content=None, calls=None, finish='stop'):
    msg = SimpleNamespace(content=content, tool_calls=calls or None)
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)], usage=None)


class Model:
    """The model as a function of what it is sent: ``answer(asked, n, kwargs)``
    gets the stretch's user message, which call of the stretch this is (from
    1) and the call's arguments, and returns a reply. Every call is kept."""

    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def __call__(self, **kwargs):
        messages = kwargs['messages']
        asked = next(m['content'] for m in messages if m['role'] == 'user')
        n = sum(1 for m in messages if m['role'] == 'assistant') + 1
        self.calls.append({'asked': asked, 'n': n, 'kwargs': kwargs})
        return self.answer(asked, n, kwargs)


def use(monkeypatch, model):
    from plaid_agent.core import agent
    monkeypatch.setattr(agent.litellm, 'completion', model)
    return model


def targets_named(asked):
    """The target sentences a stretch's message names, as numbers."""
    line = next(line for line in asked.splitlines() if line.startswith('Analyse '))
    return [int(r[1:]) for r in line[len('Analyse '):].split('.')[0].split(', ')]
