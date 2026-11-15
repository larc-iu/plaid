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


#: What a test's plan fills unless it says (plan_work's ``fills``, kept as
#: target ids): a glossing job's, segmentation and the morpheme gloss.
FILLS = ('segmentation', MGLOSS)
#: ... and the translation: what a test that translates fills.
TRANSLATING = ('segmentation', MGLOSS, TRANS)


#: The instructions a test's job is started with, unless it says others.
INSTRUCTIONS = 'Segment and gloss the words nobody has analysed.'


def start(client, instructions=INSTRUCTIONS, documents=None, now=None, id=None, plan='sentences', edits_text=None,
          fills=FILLS, only_empty=False):
    """A job started and claimed on ``client``, held as the worker holds it
    (no heartbeat thread: a test beats by hand). Its plan is kept as the
    planning context would have kept it (``plan`` the pieces, None for no
    plan: the job's first model context then plans it, ``edits_text`` its
    plan_work flag, :data:`EDITS_TEXT` when not given)."""
    if now is not None:
        client.jobs.now = now
    made = client.jobs.create(PID, 'igt', instructions, documents, id=id)
    claimed = client.jobs.claim('worker-1', 'fake/m', ['igt'])
    assert claimed['job']['id'] == made['id']
    if plan is not None:
        keep_plan(client, made['id'], plan, edits_text=edits_text, fills=fills, only_empty=only_empty)
    if now is None:
        clock = {'t': __import__('time').time()}
        now = lambda: clock['t']  # noqa: E731

        def sleep(seconds):
            clock['t'] += seconds
    else:
        def sleep(seconds):
            return None
    return Job(client, claimed, 'worker-1', client_for=lambda token: client, model='fake/m', sleep=sleep, now=now)


#: Whether a test's plans say the job may change the text (plan_work's
#: ``edits_text``) unless a test says: a module whose pieces script text
#: edits sets it with :func:`text_edits`.
EDITS_TEXT = False


def text_edits(monkeypatch):
    """The plans this test keeps say the job may change the text: for the
    tests whose pieces retype, split, merge or delete words or sentences."""
    import job_fixtures
    monkeypatch.setattr(job_fixtures, 'EDITS_TEXT', True)


def plan_row(pieces='sentences', documents=None, edits_text=None, fills=FILLS, only_empty=False, ids=None):
    """The decision row of a job's plan, as the planning context keeps it
    (its instructions for every piece, none here, are a row of their own).
    ``fills``: target ids, empty for a plan that fills nothing, each a
    fixture layer id mapped through ``ids`` (a seeded project's) when
    given."""
    from plaid_agent.core.job import analysis_key, canonical
    from plaid_agent.igt.job import PLAN_FORM
    edits = EDITS_TEXT if edits_text is None else edits_text
    text = canonical({'pieces': pieces, 'documents': documents, 'by': 'model', 'why': None,
                      **({'fills': [(ids or {}).get(f, f) for f in fills]} if fills else {}), **({'only_empty': True} if only_empty else {}),
                      **({'edits_text': True} if edits else {})})
    return {'form': PLAN_FORM, 'key': analysis_key(text), 'analysis': text, 'count': 1, 'document_id': None,
            'sentence_id': None}


def keep_plan(client, job_id, pieces='sentences', documents=None, worker='worker-1', edits_text=None, fills=FILLS,
              only_empty=False):
    """The job's plan among its decisions, as the planning context keeps it."""
    client.jobs.add_decisions(job_id, worker, [plan_row(pieces, documents, edits_text, fills, only_empty)])


def runner(job, write_summary=False, **kw):
    """The job's runner, with no final context unless asked: a test's model
    answers the pieces it is about."""
    return IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000), count=_count,
                     write_summary=write_summary, **kw)


def recorded(job):
    """The job's record of every word it holds in its documents as they read
    now, as its writes would have left it among its decisions, each word
    vouched for: a writing row of a write that landed (it sends nothing,
    so it needs no lookup) and the sentence's record of the words' keys.
    Harmonize rewrites only what the job recorded it wrote on that word
    (REV-J-B2 S3-1, REV-J-B3)."""
    from plaid_agent.igt import job as igt_job
    r = runner(job)
    project = r.project()
    docs = {d: r.read(project, d) for d in job.order}
    for d, doc in docs.items():
        rows = []
        for s in doc.sentences:
            mine = [w for w in s.words if igt_job.job_owned(w, job.id)]
            words = [igt_job.word_tag(w.id) for w in mine]
            own = igt_job.translation_state(s, project, job.id) == 'own'
            if not (words or own):
                continue
            counts = {'words': len(words), 'analyzed': 1, **({'translations': 1} if own else {})}
            text = igt_job.writing_text({'document': d, 'write': 'fixture', 'try': '', 'piece': '', 'own': True,
                                         'words': words, 'others': [igt_job.word_tag(w.id) for w in s.words
                                                                    if igt_job.word_tag(w.id) not in words],
                                         'counts': counts, 'left': []})
            rows.append({'form': igt_job.writing_form(s.id), 'key': igt_job.analysis_key(text), 'analysis': text,
                         'count': 1, 'document_id': d, 'sentence_id': s.id})
            if mine:
                mark = igt_job.mark_text(d, {igt_job.word_tag(w.id): igt_job.word_key(w) for w in mine})
                rows.append({'form': igt_job.mark_form(s.id), 'key': igt_job.analysis_key(mark), 'analysis': mark,
                             'count': 1, 'document_id': d, 'sentence_id': s.id})
        if rows:
            job.add_decisions(rows)
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


