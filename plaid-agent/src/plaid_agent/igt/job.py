"""An unattended job over interlinear text: the stretch runner.

The worker's loop, the heartbeat, the budgets and the halving are
``core.job``'s. What is here is what a job knows about interlinear text
(SPEC 3 and 5 to 9 of the jobs round, 2026-11-12):

* the checks before the first request (:meth:`IgtRunner.check`),
* what a TARGET is (:func:`word_target`, :func:`translation_target`): a blank
  word, an empty or machine translation the job did not write itself,
* what a stretch is handed (:meth:`IgtRunner.message`): the target sentences,
  two before them, how their forms were analysed by people and earlier in the
  job, the starter's note,
* the job's guards at staging (:class:`JobWorkspace`): nothing outside the
  stretch's targets, no entry that exists already, no entry in a borrowed
  lexicon,
* the write under the document's lock, checked again against the document as
  it is then (:meth:`IgtRunner.write`), stamped as machine proposals,
* the walk of a document, the skip and retry of one in use, the cursor,
* harmonize and the entries pass, and the app's parts of the report.
"""

import json
import logging
import os
import re
import unicodedata
import uuid
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import PlaidAPIError
from plaid_client.ids import uuid7
from plaid_client.provenance import PROV_CONFIRMED_KEY, PROV_DETAIL_KEY, prov_state, service_source
from plaid_client.service import locked_for_writes
from plaid_client.workflows.igt.derive import word_state as _stored_word_state

from ..core import job as core_job
from ..core.agent import ModelConfig, Toolkit, TurnCancelled, run_turn
from ..core.garble import seed
from ..core.guidelines import manual_chars
from ..core.job import (BUDGET, ROW_FINAL, JobStopped, Pace, StretchFailed, canonical, analysis_key,
                        empty_counts, failure_kind, halve, harmonized, not_answering)
from ..core.limits import (JOB_CONTEXT_SENTENCES, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S, JOB_GUIDELINES_MAX_CHARS,
                           JOB_LOCK_TRIES, JOB_LOCK_WAIT_S, JOB_PERSON_QUIET_S, JOB_PRECEDENT_CHARS,
                           JOB_PRECEDENT_PER_FORM, JOB_SENTENCE_MAX_CHARS, JOB_STRETCH_SENTENCES)
from ..core.plan import JOB_DETAIL_KEY, PlanError
from ..core.tools import Refusal, ToolError
from ..core.version import agent_version
from . import toolkit
from .plan import execute_plan
from .project import IgtProject, Sentence, Word, is_virtual, load_project, render_sentence
from .prompt import JOB_SYSTEM, build_job_prompt
from .trace import TRACER
from .vocab import ROLE_GLOSS, ROLE_STATUS
from .workspace import Workspace

logger = logging.getLogger(__name__)

#: The phase of the work on each document (CONTRACT 2.1).
WORK_PHASE = 'glossing'
#: The Status value of an entry a job creates (CONTRACT 10).
MACHINE_STATUS = 'machine'
#: Tasks as History names them (CONTRACT 8).
LABELS = {('translate',): 'translations', ('gloss',): 'analyses', ('gloss', 'link'): 'analyses and lexicon links',
          ('translate', 'gloss'): 'translations and analyses',
          ('translate', 'gloss', 'link'): 'translations, analyses and lexicon links'}
HARMONIZE_LABEL = 'Assistant job: analyses made consistent'
ENTRIES_LABEL = 'Assistant job: delete unlinked machine drafts'


def gloss_label(tasks) -> str:
    order = ('translate', 'gloss', 'link')
    return 'Assistant job: ' + LABELS[tuple(t for t in order if t in tasks)]


def job_source(model: str) -> str:
    """The job's provSource, ``service:igt:job:<model slug>``, as the
    assistants' service ids are made (``core.service_cli``)."""
    slug = re.sub(r'[^A-Za-z0-9._-]+', '-', model).strip('-')
    return service_source(f'igt:job:{slug}')


def form_key(surface: str) -> str:
    """A form as the decisions are keyed: NFC, case-folded (CONTRACT 2.3)."""
    return unicodedata.normalize('NFC', surface or '').casefold()


def _nfc(text) -> str:
    return unicodedata.normalize('NFC', str(text or ''))


# --- what a target is ------------------------------------------------------------

def word_state(w: Word) -> str:
    """``plaid_client.workflows.igt.derive.word_state`` of a parsed word: the
    one rule every machine writer of igt holds a word to."""
    morphs = [m for m in w.morphemes if not m.virtual]
    return _stored_word_state({
        'surface': w.surface,
        'morphs': [{'id': m.id, 'metadata': m.metadata} for m in morphs],
        'morph_spans': {m.id: [(n, {'metadata': sp.metadata}) for n, sp in m.fields.items()] for m in morphs},
        'morph_links': {m.id: [{'metadata': m.link.metadata}] for m in morphs if m.link is not None},
    })


def word_target(w: Word) -> bool:
    """A word a job analyses: one nobody has analysed (``unanalyzed``) and
    with no value in a word field, whatever its provenance (SPEC 6.1)."""
    return word_state(w) == 'unanalyzed' and not any(sp.value not in (None, '') for sp in w.fields.values())


def translation_field(project: IgtProject):
    return project.gloss_field('Sentence')


def _job_of(metadata) -> Optional[str]:
    return ((metadata or {}).get(PROV_DETAIL_KEY) or {}).get(JOB_DETAIL_KEY) \
        if isinstance((metadata or {}).get(PROV_DETAIL_KEY), dict) else None


def translation_state(s: Sentence, project: IgtProject, job_id: str) -> str:
    """``empty``, ``machine``, ``protected`` (the translation service's rule,
    ``sentence_state`` in plaid-igt/services/igt_translate_llm.py), or
    ``own`` for a translation this job wrote, never a target again."""
    f = translation_field(project)
    sp = s.fields.get(f.name) if f else None
    if sp is None or (sp.value or '') == '':
        return 'empty'
    if prov_state(sp.metadata) != 'machine':
        return 'protected'
    return 'own' if _job_of(sp.metadata) == job_id else 'machine'