#: What a job's planning message ends with.
PLANNING_ENDS = 'Plan the job and end with plan_work.'
#: The plan :func:`planned` keeps: a glossing and translating job's, in
#: stretches of the sentences with something empty.
GLOSSING_PLAN = {'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss', 'Translation'],
                 'skip_filled_sentences': True}


def planned(answer, plan=None):
    """``answer`` for the job's pieces, with a planning context that ends
    with plan_work (``plan``, :data:`GLOSSING_PLAN` unless given): a job
    whose planning ends with no plan works nothing (REV-DF3-2)."""
    plan = plan or GLOSSING_PLAN

    def both(asked, n, kwargs):
        if str(asked).rstrip().endswith(PLANNING_ENDS):
            return reply(calls=[call(90 + n, 'plan_work', plan)]) if n == 1 else reply('Planned.')
        return answer(asked, n, kwargs)
    return both


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


def every_tool(monkeypatch):
    """A piece of a plan in sentences offered every tool, as a document's
    piece is: for the tests of how the worker handles a tool such a piece is
    no longer offered (toolkit.sentences_piece_tools): every tool the
    assistant has is allowed, by the test alone (no production hook)."""
    from plaid_agent.igt import toolkit
    every = tuple(t['function']['name'] for t in toolkit.TOOLS)
    monkeypatch.setattr(toolkit, 'sentences_piece_tools', lambda targets: every)


def use(monkeypatch, model):
    from plaid_agent.core import agent
    monkeypatch.setattr(agent.litellm, 'completion', model)
    return model


def targets_named(asked):
    """The target sentences a stretch's message names, as numbers."""
    line = next(line for line in asked.splitlines() if line.startswith('Your piece: s'))
    return [int(r[1:]) for r in line[len('Your piece: '):].split('.')[0].split(', ')]


def instructed(asked, word):
    """Whether the instructions a piece's message carries name ``word``
    (case aside): how a test's model knows what its job is for."""
    lines = asked.splitlines()
    if 'Instructions from' not in asked:
        return False
    i = next(i for i, x in enumerate(lines) if x.startswith('Instructions from'))
    return word.lower() in (lines[i + 1] if i + 1 < len(lines) else '').lower()


def empty_translations(asked):
    """The sentences whose translation a piece's message says is empty."""
    import re
    return [int(m.group(1)) for m in re.finditer(r'^Empty in s(\d+): .*\bTranslation\.$', asked, re.M)]


def empty_words(asked):
    """``[(sentence, [(word, form)])]`` a piece's message names as empty in
    a word or morpheme level target, each word once (``wN`` refs, a
    morpheme's ``wN.mK`` as its word)."""
    import re
    out = []
    for m in re.finditer(r'^Empty in s(\d+): (.*)\.$', asked, re.M):
        seen = {}
        for w, form in re.findall(r'\bw(\d+)(?:\.m\d+)? "([^"]*)"', m.group(2)):
            seen.setdefault(int(w), form)
        if seen:
            out.append((int(m.group(1)), sorted(seen.items())))
    return out


def empty_word_lines(asked):
    """``[(sentence, 'w1 "ka", w3 "ta"')]``: :func:`empty_words` as text,
    one entry per sentence naming empty words."""
    return [(str(s), ', '.join(f'w{w} "{f}"' for w, f in words)) for s, words in empty_words(asked)]


# --- a project with one more field at each level (the owner's steer) -------------------

#: A word field (Role), a morpheme field that is not the gloss (Morph POS) and
#: a sentence field that is not the translation (Note), none linked to the
#: lexicon.
ROLE, MPOS, NOTE = 'sl-role', 'sl-mpos', 'sl-note'
FIELD_LAYERS = {ROLE: (WORD_LAYER, 'Role', 'Word'), MPOS: (MORPH_LAYER, 'Morph POS', 'Morpheme'),
                NOTE: (SENT_LAYER, 'Note', 'Sentence')}


def fields_project():
    """The job's project with Role, Morph POS and Note."""
    p = job_project()
    layers = {tk['id']: tk for tk in p['text_layers'][0]['token_layers']}
    for layer_id, (token_layer, name, scope) in FIELD_LAYERS.items():
        layers[token_layer]['span_layers'].append({'id': layer_id, 'name': name, 'config': {'igt': {'scope': scope}}})
    return p


def with_values(raw, values):
    """``raw`` (a :func:`document`) with ``values``: ``(layer, token id,
    value, who)`` in the fields of :func:`fields_project`."""
    layers = {tk['id']: tk for tk in raw['text_layers'][0]['token_layers']}
    for layer_id, token_id, value, who in values:
        token_layer = layers[FIELD_LAYERS[layer_id][0]]
        span_layer = next((sl for sl in token_layer['span_layers'] if sl['id'] == layer_id), None)
        if span_layer is None:
            span_layer = {'id': layer_id, 'spans': []}
            token_layer['span_layers'].append(span_layer)
        span_layer['spans'].append({'id': f'sp-{layer_id}-{token_id}', 'value': value, 'tokens': [token_id],
                                    'metadata': stamp(who)})
    return raw