def translation_target(s: Sentence, project: IgtProject, job_id: str) -> bool:
    return translation_state(s, project, job_id) in ('empty', 'machine')


def sentence_targets(s: Sentence, project: IgtProject, tasks, job_id: str) -> Tuple[List[Word], bool]:
    """The target words of ``s`` and whether its translation is a target."""
    words = [w for w in s.words if word_target(w)] if 'gloss' in tasks else []
    return words, ('translate' in tasks and translation_target(s, project, job_id))


def job_owned(w: Word, job_id: str) -> bool:
    """A word whose analysis is this job's own and still unverified: every
    piece ``word_state`` votes on names this job and none is confirmed. A
    word anyone has touched since is not."""
    if word_state(w) != 'machine':
        return False
    pieces = []
    for m in w.morphemes:
        if m.virtual:
            continue
        pieces.append(m.metadata)
        pieces += [sp.metadata for sp in m.fields.values()]
        if m.link is not None:
            pieces.append(m.link.metadata)
    pieces = [p for p in pieces if p and 'prov' in p]
    return bool(pieces) and all(_job_of(p) == job_id and not p.get(PROV_CONFIRMED_KEY) for p in pieces)


# --- an analysis as the decisions and harmonize key it -----------------------------

def word_analysis(w: Word, made: frozenset = frozenset()) -> Dict[str, Any]:
    """A word's analysis as CONTRACT 5.1 shapes it: its morphemes in order
    (form, type, "=", each field's value, the linked entry, ``made`` when the
    job created that entry here) and its word fields' values."""
    morphemes = []
    for m in w.morphemes:
        entry = m.link.item_id if m.link is not None else None
        morphemes.append({'form': _nfc(m.form), 'type': m.morph_type or None, 'equals': m.equals_before,
                          'fields': {n: _nfc(sp.value) for n, sp in sorted(m.fields.items())
                                     if sp.value not in (None, '')},
                          'entry': entry, 'made': bool(entry and entry in made)})
    return {'morphemes': morphemes,
            'word': {n: _nfc(sp.value) for n, sp in sorted(w.fields.items()) if sp.value not in (None, '')}}


def unmade(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """The analysis without ``made``, which harmonize compares by."""
    return {**analysis, 'morphemes': [{**m, 'made': False} for m in analysis['morphemes']]}


def rendering(analysis: Dict[str, Any], gloss: Optional[str], entries: Optional[Dict[str, str]] = None) -> str:
    """An analysis in one short readable line, ``ka-n=da ‘go-PST=3SG’``, with
    the entries it links where ``entries`` names them."""
    ms = analysis.get('morphemes') or []

    def joined(parts):
        out = ''
        for i, (m, p) in enumerate(zip(ms, parts)):
            out += ('' if i == 0 else '=' if m.get('equals') else '-') + p
        return out
    line = joined([m.get('form') or '_' for m in ms])
    if gloss and any(gloss in (m.get('fields') or {}) for m in ms):
        line += ' ‘' + joined([(m.get('fields') or {}).get(gloss) or '_' for m in ms]) + '’'
    linked = [entries.get(m['entry'], '?') for m in ms if m.get('entry')] if entries is not None else []
    if linked:
        line += ' (entries ' + ', '.join(linked) + ')'
    return line


# --- the job's workspace ---------------------------------------------------------

class Stretch:
    """The targets of one stretch: which words and translations may be
    written, and where every token of the document sits."""

    def __init__(self, doc, project: IgtProject, sentences: List[Sentence], tasks, job_id: str):
        self.sentence_ids = {s.id for s in sentences}
        self.words: Dict[str, Word] = {}
        self.translations: set = set()
        self.where: Dict[str, Sentence] = {}
        for s in doc.sentences:
            self.where[s.id] = s
            for w in s.words:
                self.where[w.id] = s
                for m in w.morphemes:
                    self.where[m.id] = s
        self.word_of: Dict[str, str] = {}
        for s in sentences:
            words, translate = sentence_targets(s, project, tasks, job_id)
            for w in words:
                self.words[w.id] = w
                for m in w.morphemes:
                    self.word_of[m.id] = w.id
            if translate:
                self.translations.add(s.id)

    def sentence_of(self, token_id: Optional[str]) -> Optional[Sentence]:
        if is_virtual(token_id):
            token_id = token_id.split(':', 1)[1]
        return self.where.get(token_id)

    def empty(self) -> bool:
        return not self.words and not self.translations


class JobWorkspace(Workspace):
    """The igt workspace with a job's guards on everything staged (SPEC 3.5,
    6.5): a change outside the stretch's target sentences, on a word or a
    translation that is not a target, a link of something other than a
    morpheme of a target word, an entry that exists already or one in a
    borrowed lexicon is refused at staging, every other guard of the
    workspace applying as well. ``stretch`` None (harmonize) asks nothing."""

    def __init__(self, client, project: IgtProject, tasks, stretch: Optional[Stretch] = None):
        super().__init__(client, project)
        self.tasks = list(tasks)
        self.stretch = stretch
        self.decide_now = False

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        if self.stretch is not None:
            self.job_guard(op)
        super().guard_op(op, replacing=replacing)

    def refuse_off_list(self, op: Dict[str, Any]) -> None:
        """Nothing: a job's values are unverified machine values, which no
        tagset refuses (core's value-set rule exempts them, SPEC 6.4). An
        off-list one is stored and shows as off-tagset, as every machine
        writer's does, and is never coerced to a listed one."""

    def _not_target(self, token_id: Optional[str], what: str) -> None:
        s = self.stretch.sentence_of(token_id)
        if s is None or s.id not in self.stretch.sentence_ids:
            where = f's{s.index}' if s is not None else 'That'
            raise ToolError(f'{where} is not one of the target sentences.', kind='not-allowed')
        raise ToolError(f'{what} in s{s.index} is not a target: leave it as it is.', kind='not-allowed')

    def job_guard(self, op: Dict[str, Any]) -> None:
        st = self.stretch
        kind = op.get('kind')
        if kind == 'set_span':
            f = self.project.field_by_layer(op.get('layer_id'))
            token = op.get('token_id')
            if f is not None and f.scope == 'Sentence':
                tf = translation_field(self.project)
                if 'translate' not in self.tasks or tf is None or f.layer_id != tf.layer_id \
                        or token not in st.translations:
                    self._not_target(token, f'The {f.name}')
                return
            word = st.word_of.get(token) if f is not None and f.scope == 'Morpheme' else token
            if word not in st.words:
                self._not_target(token, 'That word')
            return
        if kind == 'set_analysis':
            if op.get('word_id') not in st.words:
                self._not_target(op.get('word_id'), 'That word')
            return
        if kind == 'link':
            if 'link' not in self.tasks:
                raise ToolError('This job makes no lexicon links.', kind='not-allowed')
            word = op.get('analysis_word_id') or st.word_of.get(op.get('token_id'))
            if word not in st.words:
                if op.get('token_id') in st.words or st.sentence_of(op.get('token_id')) is None:
                    raise ToolError('Link the morphemes of the words you analyse (sN.wN.mN).', kind='not-allowed')
                self._not_target(op.get('token_id'), 'That morpheme')
            return
        if kind == 'create_entry':
            self.fit_guard(op)
            return
        raise ToolError('A job stages translations, analyses and lexicon links only.', kind='not-allowed')

    def fit_guard(self, op: Dict[str, Any]) -> None:
        """No entry is created where one fits: same form and gloss, after NFC,
        made by anyone, of any status, or staged earlier in this stretch
        (SPEC 7.2). Nor in a lexicon another project owns."""
        if 'link' not in self.tasks:
            raise ToolError('This job makes no lexicon entries.', kind='not-allowed')
        v = next((x for x in self.project.vocabs if x['id'] == op.get('vocab_id')), None)
        if v is None:
            return
        if v.get('borrowed'):
            raise ToolError(f'The lexicon "{v["name"]}" belongs to another project: link its entries and '
                            'create none in it.', kind='not-allowed')
        gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
        form = _nfc(op.get('form'))
        value = _nfc((op.get('metadata') or {}).get(gloss)) if gloss else ''
        for item in self.lexicon(v):
            if _nfc(item.get('form')) == form and _nfc((item.get('metadata') or {}).get(gloss)) == value:
                raise ToolError(f'{self.entry_name(item)} ‘{value}’ exists: link it.', kind='conflict')
        for o in self.ops:
            if o.get('kind') == 'create_entry' and o.get('vocab_id') == v['id'] and _nfc(o.get('form')) == form \
                    and _nfc((o.get('metadata') or {}).get(gloss)) == value:
                raise ToolError(f'"{form}" ‘{value}’ is staged already as entry_id {o.get("key")}: link it.',
                                kind='conflict')


# --- the runner --------------------------------------------------------------------

class Deferred(Exception):
    """The document is in use: put it off and come back later (SPEC 5.3)."""


class Gone(Exception):
    """The document is gone."""


def _status(e: BaseException) -> int:
    while e is not None:
        if isinstance(e, PlaidAPIError):
            return e.status or 0
        e = e.__cause__ or e.__context__
    return 0


class DiskRounds:
    """``--trace-dir``: each model call of a stretch written to a file of its
    own, as the assistant's ``RoundKeeper`` shapes a round, the system prompt
    and tools with the first. To disk only (the owner, SPEC question 2)."""

    def __init__(self, folder: str, system: str, tools: List[Dict[str, Any]]):
        os.makedirs(folder, exist_ok=True)
        self.folder = folder
        self.system, self.tools = system, tools
        self.text = self.thinking = ''
        self.trace: List[Dict[str, Any]] = []

    def follow(self, trace):
        self.trace = trace

    def think(self, text: str) -> None:
        self.thinking = text

    def store(self, rnd: Dict[str, Any]) -> bool:
        value = dict(rnd)
        if rnd.get('n') == 1:
            value.update(system=self.system, tools=self.tools)
        try:
            with open(os.path.join(self.folder, f'round-{rnd.get("n", 0):02d}-{rnd["id"]}.json'), 'w',
                      encoding='utf-8') as fh:
                json.dump(value, fh, ensure_ascii=False, indent=1)
        except OSError:
            logger.exception('A round could not be written to the trace folder')
            return False
        return True


class IgtRunner:
    """One job over interlinear text, run by ``core.job.run_job``."""

    WORK_PHASE = WORK_PHASE

    def __init__(self, job, cfg: ModelConfig, trace_dir: Optional[str] = None, count=None):
        self.job = job
        self.cfg = cfg
        self.trace_dir = trace_dir
        self.count = count
        self.version = agent_version([JOB_SYSTEM], toolkit.job_tools(['translate', 'gloss', 'link']))
        self.detail = {'model': cfg.model, 'version': self.version, JOB_DETAIL_KEY: job.id}
        self.source = job_source(cfg.model)
        self.names: Dict[str, str] = {}
        #: sentence id -> how many times its ops were dropped as changed
        self.changed: Counter = Counter()
        self.stretches = 0
        self.people: Optional[Dict[str, Any]] = None
        self.link_counts: Counter = Counter()

    # --- reading ---------------------------------------------------------------

    def project(self) -> IgtProject:
        return load_project(self.job.client(), self.job.project_id)

    def read(self, project: IgtProject, document_id: str, client=None):
        """The document as it is now, read afresh, or :class:`Gone`."""
        ws = Workspace(client or self.job.client(), project)
        try:
            doc = ws.load_doc(document_id)
        except PlaidAPIError as e:
            if e.status in (403, 404):
                raise Gone(document_id) from e
            raise
        self.names[document_id] = doc.name
        return doc

    # --- the checks (SPEC 3.2) -----------------------------------------------------

    def check(self, job) -> Optional[Tuple[str, str]]:
        if not job.token:
            return 'starter-access', 'The person who started this job can no longer write in this project.'
        project = self.project()
        tasks = job.tasks
        if 'translate' in tasks and translation_field(project) is None:
            return 'missing-field', 'The project has no translation field.'
        if 'gloss' in tasks and (not project.morpheme_layer_id or project.gloss_field('Morpheme') is None):
            return 'missing-field', 'The project has no morpheme gloss field.'
        if 'link' in tasks:
            if not project.vocabs:
                return 'no-lexicon', 'The project has no lexicon.'
            for v in project.vocabs:
                if not v.get('borrowed') and not IgtProject.lexicon_field(v, ROLE_STATUS):
                    return 'no-status-field', f'The lexicon "{v["name"]}" has no Status field.'
        size = manual_chars(project.guidelines)
        if size > JOB_GUIDELINES_MAX_CHARS:
            return 'guidelines-too-long', (f'The project\'s guidelines are {size:,} characters. A job reads at '
                                           f'most {JOB_GUIDELINES_MAX_CHARS:,}.')
        left = 0
        for d in job.order:
            row = job.rows.get(d) or {}
            if row.get('state') in ROW_FINAL:
                continue
            try:
                doc = self.read(project, d)
            except Gone:
                job.update_row(d, state='gone')
                continue
            skipped = list(row.get('skipped') or [])
            targets = 0
            for s in doc.sentences:
                words, translate = sentence_targets(s, project, tasks, job.id)
                if not words and not translate:
                    continue
                if len(render_sentence(s, project)) > JOB_SENTENCE_MAX_CHARS:
                    skipped.append({'sentence': f's{s.index}', 'sentence_id': s.id, 'reason': 'too-long',
                                    'kind': None})
                    continue
                targets += 1
            job.update_row(d, sentences=len(doc.sentences), targets=targets, done=row.get('done') or 0,
                           skipped=skipped, counts=row.get('counts') or empty_counts())
            left += 1
        if not left:
            return 'no-documents', 'None of the job\'s documents are left.'
        return None

    # --- the walk (SPEC 5.3) --------------------------------------------------------

    def work(self, job) -> None:
        deferred = []
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') in ROW_FINAL:
                continue
            if self.document(d) == 'deferred':
                deferred.append(d)
        while deferred:
            still = []
            for d in deferred:
                if self.document(d) == 'deferred':
                    if (job.rows.get(d) or {}).get('state') != 'in-use':
                        still.append(d)
            if still and len(still) == len(deferred):
                job.sleep(JOB_DEFER_WAIT_S)
            deferred = still

    def defer(self, document_id: str) -> str:
        row = self.job.rows.get(document_id) or {}
        defers = (row.get('defers') or 0) + 1
        self.job.update_row(document_id, defers=defers,
                            state='in-use' if defers >= JOB_DEFER_ROUNDS else 'deferred')
        return 'deferred'

    def in_use(self, client, document_id: str, job_ref: str) -> bool:
        """Someone else wrote in the document within the quiet window: a
        person, a service run, another job (SPEC 5.2)."""
        try:
            page = client.documents.audit_page(document_id, order='desc', limit=1) or {}
        except PlaidAPIError as e:
            if e.status in (403, 404):
                raise Gone(document_id) from e
            raise
        entries = page.get('entries') if isinstance(page, dict) else page
        if not entries:
            return False
        last = entries[0]
        if str(last.get('ref') or '').startswith(job_ref):
            return False
        when = core_job._iso_seconds(last.get('time') or last.get('timestamp') or last.get('created_at'))
        return when is not None and self.job.now() - when < JOB_PERSON_QUIET_S

    def document(self, document_id: str) -> str:
        """Work one document from its cursor: ``done``, ``deferred`` or
        ``gone``."""
        job = self.job
        job.check()
        job.set(current_document=document_id)
        try:
            project = self.project()
            self.people = None
            if (job.rows.get(document_id) or {}).get('state') != 'working':
                job.update_row(document_id, state='working')
            while True:
                job.check()
                client = job.client()
                if self.in_use(client, document_id, f'job:{job.id}/'):
                    return self.defer(document_id)
                doc = self.read(project, document_id, client)
                pending = self.pending(doc, project, document_id)
                if not pending:
                    job.update_row(document_id, state='done')
                    return 'done'
                total = (job.rows.get(document_id) or {}).get('targets') or 0
                done = (job.rows.get(document_id) or {}).get('done') or 0
                part = pending[:JOB_STRETCH_SENTENCES]
                job.set(message=f'Sentences {done + 1} to {min(done + len(part), max(total, done + len(part)))} '
                                f'of {max(total, done + len(part))}.')
                halve([s.id for s in part], lambda ids: self.attempt(project, document_id, ids),
                      lambda sid, kind: self.skip(document_id, doc, sid, 'failed', kind))
        except Deferred:
            return self.defer(document_id)
        except Gone:
            job.update_row(document_id, state='gone')
            return 'gone'

    def pending(self, doc, project: IgtProject, document_id: str) -> List[Sentence]:
        """The target sentences after the cursor, in document order. A cursor
        whose sentence is gone starts from the top (SPEC 3.8)."""
        row = self.job.rows.get(document_id) or {}
        skipped = {s.get('sentence_id') for s in row.get('skipped') or []}
        ids = [s.id for s in doc.sentences]
        start = ids.index(row['last_sentence']) + 1 if row.get('last_sentence') in ids else 0
        out = []
        for s in doc.sentences[start:]:
            if s.id in skipped:
                continue
            words, translate = sentence_targets(s, project, self.job.tasks, self.job.id)
            if words or translate:
                out.append(s)
        return out

    def skip(self, document_id: str, doc, sentence_id: str, reason: str, kind: Optional[str]) -> None:
        row = self.job.rows.get(document_id) or {}
        s = next((x for x in doc.sentences if x.id == sentence_id), None)
        skipped = list(row.get('skipped') or []) + [{
            'sentence': f's{s.index}' if s else '?', 'sentence_id': sentence_id, 'reason': reason, 'kind': kind}]
        fields = {'skipped': skipped, 'done': (row.get('done') or 0) + 1}
        if self._after_cursor(row, doc, sentence_id):
            fields['last_sentence'] = sentence_id
        self.job.update_row(document_id, **fields)

    @staticmethod
    def _after_cursor(row, doc, sentence_id) -> bool:
        ids = [s.id for s in doc.sentences]
        last = row.get('last_sentence')
        return last not in ids or sentence_id not in ids or ids.index(sentence_id) > ids.index(last)

    # --- one stretch ------------------------------------------------------------------

    def attempt(self, project: IgtProject, document_id: str, sentence_ids: List[str]) -> None:
        """One stretch, asked again for as long as the model is not answering
        (SPEC 3.7). A stop ends it with nothing written."""
        while True:
            try:
                self.stretch(project, document_id, sentence_ids)
                return
            except (StretchFailed, JobStopped, Deferred, Gone):
                raise
            except TurnCancelled:
                self.job.check()
                raise JobStopped('cancelled')
            except Exception as e:  # noqa: BLE001 - sorted into the kinds of SPEC 3.6 and 3.7
                if not_answering(e):
                    self.job.wait_for_model()
                    continue
                kind = failure_kind(e)
                if kind is None:
                    raise
                raise StretchFailed(kind, str(e)) from e

    def stretch(self, project: IgtProject, document_id: str, sentence_ids: List[str]) -> None:
        job = self.job
        job.check()
        client = job.client()
        ws = JobWorkspace(client, project, job.tasks)
        doc = self.read(project, document_id, client)
        ws._docs[document_id] = doc
        doc = ws.doc(document_id)
        part = [s for s in doc.sentences if s.id in sentence_ids]
        st = Stretch(doc, project, part, job.tasks, job.id)
        if st.empty():
            self.finished(project, document_id, doc, part, st, Counter(), [])
            return
        ws.stretch = st
        prints = {s.id: ws.sentence_print(doc, s) for s in part}
        system = build_job_prompt(project)
        message = self.message(ws, project, doc, part, st)
        transcript = [{'role': 'user', 'content': message}]
        seed(ws.seen, system, transcript, lambda tool, args: True)
        kit = Toolkit(tools_for=lambda w: toolkit.job_tools(job.tasks, plan_only=w.decide_now),
                      call_tool=lambda w, name, args: toolkit.job_call_tool(w, name, args, job.tasks),
                      tracer=TRACER)
        self.stretches += 1
        if self.trace_dir:
            ws.rounds = DiskRounds(os.path.join(self.trace_dir, job.id, document_id,
                                                f'stretch-{self.stretches:04d}'), system, kit.tools_for(ws))

        def before_call():
            job.check()
            job.yield_to_people()

        def decided():
            ws.decide_now = True
        pace = Pace(self.cfg.model, before_call=before_call, count=self.count, decided=decided)
        result = run_turn(self.cfg, kit, ws, system, transcript, cancelled=job.cancelled, pace=pace)
        if result.failure is not None:
            raise result.failure
        job.check()
        self.write(ws, project, document_id, doc, part, st, prints, list(ws.ops))

    def message(self, ws: JobWorkspace, project: IgtProject, doc, part: List[Sentence], st: Stretch) -> str:
        """What a stretch is handed (SPEC 3.4): the context and target
        sentences as read_sentences renders them, which words and
        translations are targets, how the forms were analysed before, the
        starter's note."""
        first = part[0].index
        context = [s for s in doc.sentences if first - JOB_CONTEXT_SENTENCES <= s.index < first]
        indexes = [s.index for s in context + part]
        rendered = ws.render(doc, indexes=indexes)
        lines = [f'Document "{doc.name}".', '', rendered, '']
        for s in part:
            words = [w for w in s.words if w.id in st.words]
            bits = []
            if words:
                bits.append('words ' + ', '.join(f'w{w.index} "{w.surface}"' for w in words))
            if s.id in st.translations:
                bits.append('the translation')
            if bits:
                lines.append(f'Targets in s{s.index}: ' + ' and '.join(bits) + '.')
        precedent = self.precedent(ws, project, list(st.words.values()))
        if precedent:
            lines += ['', precedent]
        if self.job.note:
            lines += ['', f'Instructions from {self.job.starter_name}:', self.job.note]
        refs = ', '.join(f's{s.index}' for s in part)
        context_refs = ', '.join(f's{s.index}' for s in context)
        lines += ['', f'Analyse {refs}.' + (f' {context_refs} {"is" if len(context) == 1 else "are"} context.'
                                             if context else '')]
        return '\n'.join(lines)

    # --- precedent ------------------------------------------------------------------

    def people_index(self, ws: Workspace, project: IgtProject) -> Dict[str, Dict[str, Any]]:
        """form -> {key: {analysis, count}} over every word people analysed
        in the project (``protected``), and the links to each entry seen, read
        once per document of the job (a walk of the project's documents)."""
        if self.people is not None:
            return self.people
        index: Dict[str, Dict[str, Any]] = {}
        self.link_counts: Counter = Counter()
        docs = ws.documents()
        ws.read_ahead(docs)
        for d in docs:
            try:
                doc = ws.doc(d['id'])
            except Exception:  # noqa: BLE001 - a document that cannot be read gives no precedent
                continue
            for s in doc.sentences:
                for w in s.words:
                    for m in w.morphemes:
                        if m.link is not None:
                            self.link_counts[m.link.item_id] += 1
                    if w.link is not None:
                        self.link_counts[w.link.item_id] += 1
                    if word_state(w) != 'protected':
                        continue
                    a = word_analysis(w)
                    text = canonical(a)
                    slot = index.setdefault(form_key(w.surface), {}).setdefault(analysis_key(text),
                                                                                {'analysis': a, 'count': 0})
                    slot['count'] += 1
        self.people = index
        return index

    def entry_forms(self, ws: Workspace, project: IgtProject) -> Dict[str, str]:
        out = {}
        for v in project.vocabs:
            try:
                for it in ws.lexicon(v):
                    out[it['id']] = it.get('form') or it['id']
            except PlaidAPIError:
                continue
        return out

    def precedent(self, ws: Workspace, project: IgtProject, words: List[Word]) -> str:
        if not words:
            return ''
        forms = list(dict.fromkeys(form_key(w.surface) for w in words))
        people = self.people_index(ws, project)
        mine: Dict[str, List[Dict[str, Any]]] = {}
        for row in self.job.lookup_decisions(forms):
            mine.setdefault(row.get('form'), []).append(row)
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        entries = self.entry_forms(ws, project) if 'link' in self.job.tasks else None
        blocks, left = [], 0
        size = 0
        for form in forms:
            bits = []
            theirs = sorted(people.get(form, {}).values(), key=lambda x: -x['count'])[:JOB_PRECEDENT_PER_FORM]
            if theirs:
                bits.append('people: ' + '; '.join(f'{rendering(x["analysis"], gloss, entries)} ({x["count"]})'
                                                  for x in theirs))
            ours = sorted(mine.get(form, []), key=lambda r: -(r.get('count') or 0))[:JOB_PRECEDENT_PER_FORM]
            if ours:
                bits.append('this job: ' + '; '.join(
                    f'{rendering(json.loads(r["analysis"]), gloss, entries)} ({r.get("count")})' for r in ours))
            if not bits:
                continue
            line = f'- "{form}": ' + ' | '.join(bits)
            if size + len(line) > JOB_PRECEDENT_CHARS:
                left += 1
                continue
            blocks.append(line)
            size += len(line) + 1
        if not blocks:
            return ''
        head = 'How these forms were analysed before (by people in this project, and earlier in this job):'
        tail = [f'and {left} more forms not shown'] if left else []
        return '\n'.join([head, *blocks, *tail])

    # --- the write (SPEC 5.4) --------------------------------------------------------

    def write(self, ws: JobWorkspace, project: IgtProject, document_id: str, doc, part: List[Sentence],
              st: Stretch, prints: Dict[str, str], ops: List[Dict[str, Any]]) -> None:
        job = self.job
        row = job.rows.get(document_id) or {}
        group = row.get('gloss_group')
        if not group:
            group = uuid7()
            job.update_row(document_id, gloss_group=group)
        ref = f'job:{job.id}/doc:{document_id}/pass:gloss'
        seed_id = uuid7()
        counts = Counter()
        written_ops: List[Dict[str, Any]] = []
        for tries in range(2):
            client = job.client()
            lock = None
            for i in range(JOB_LOCK_TRIES):
                try:
                    lock = locked_for_writes(client, document_id)
                    lock.__enter__()
                    break
                except PlaidAPIError as e:
                    lock = None
                    if e.status in (403, 404):
                        raise Gone(document_id) from e
                    if e.status != 423:
                        raise
                    if i + 1 < JOB_LOCK_TRIES:
                        job.sleep(JOB_LOCK_WAIT_S)
            if lock is None:
                raise Deferred(document_id)
            try:
                fresh = self.read(project, document_id, client)
                kept, counts, changed = self.recheck(ws, project, fresh, st, prints, ops)
                before = self.job_entries(ws, project)
                if kept:
                    self.machine_status(project, kept)
                    with client.operation(gloss_label(job.tasks), kind='job', ref=ref, group_id=group,
                                          keys={'seed': seed_id, 'stamps': {}}):
                        execute_plan(client, kept, source=self.source, label=gloss_label(job.tasks),
                                     project=project, stamp_mode='machine', detail=self.detail, seed=seed_id)
                written_ops = kept
            except PlanError as e:
                if _status(e) == 409 and tries == 0:
                    continue
                if _status(e) in (409, 423):
                    raise Deferred(document_id) from e
                raise
            finally:
                lock.__exit__(None, None, None)
            break
        after = self.read(project, document_id, client)
        made = frozenset(self.job_entries(Workspace(client, project), project) - before)
        self.finished(project, document_id, after, part, st, counts, written_ops, made, changed)

    def recheck(self, ws: JobWorkspace, project: IgtProject, fresh, st: Stretch, prints: Dict[str, str],
                ops: List[Dict[str, Any]]):
        """The ops that may still be written to ``fresh``: an op whose
        sentence changed since the stretch read it is dropped as
        ``changed``, one whose target is no longer a target as
        ``protected``, and an entry no kept link names is dropped with them."""
        counts = Counter()
        now = {s.id: s for s in fresh.sentences}
        fresh_st = Stretch(fresh, project, [s for s in fresh.sentences if s.id in st.sentence_ids], self.job.tasks,
                           self.job.id)
        changed = set()
        for sid, p in prints.items():
            s = now.get(sid)
            if s is None or ws.sentence_print(fresh, s) != p:
                changed.add(sid)
        kept = []
        for op in ops:
            kind = op.get('kind')
            if kind == 'create_entry':
                kept.append(op)
                continue
            token = op.get('analysis_word_id') or op.get('word_id') or op.get('token_id')
            s = st.sentence_of(token)
            if s is None or s.id in changed:
                counts['changed'] += 1
                continue
            if kind == 'set_span' and token in st.translations:
                ok = token in fresh_st.translations
            else:
                word = st.word_of.get(token, token)
                ok = word in fresh_st.words
            if not ok:
                counts['protected'] += 1
                continue
            kept.append(op)
        keys = {o.get('new_entry_key') for o in kept if o.get('kind') == 'link'}
        kept = [o for o in kept if o.get('kind') != 'create_entry' or o.get('key') in keys]
        return kept, counts, changed

    def machine_status(self, project: IgtProject, ops: List[Dict[str, Any]]) -> None:
        """Every entry the job creates carries Status ``machine``, whatever
        the model staged for it (SPEC 7.2)."""
        for op in ops:
            if op.get('kind') != 'create_entry':
                continue
            v = next((x for x in project.vocabs if x['id'] == op.get('vocab_id')), None)
            key = IgtProject.lexicon_field(v, ROLE_STATUS) if v else None
            if key:
                op['metadata'] = {**(op.get('metadata') or {}), key: MACHINE_STATUS}

    def job_entries(self, ws: Workspace, project: IgtProject) -> set:
        """The entries of the project's own lexicons this job made."""
        out = set()
        for v in project.vocabs:
            if v.get('borrowed'):
                continue
            ws._lexicons.pop(v['id'], None)
            for it in ws.lexicon(v):
                if _job_of(it.get('metadata')) == self.job.id:
                    out.add(it['id'])
        return out

    def finished(self, project: IgtProject, document_id: str, doc, part: List[Sentence], st: Stretch,
                 dropped: Counter, ops: List[Dict[str, Any]], made: frozenset = frozenset(),
                 changed=frozenset()) -> None:
        """After a stretch's write: the row's counts and cursor, then the
        decisions (SPEC 3.8, 7.3)."""
        job = self.job
        row = job.rows.get(document_id) or {}
        counts = {**empty_counts(), **(row.get('counts') or {})}
        counts['changed'] += dropped.get('changed', 0)
        counts['protected'] += dropped.get('protected', 0)
        now = {s.id: s for s in doc.sentences}
        translated = {o.get('token_id'): o for o in ops if o.get('kind') == 'set_span'}
        decisions: Dict[Tuple[str, str], Dict[str, Any]] = {}
        done = 0
        last = None
        retry = []
        for s in part:
            if s.id in changed:
                self.changed[s.id] += 1
                if self.changed[s.id] < 2:
                    retry.append(s.id)
                    continue
            cur = now.get(s.id, s)
            done += 1
            if not retry:
                last = s.id
            for w in cur.words:
                if w.id in st.words and job_owned(w, job.id):
                    counts['words'] += 1
                    a = word_analysis(w, made)
                    counts['links'] += sum(1 for m in a['morphemes'] if m['entry'])
                    text = canonical(a)
                    key = (form_key(w.surface), analysis_key(text))
                    slot = decisions.setdefault(key, {'form': key[0], 'key': key[1], 'analysis': text, 'count': 0,
                                                      'document_id': document_id, 'sentence_id': s.id})
                    slot['count'] += 1
                elif w.id in st.words and word_target(w):
                    counts['left'] += 1
            if s.id in st.translations:
                state = translation_state(cur, project, job.id)
                if state == 'own' and s.id in translated:
                    was = (translated[s.id].get('span_id') is not None)
                    counts['refreshed' if was else 'translations'] += 1
                else:
                    counts['left'] += 1
        counts['entries'] += len(made)
        fields = {'counts': counts, 'done': (row.get('done') or 0) + done}
        if retry:
            first = retry[0]
            ids = [x.id for x in doc.sentences]
            i = ids.index(first) if first in ids else 0
            before = ids[i - 1] if i > 0 else None
            if before is None or self._after_cursor(row, doc, before) or row.get('last_sentence') == before:
                fields['last_sentence'] = before
        elif last is not None and self._after_cursor(row, doc, last):
            fields['last_sentence'] = last
        for s in part:
            if s.id in changed and self.changed[s.id] >= 2:
                fields['skipped'] = list(fields.get('skipped') or row.get('skipped') or []) + [
                    {'sentence': f's{s.index}', 'sentence_id': s.id, 'reason': 'changed', 'kind': None}]
        job.update_row(document_id, **fields)
        if decisions:
            job.add_decisions(list(decisions.values()))

    # --- harmonize (SPEC 8) -------------------------------------------------------------

    def harmonize(self, job) -> Dict[str, Any]:
        if 'gloss' not in job.tasks:
            return {'changed': [], 'left': []}
        project = self.project()
        client = job.client()
        ws = Workspace(client, project)
        self.people = None
        people = self.people_index(ws, project)
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        # form -> key -> {analysis, words: [(document, word)]}
        mine: Dict[str, Dict[str, Dict[str, Any]]] = {}
        docs = {}
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') == 'gone':
                continue
            try:
                doc = self.read(project, d, client)
            except Gone:
                continue
            docs[d] = doc
            for s in doc.sentences:
                for w in s.words:
                    if not job_owned(w, job.id):
                        continue
                    a = unmade(word_analysis(w))
                    slot = mine.setdefault(form_key(w.surface), {}).setdefault(
                        analysis_key(canonical(a)), {'analysis': a, 'words': []})
                    slot['words'].append((d, w.id))
        changed, left = [], []
        rewrites: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
        for form, keys in sorted(mine.items()):
            if len(keys) < 2:
                continue
            theirs = {analysis_key(canonical(unmade(x['analysis']))): x for x in people.get(form, {}).values()}
            target, by = harmonized({k: len(v['words']) for k, v in keys.items()},
                                    {k: x['count'] for k, x in theirs.items()})
            if target is None:
                left.append({'form': form, 'reason': by,
                             'analyses': [{'analysis': rendering(v['analysis'], gloss), 'count': len(v['words'])}
                                          for v in keys.values()]})
                continue
            to = (keys.get(target) or theirs.get(target))['analysis']
            moved = []
            for k, v in keys.items():
                if k == target:
                    continue
                moved.append({'analysis': rendering(v['analysis'], gloss), 'count': len(v['words']),
                              'documents': sorted({d for d, _ in v['words']})})
                for d, wid in v['words']:
                    rewrites.setdefault(d, []).append((wid, to))
            changed.append({'form': form, 'to': rendering(to, gloss), 'by': by, 'from': moved})
        in_use_docs = []
        for d, words in rewrites.items():
            if not self.rewrite(project, d, words):
                in_use_docs.append(d)
        if in_use_docs:
            moved_forms = {c['form'] for c in changed if any(set(f['documents']) & set(in_use_docs)
                                                             for f in c['from'])}
            for c in changed:
                if c['form'] in moved_forms:
                    left.append({'form': c['form'], 'reason': 'in-use',
                                 'analyses': [{'analysis': f['analysis'], 'count': f['count']} for f in c['from']]})
        return {'changed': changed, 'left': left}

    def rewrite(self, project: IgtProject, document_id: str, words: List[Tuple[str, Dict[str, Any]]]) -> bool:
        """Set each of ``words`` to its target analysis, under the lock, as
        one History entry of its own. False when the document stayed in use."""
        job = self.job
        for attempt in range(JOB_DEFER_ROUNDS):
            client = job.client()
            if attempt:
                job.sleep(JOB_DEFER_WAIT_S)
            if self.in_use(client, document_id, f'job:{job.id}/'):
                continue
            row = job.rows.get(document_id) or {}
            group = row.get('harmonize_group')
            if not group:
                group = uuid7()
                job.update_row(document_id, harmonize_group=group)
            try:
                with locked_for_writes(client, document_id):
                    ws = Workspace(client, project)
                    doc = self.read(project, document_id, client)
                    ws._docs[document_id] = doc
                    doc = ws.doc(document_id)
                    for wid, to in words:
                        hit = doc.find(wid)
                        if not hit or hit[1] is None or not job_owned(hit[1], job.id):
                            continue
                        self.stage(ws, doc, hit[0], hit[1], to)
                    if ws.ops:
                        seed_id = uuid7()
                        with client.operation(HARMONIZE_LABEL, kind='job',
                                              ref=f'job:{job.id}/doc:{document_id}/pass:harmonize', group_id=group,
                                              keys={'seed': seed_id, 'stamps': {}}):
                            execute_plan(client, list(ws.ops), source=self.source, label=HARMONIZE_LABEL,
                                         project=project, stamp_mode='machine', detail=self.detail, seed=seed_id)
                return True
            except PlaidAPIError as e:
                if e.status in (403, 404):
                    return True
                if e.status != 423:
                    raise
            except PlanError as e:
                if _status(e) not in (409, 423):
                    raise
        return False

    @staticmethod
    def stage(ws: Workspace, doc, s: Sentence, w: Word, to: Dict[str, Any]) -> None:
        """Stage ``to`` on word ``w``: its analysis, its links, its word
        fields, through the tools, so every guard of theirs applies."""
        ref = f's{s.index}.w{w.index}'
        name = doc.name
        out = toolkit.call_tool(ws, 'set_analysis', {'document': name, 'ref': ref, 'morphemes': [
            {'form': m['form'], **({'type': m['type']} if m.get('type') else {}), 'equals': bool(m.get('equals')),
             'fields': dict(m.get('fields') or {})} for m in to['morphemes']]})
        if isinstance(out, Refusal):
            return
        for i, m in enumerate(to['morphemes'], start=1):
            if m.get('entry'):
                toolkit.call_tool(ws, 'link_entry', {'document': name, 'refs': [f'{ref}.m{i}'],
                                                     'entry_id': m['entry']})
        for field, value in (to.get('word') or {}).items():
            toolkit.call_tool(ws, 'set_field', {'document': name, 'refs': [ref], 'field': field, 'value': value})

    # --- the entries pass (SPEC 7.5) ------------------------------------------------------

    def entries(self, job) -> Dict[str, Any]:
        if 'link' not in job.tasks:
            return {'created': [], 'deleted': [], 'unlinked': []}
        project = self.project()
        client = job.client()
        ws = Workspace(client, project)
        self.people = None
        self.people_index(ws, project)
        links = self.link_counts
        maintains = job.starter in (project.roles.get('maintainers') or [])
        created, deleted, unlinked = [], [], []
        doomed = []
        for v in project.vocabs:
            if v.get('borrowed'):
                continue
            status = IgtProject.lexicon_field(v, ROLE_STATUS)
            gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
            for it in ws.lexicon(v):
                md = it.get('metadata') or {}
                if _job_of(md) != job.id:
                    continue
                entry = {'id': it['id'], 'lexicon': v['id'], 'form': it.get('form'),
                         'gloss': md.get(gloss) if gloss else None}
                if links.get(it['id']) or (status and md.get(status) != MACHINE_STATUS):
                    created.append(entry)
                elif maintains:
                    doomed.append(entry)
                else:
                    created.append(entry)
                    unlinked.append(entry)
        if doomed:
            with client.operation(ENTRIES_LABEL, kind='job', ref=f'job:{job.id}/pass:entries'):
                for e in doomed:
                    try:
                        client.vocab_items.delete(e['id'], expected_link_count=0)
                        deleted.append({k: e[k] for k in ('id', 'form', 'gloss')})
                    except PlaidAPIError as err:
                        logger.warning('Job %s: entry %s was kept: %s', job.id, e['id'], err)
                        created.append(e)
        return {'created': created, 'deleted': deleted, 'unlinked': unlinked}

    # --- the report (SPEC 9) --------------------------------------------------------------

    def document_reports(self, job) -> List[Dict[str, Any]]:
        out = []
        for d in job.order:
            row = job.rows.get(d) or {}
            state = row.get('state')
            out.append({'document_id': d, 'name': self.names.get(d) or row.get('name'),
                        'state': state if state in ('done', 'in-use', 'gone') else 'not-reached',
                        'sentences': row.get('sentences'), 'targets': row.get('targets'), 'done': row.get('done'),
                        'counts': row.get('counts') or empty_counts(), 'skipped': row.get('skipped') or [],
                        'gloss_group': row.get('gloss_group'), 'harmonize_group': row.get('harmonize_group')})
        return out


def runner_factory(cfg: ModelConfig, trace_dir: Optional[str] = None, count=None):
    """What the worker builds a claimed igt job's runner with."""
    return lambda job: IgtRunner(job, cfg, trace_dir=trace_dir, count=count)
