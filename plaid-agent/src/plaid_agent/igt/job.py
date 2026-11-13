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

from plaid_client import DocumentLockLost, PlaidAPIError
from plaid_client.ids import uuid7
from plaid_client.provenance import PROV_CONFIRMED_KEY, PROV_DETAIL_KEY, prov_state, service_source
from plaid_client.service import locked_for_writes
from plaid_client.workflows.igt.derive import word_state as _stored_word_state

from ..core import job as core_job
from ..core.agent import ModelConfig, Toolkit, TurnCancelled, run_turn
from ..core.garble import seed
from ..core.guidelines import manual_chars
from ..core.job import (BUDGET, ROW_FINAL, SKIPPED_MORE, JobStopped, Pace, StretchFailed, canonical, analysis_key,
                        empty_counts, failure_kind, halve, harmonized, not_answering)
from ..core.limits import (JOB_ANALYSIS_MAX_CHARS, JOB_CONTEXT_SENTENCES,
                           JOB_DECISIONS_PER_CALL, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S, JOB_GUIDELINES_MAX_CHARS,
                           JOB_LOCK_TRIES, JOB_LOCK_WAIT_S, JOB_PERSON_QUIET_S, JOB_PRECEDENT_CHARS,
                           JOB_PRECEDENT_PER_FORM, JOB_SENTENCE_MAX_CHARS, JOB_SKIPPED_PER_DOCUMENT,
                           JOB_STRETCH_SENTENCES)
from ..core.plan import JOB_DETAIL_KEY, PlanError, held_changes
from ..core.tools import Refusal, ToolError
from ..core.version import agent_version
from . import toolkit
from .plan import PlanOutOfDate, check_entries, execute_plan
from .project import IgtProject, Sentence, Word, is_virtual, load_project, render_sentence
from .prompt import JOB_SYSTEM, build_job_prompt
from .trace import TRACER
from .vocab import ROLE_GLOSS, ROLE_STATUS, references_to
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


#: The form of a sentence's record among the job's decisions: a space, then
#: words no word form has (a word never holds a space), then the sentence id.
RECORD_FORM = ' sentence '
#: The form of an entry the model staged and nothing linked (``propose``),
#: kept among the decisions the same way, so a resumed job still reports it.
PROPOSED_FORM = ' proposed '


def _n(n: int, word: str) -> str:
    return f'{n} {word}{"" if n == 1 else "s"}'


def mark_form(sentence_id: str) -> str:
    return RECORD_FORM + sentence_id


def mark_text(counts: Dict[str, int], document_id: str, left: List[Dict[str, Any]],
              words: Optional[Dict[str, str]] = None) -> str:
    """A sentence record's analysis: its counts, its document, the targets
    the job left blank in it (``left``) and what it wrote on each of its
    words it can vouch for (``words``, :func:`word_tag` to :func:`word_key`),
    as many as a decision's analysis holds (``JOB_ANALYSIS_MAX_CHARS``). The
    blanks are cut first (the counts say how many there were), then the
    words, and a word not listed is one harmonize leaves."""
    left = list(left)
    pairs = list((words or {}).items())
    while True:
        text = canonical({'counts': counts, 'document': document_id, 'left': left, 'words': dict(pairs)})
        if len(text) <= JOB_ANALYSIS_MAX_CHARS or not (left or pairs):
            return text
        if left:
            left.pop()
        else:
            pairs.pop()


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


def job_piece(metadata, job_id: str) -> bool:
    """THE protected-content rule (SPEC 6.5), in one place: a piece of
    content (a token's, a span's, a link's or an entry's metadata) is the
    job's to change only when this job wrote it and nobody has confirmed it.
    A person's piece (no provenance), a confirmed one, a contributed one and
    another producer's machine proposal are not. The stretch path, harmonize
    and the entries pass all ask this."""
    return prov_state(metadata) == 'machine' and _job_of(metadata) == job_id


def word_pieces(w: Word) -> List[Dict[str, Any]]:
    """Every piece of content on a word that an analysis of it would replace
    or sit beside: each stamped morpheme token, every span and link on a
    morpheme, every word-scope span (a word Gloss, a word POS) and the word's
    own link. A morpheme token with no stamp is the word's default
    morpheme, not content."""
    pieces = []
    for m in w.morphemes:
        if m.virtual:
            continue
        if (m.metadata or {}).get('prov') is not None:
            pieces.append(m.metadata)
        pieces += [sp.metadata for sp in m.fields.values()]
        if m.link is not None:
            pieces.append(m.link.metadata)
    pieces += [sp.metadata for sp in w.fields.values()]
    if w.link is not None:
        pieces.append(w.link.metadata)
    return pieces


def job_owned(w: Word, job_id: str) -> bool:
    """A word that is wholly this job's unverified work: it has an analysis,
    and every piece of content on it, its word fields included, is
    :func:`job_piece`. A word anyone else has written on since, a person or
    another producer, is not, and harmonize leaves it whole."""
    if word_state(w) != 'machine':
        return False
    pieces = word_pieces(w)
    return bool(pieces) and all(job_piece(p, job_id) for p in pieces)


#: Why harmonize leaves a word the job wrote on, as its report lists it
#: (CONTRACT, added by J-FIX-B and J-FIX-B2), and the word it never looks at.
TOUCHED, COMMENTED, IN_MWE, NOT_THE_JOBS = 'touched', 'commented', 'in-mwe', 'not-the-jobs'
#: A rewrite the staging refused (a guard of the tools), so nothing of the
#: word was written (REV-J-B2 S3-2).
REFUSED = 'refused'


def word_ids(w: Word) -> set:
    """Every id a comment on a word or on a piece of it is anchored to: the
    word, its morphemes, their spans and links, its word fields and link."""
    ids = {w.id} | {sp.id for sp in w.fields.values()} | ({w.link.id} if w.link is not None else set())
    for m in w.morphemes:
        if m.virtual:
            continue
        ids |= {m.id} | {sp.id for sp in m.fields.values()} | ({m.link.id} if m.link is not None else set())
    return ids


#: How many characters of a word's id and of its analysis key a sentence's
#: record keeps for each word the job vouches for (CONTRACT, added by J-FIX-B3).
WORD_KEY_CHARS = 12


def word_tag(word_id: str) -> str:
    """A word as its sentence's record names it: the end of its id, the
    random part of a UUIDv7, which tells the words of one sentence apart.
    A word keeps its id through edits around it, so the record follows the
    word itself and never the place it stands in."""
    return str(word_id)[-WORD_KEY_CHARS:]


def word_key(w: Word) -> str:
    """What harmonize compares a word with: the start of the key of its
    form and its analysis as CONTRACT 5.1 shapes it (nothing ``made``)."""
    return analysis_key(canonical([form_key(w.surface), word_analysis(w)]))[:WORD_KEY_CHARS]


def harmonize_bar(w: Word, job_id: str, recorded: Dict[str, str], commented: set) -> Optional[str]:
    """THE rule for what harmonize may rewrite (SPEC 6.5 and 8.1, the owner's
    rulings on REV-J-B2 S3-1 and REV-J-B3), in one place, asked when
    harmonize collects the job's words and again under the document's lock.
    None when the word is this job's to rewrite, else why it is left:

    * ``NOT_THE_JOBS``: nothing on it is this job's, so it is no business of
      harmonize's and is not listed,
    * ``touched``: something on it is not this job's own unverified work
      (:func:`job_owned`), or it is not what the job recorded it wrote ON
      THIS WORD (``recorded``, a word id to the :func:`word_key` its
      sentence's record holds for it). A word the job could not vouch for
      has no key there. So a piece a person deleted or changed is never put
      back, even when the job wrote what is left of the word elsewhere,
    * ``commented``: a comment hangs on the word or a piece of it
      (``commented``, the ids the document's comments are anchored to),
    * ``in-mwe``: the word is a member of a multi-word expression, which a
      job never makes."""
    pieces = word_pieces(w)
    if not any(job_piece(p, job_id) for p in pieces):
        return NOT_THE_JOBS
    if not job_owned(w, job_id) or recorded.get(w.id) != word_key(w):
        return TOUCHED
    if word_ids(w) & commented:
        return COMMENTED
    if any(not job_piece(link.metadata, job_id) for link in w.mwes):
        return IN_MWE
    return None


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


def harmonized_part(analysis: Dict[str, Any], tasks) -> Dict[str, Any]:
    """What harmonize compares an analysis by: the morphemes (form, type,
    "=", their fields) and, only for a job asked to link, their entries.
    Never ``made``, so a person's links never come along into a job that
    makes none. The word fields do not decide a form's analysis: they go
    with it (:meth:`IgtRunner.stage`)."""
    links = 'link' in tasks
    return {'morphemes': [{**m, 'made': False, 'entry': m.get('entry') if links else None}
                          for m in analysis['morphemes']], 'word': {}}


def chosen_word_fields(people: Counter, job: Counter) -> Dict[str, Any]:
    """The word fields that go with the analysis harmonize sets a form to
    (CONTRACT, added by J-FIX-B2), from counts of the canonical word fields
    of the words holding it: people's words' when people hold the analysis,
    else the job's words', the value most of them hold, the first in order
    on a tie."""
    counts = people or job
    return json.loads(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]) if counts else {}


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

    # What a staging tool says back, and the line every result ends with,
    # worded for a job: nothing waits for anyone, what is staged is written
    # when the stretch ends (REV-J-B S3-3). The chat's own say a person
    # approves a plan card and is told of it in a reply.

    tool_fault_next = 'Try another way of asking rather than the same call again.'

    def staged_count(self) -> int:
        return held_changes(self)

    def planned_note(self, n: int, what: Optional[str] = None) -> str:
        held = self.staged_count()
        return (f'Staged {what or _n(n, "change")}. {_n(held, "change")} staged in all, written when you end.'
                + self.superseded_note())

    def result_line(self) -> str:
        held = self.staged_count()
        return f'[Staged: {_n(held, "change")}.]' if held else '[Staged: nothing yet.]'

    def entry_id_note(self) -> str:
        made = 'create_entry, or a list of candidates' if 'link' in self.tasks else 'a list of candidates'
        return f'entry_id takes only an id a tool gave ({made}).'

    def unknown_new_entry(self, entry_id: str) -> str:
        return (f'No entry staged in this stretch has id {entry_id}. Name an entry made before it by its form, '
                'with its number if several share it ("gam#2"), as read_lexicon shows it.')

    @staticmethod
    def passes_up(e: BaseException) -> bool:
        """A tool's failure that is not the model's to hear of: core
        refusing the job's token or its access, busy or out of reach. The
        job's runner sorts it (``core_job.core_fault``). A request core
        refused (a 400, an id that names nothing) stays the model's."""
        err = core_job.plaid_error(e)
        if err is None:
            return False
        data = err.response_data if isinstance(err.response_data, dict) else {}
        return core_job.core_fault(err) in ('mine', 'passing') or err.status == 401 \
            or (err.status == 403 and not data.get('unresolved'))

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
    """The status of core's refusal in ``e`` or in what caused it (a lost
    lock's renewal included), else 0."""
    err = core_job.plaid_error(e)
    return (err.status or 0) if err is not None else 0


def _unresolved(e: BaseException) -> bool:
    """Core's 403 for something it no longer finds, to a reader who is not
    an administrator."""
    err = core_job.plaid_error(e)
    return bool(err is not None and isinstance(err.response_data, dict) and err.response_data.get('unresolved'))


def _gone_now(e: BaseException) -> bool:
    """A write refused for something it names being gone: a 404, or core's
    403 that names nothing."""
    return _status(e) == 404 or (_status(e) == 403 and _unresolved(e))


def out_of_date(client, project: IgtProject, op: Dict[str, Any]) -> bool:
    """Whether a link or an entry the job stages is out of date now: its
    entry gone, its lexicon no longer the project's. The plan's own check
    (``check_entries``), asked of this op alone. Core out of reach while
    checking is no answer: it goes up, for the walk to try again."""
    try:
        check_entries(client, [op], project)
    except PlanOutOfDate as e:
        if core_job.plaid_error(e) is not None:
            raise
        return True
    return False


def private_folders(folder: str) -> None:
    """Make ``folder`` and every missing folder above it, each readable by
    its owner alone (0700) whatever the umask. A folder that exists (the
    trace folder the operator named) is left as it is."""
    made = []
    path = os.path.abspath(folder)
    while path and not os.path.isdir(path):
        made.append(path)
        path = os.path.dirname(path)
    for path in reversed(made):
        os.makedirs(path, mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)


class DiskRounds:
    """``--trace-dir``: each model call of a stretch written to a file of its
    own, as the assistant's ``RoundKeeper`` shapes a round, the system prompt
    and tools with the first. To disk only (the owner, SPEC question 2)."""

    def __init__(self, folder: str, system: str, tools: List[Dict[str, Any]]):
        private_folders(folder)
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
            path = os.path.join(self.folder, f'round-{rnd.get("n", 0):02d}-{rnd["id"]}.json')
            # The operator's alone, whatever the umask: a round holds the
            # project's sentences and people's analyses (REV-J-B S3-6).
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(value, fh, ensure_ascii=False, indent=1)
        except OSError:
            logger.exception('A round could not be written to the trace folder')
            return False
        return True


def with_earlier(earlier: List[Dict[str, Any]], report: Dict[str, Any]) -> Dict[str, Any]:
    """Harmonize's ``report`` with the forms an earlier run of it in this
    worker changed (``earlier``, its ``changed``) added: per form, each
    analysis rewritten with its words counted once per run and the
    documents of both, the form set to as the latest run says."""
    if not earlier:
        return report
    by_form: Dict[str, Dict[str, Any]] = {}
    for c in list(earlier) + list(report['changed']):
        slot = by_form.setdefault(c['form'], {**c, 'from': []})
        slot.update({k: v for k, v in c.items() if k != 'from'})
        for f in c['from']:
            had = next((x for x in slot['from'] if x['analysis'] == f['analysis']), None)
            if had is None:
                slot['from'].append(dict(f))
            else:
                had['count'] += f['count']
                had['documents'] = sorted(set(had['documents']) | set(f['documents']))
    return {**report, 'changed': [by_form[f] for f in sorted(by_form)]}


def entries_part(created, deleted, unlinked, proposed=()) -> Dict[str, Any]:
    """The report's entries part (CONTRACT 5.3), its three lists uncut, with
    ``lexicons``: every lexicon the job created an entry in, in the order
    first met, so the job page links each one's machine drafts (J-INT), and
    ``proposed``: the entries the model staged that no link it kept named,
    which were not created (cut here, with ``proposed_more``)."""
    shown, more = core_job.cut(list(proposed))
    return {'created': created, 'deleted': deleted, 'unlinked': unlinked,
            'lexicons': list(dict.fromkeys(e['lexicon'] for e in created)),
            'proposed': shown, 'proposed_more': more}


class IgtRunner:
    """One job over interlinear text, run by ``core.job.run_job``."""

    WORK_PHASE = WORK_PHASE
    #: The entries part of a job that never reached its entries.
    NO_ENTRIES = entries_part([], [], [])

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
        #: this run of the job on this worker, the trace folder's own
        self.run_id = f'run-{uuid7()}'
        #: people's analyses as last read (``read_people``), and per document
        #: the version it was read at and its part of them
        self.people: Optional[Dict[str, Any]] = None
        self.people_read: Dict[str, Tuple[Any, Dict[str, Any]]] = {}
        #: what harmonize has written so far, for the report of a job stopped in it
        self.harmonize_done: Optional[Dict[str, Any]] = None
        #: document id -> the sentences whose record is in core (their marks)
        self.recorded: Dict[str, Dict[str, Dict[str, int]]] = {}
        #: (lexicon, form, gloss) -> an entry the model staged and nothing linked
        self.proposed: Dict[Tuple[Any, Any, Any], Dict[str, Any]] = {}
        #: documents the job has waited for once at least: their defers count
        self.waited: set = set()
        #: document id -> sentences skipped past the cap of the row's list:
        #: failed or changed, and too long for a stretch
        self.unlisted: Dict[str, set] = {}
        self.too_long: Dict[str, set] = {}
        #: document id -> counts of a stretch none of whose sentences was
        #: recorded yet (all taken again), added to the next record
        self.carry: Dict[str, Counter] = {}

    # --- reading ---------------------------------------------------------------

    def project(self) -> IgtProject:
        return load_project(self.job.client(), self.job.project_id)

    def read(self, project: IgtProject, document_id: str, client=None):
        """The document as it is now, read afresh, or :class:`Gone`."""
        ws = Workspace(client or self.job.client(), project)
        try:
            doc = ws.load_doc(document_id)
        except PlaidAPIError as e:
            raise self.refused(e, document_id) from e
        self.names[document_id] = doc.name
        return doc

    def refused(self, e: PlaidAPIError, document_id: str) -> Exception:
        """What a refusal of a document's read, lock or write means: the
        document is :class:`Gone` when core no longer finds it (404, or 403
        naming nothing, ``unresolved``), the job's right to write is gone
        on any other 403 or a 401 (``Job.access_lost``: the job fails
        ``starter-access``, and no document is called gone for it), and
        anything else is the refusal itself."""
        fault = core_job.core_fault(e)
        if fault == 'mine':
            return self.job.ended()
        if fault == 'access':
            return self.job.access_lost()
        data = e.response_data if isinstance(e.response_data, dict) else {}
        if e.status == 404 or (e.status == 403 and data.get('unresolved')):
            return Gone(document_id)
        return e

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
            # Checks run again after a crash in them meet the rows they wrote
            # (REV-J-B3 B3-5): a sentence listed already is not listed twice.
            listed = {x.get('sentence_id') for x in skipped}
            targets = 0
            for s in doc.sentences:
                words, translate = sentence_targets(s, project, tasks, job.id)
                if not words and not translate:
                    continue
                if len(render_sentence(s, project)) > JOB_SENTENCE_MAX_CHARS:
                    if s.id in listed:
                        continue
                    if len(skipped) < JOB_SKIPPED_PER_DOCUMENT:
                        skipped.append({'sentence': f's{s.index}', 'sentence_id': s.id, 'reason': 'too-long',
                                        'kind': None})
                    else:
                        self.too_long.setdefault(d, set()).add(s.id)
                    continue
                targets += 1
            counts = {**empty_counts(), **(row.get('counts') or {})}
            if self.too_long.get(d):
                counts[SKIPPED_MORE] = len(self.too_long[d])
            job.update_row(d, sentences=len(doc.sentences), targets=targets, done=row.get('done') or 0,
                           skipped=skipped, counts=counts)
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
            # Every pass over put-off documents waits the quiet window first,
            # and says what it waits for (REV-J-B S3-5).
            self.wait_for_people(deferred)
            self.waited.update(deferred)
            still = []
            for d in deferred:
                if self.document(d) == 'deferred':
                    if (job.rows.get(d) or {}).get('state') != 'in-use':
                        still.append(d)
            deferred = still

    def wait_for_people(self, documents: List[str]) -> None:
        """Wait :data:`JOB_DEFER_WAIT_S` before taking ``documents`` again,
        saying so: what for, and how long, never a clock time (whose clock is
        the worker's, not the reader's)."""
        job = self.job
        name = self.names.get(documents[0]) or (job.rows.get(documents[0]) or {}).get('name')
        where = (f'"{name}"' if name else 'a document') if len(documents) == 1 else f'{len(documents)} documents'
        minutes = round(JOB_DEFER_WAIT_S / 60)
        said = job.status.get('message')
        job.set(current_document=None,
                message=f'Waiting for people to finish in {where}. Trying again in {minutes} minutes.')
        try:
            job.sleep(JOB_DEFER_WAIT_S)
        finally:
            if not job.lost:
                job.set(message=said)

    def defer(self, document_id: str) -> str:
        """Put a document off. A defer counts only after the job has waited
        for it (:meth:`wait_for_people`): a document in use is waited for
        JOB_DEFER_ROUNDS times before it ends ``in-use`` (SPEC 5.3), never
        counted twice within a second by passes with no wait between."""
        row = self.job.rows.get(document_id) or {}
        defers = (row.get('defers') or 0) + (1 if document_id in self.waited else 0)
        self.job.update_row(document_id, defers=defers,
                            state='in-use' if defers >= JOB_DEFER_ROUNDS else 'deferred')
        return 'deferred'

    def newest_change(self, client, document_id: str) -> Optional[Dict[str, Any]]:
        """The newest unit of the document's History, or None. Core places a
        unit by its newest operation, so this is whoever wrote last."""
        try:
            page = client.documents.audit_page(document_id, order='desc', limit=1) or {}
        except PlaidAPIError as e:
            raise self.refused(e, document_id) from e
        entries = page.get('entries') if isinstance(page, dict) else page
        return entries[0] if entries else None

    def in_use(self, last: Optional[Dict[str, Any]], job_ref: str) -> bool:
        """Someone else wrote in the document within the quiet window, since
        the job was made: a person, a service run, another job (SPEC 5.2).
        ``last`` is the document's :meth:`newest_change`."""
        if not last:
            return False
        if str(last.get('ref') or '').startswith(job_ref):
            return False
        when = core_job._iso_seconds(last.get('time') or last.get('timestamp') or last.get('created_at'))
        if when is None:
            return False
        # Only what was written after the job was made counts: the edit its
        # starter made just before pressing Start is not a person in the
        # document (both times are core's, REV-J-B S3-5).
        created = core_job._iso_seconds(self.job.job.get('created_at'))
        if created is not None and when <= created:
            return False
        return self.job.now() - when < JOB_PERSON_QUIET_S

    def document(self, document_id: str) -> str:
        """Work one document from its cursor: ``done``, ``deferred`` or
        ``gone``.

        A refusal of core is never the model's: the job's own end
        (:func:`core_job.no_longer_mine`) stops it, core busy or out of reach
        is tried again (:func:`core_job.through_core`, the row of a document
        put off or gone included) and the document is then put off, and
        anything else goes up to end the job (``worker-error``)."""
        job = self.job
        job.check()
        job.set(current_document=document_id)

        def step():
            try:
                return self.walk(document_id)
            except Deferred:
                return self.defer(document_id)
            except Gone:
                job.update_row(document_id, state='gone')
                return 'gone'
        try:
            return core_job.through_core(job, step, gave_up=lambda: core_job.through_core(
                job, lambda: self.defer(document_id)))
        except Exception as e:  # noqa: BLE001 - core's refusals sorted, the rest goes up
            fault = core_job.core_fault(e)
            if fault == 'mine':
                raise job.ended() from e
            if fault == 'access':
                raise job.access_lost() from e
            raise

    def walk(self, document_id: str) -> str:
        job = self.job
        project = self.project()
        self.read_people(project)
        if (job.rows.get(document_id) or {}).get('state') != 'working':
            job.update_row(document_id, state='working')
        while True:
            job.check()
            client = job.client()
            # The document first, then its History: when the newest change
            # is still the job's own glossing, nothing was written between
            # that change and this read, so what the job wrote and did not
            # record is exactly as it wrote it (``settle``).
            doc = self.read(project, document_id, client)
            last = self.newest_change(client, document_id)
            if self.in_use(last, f'job:{job.id}/'):
                return self.defer(document_id)
            self.settle(project, document_id, doc,
                        own=str((last or {}).get('ref') or '') == self.gloss_ref(document_id))
            pending = self.pending(doc, project, document_id)
            if not pending:
                job.update_row(document_id, state='done')
                return 'done'
            row = job.rows.get(document_id) or {}
            total, done = row.get('targets') or 0, row.get('done') or 0
            part = pending[:JOB_STRETCH_SENTENCES]
            last = done + len(part)
            job.set(message=f'Sentences {done + 1} to {last} of {max(total, last)}.')
            halve([s.id for s in part], lambda ids: self.attempt(project, document_id, ids),
                  lambda sid, kind: self.skip(document_id, doc, sid, 'failed', kind))

    def pending(self, doc, project: IgtProject, document_id: str) -> List[Sentence]:
        """The target sentences after the cursor, in document order, less
        those skipped and those recorded already. A cursor whose sentence is
        gone starts from the top (SPEC 3.8)."""
        row = self.job.rows.get(document_id) or {}
        skipped = {s.get('sentence_id') for s in row.get('skipped') or []}
        recorded = self.recorded.get(document_id) or {}
        skipped |= (self.unlisted.get(document_id) or set()) | (self.too_long.get(document_id) or set())
        ids = [s.id for s in doc.sentences]
        start = ids.index(row['last_sentence']) + 1 if row.get('last_sentence') in ids else 0
        out = []
        for s in doc.sentences[start:]:
            if s.id in skipped or s.id in recorded:
                continue
            words, translate = sentence_targets(s, project, self.job.tasks, self.job.id)
            if words or translate:
                out.append(s)
        return out

    def skip(self, document_id: str, doc, sentence_id: str, reason: str, kind: Optional[str]) -> None:
        """List a sentence skipped, or once the row's list holds
        :data:`JOB_SKIPPED_PER_DOCUMENT`, count it past the list (core keeps
        no more), and move the cursor past it."""
        row = self.job.rows.get(document_id) or {}
        s = next((x for x in doc.sentences if x.id == sentence_id), None)
        skipped = list(row.get('skipped') or [])
        fields: Dict[str, Any] = {}
        if len(skipped) < JOB_SKIPPED_PER_DOCUMENT:
            skipped.append({'sentence': f's{s.index}' if s else '?', 'sentence_id': sentence_id, 'reason': reason,
                            'kind': kind})
            fields['skipped'] = skipped
        else:
            self.unlisted.setdefault(document_id, set()).add(sentence_id)
        if self._after_cursor(row, doc, sentence_id):
            fields['last_sentence'] = sentence_id
        self.job.update_row(document_id, **fields, **self.tally(document_id, skipped))

    @staticmethod
    def _after_cursor(row, doc, sentence_id) -> bool:
        ids = [s.id for s in doc.sentences]
        last = row.get('last_sentence')
        return last not in ids or sentence_id not in ids or ids.index(sentence_id) > ids.index(last)

    # --- one stretch ------------------------------------------------------------------

    def attempt(self, project: IgtProject, document_id: str, sentence_ids: List[str]) -> None:
        """One stretch: the model's work, asked again for as long as the model
        is not answering (SPEC 3.7), and then its write. Only a failure of the
        model's work is the stretch's (:class:`StretchFailed`, halved). The
        write, the row and the decisions come after the model has finished,
        and nothing that goes wrong there is told as the model's."""
        while True:
            try:
                staged = self.model_work(project, document_id, sentence_ids)
                break
            except (StretchFailed, JobStopped, Deferred, Gone):
                raise
            except TurnCancelled:
                self.job.check()
                raise JobStopped('cancelled')
            except Exception as e:  # noqa: BLE001 - sorted into the kinds of SPEC 3.6 and 3.7
                if core_job.core_fault(e) is not None:
                    raise
                if not_answering(e):
                    self.job.wait_for_model()
                    continue
                kind = failure_kind(e)
                if kind is None:
                    raise
                raise StretchFailed(kind, str(e)) from e
        if staged is not None:
            self.write(project, document_id, *staged)

    def model_work(self, project: IgtProject, document_id: str, sentence_ids: List[str]):
        """The model's part of a stretch: what it staged, with what the write
        needs, or None when the stretch had nothing left to do."""
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
            self.record(project, document_id, doc, part, st, Counter(), [])
            return None
        ws.stretch = st
        prints = {s.id: ws.sentence_print(doc, s) for s in part}
        system = build_job_prompt(project, job.tasks)
        message = self.message(ws, project, doc, part, st)
        transcript = [{'role': 'user', 'content': message}]
        seed(ws.seen, system, transcript, lambda tool, args: True)
        kit = Toolkit(tools_for=lambda w: toolkit.job_tools(job.tasks, plan_only=w.decide_now),
                      call_tool=lambda w, name, args: toolkit.job_call_tool(w, name, args, job.tasks),
                      tracer=TRACER)
        self.stretches += 1
        if self.trace_dir:
            # A folder per run of the worker, so a resumed job's stretches,
            # numbered from 1 again, never mix with the first run's.
            ws.rounds = DiskRounds(os.path.join(self.trace_dir, job.id, self.run_id, document_id,
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
        return ws, doc, part, st, prints, list(ws.ops)

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
        verb = 'Analyse' if 'gloss' in self.job.tasks else 'Translate'
        lines += ['', f'{verb} {refs}.' + (f' {context_refs} {"is" if len(context) == 1 else "are"} context.'
                                           if context else '')]
        return '\n'.join(lines)

    # --- precedent ------------------------------------------------------------------

    def people_index(self, ws: Workspace, project: IgtProject) -> Dict[str, Dict[str, Any]]:
        """form -> {key: {analysis, count}} over every word people analysed
        in the project (``protected``), as :meth:`read_people` last read it,
        read now when it never was."""
        if self.people is None:
            self.read_people(project)
        return self.people

    def read_people(self, project: IgtProject) -> None:
        """Read people's analyses as the project is now (REV-J-B2 S2-1): as
        each document's walk begins, so a stretch sees a correction a person
        made since the job started, and as harmonize begins, so it decides
        by people's work as it is then. Each read lists the project's
        documents (one request) and reads again only those whose version
        moved since they were read last (the job's own writes and people's),
        never the whole project twice (REV-J-B S3-10)."""
        ws = Workspace(self.job.client(), project)
        listed = ws.documents()
        stale = [d for d in listed if d.get('version') is None
                 or (self.people_read.get(d['id']) or (None,))[0] != d.get('version')]
        ws.read_ahead(stale)
        for d in stale:
            try:
                doc = ws.doc(d['id'])
            except Exception as e:  # noqa: BLE001 - a document that cannot be read gives no precedent
                if core_job.core_fault(e) in ('mine', 'access', 'passing'):
                    raise
                self.people_read.pop(d['id'], None)
                continue
            self.people_read[d['id']] = (d.get('version'), self.people_of(doc))
        listed_ids = {d['id'] for d in listed}
        index: Dict[str, Dict[str, Any]] = {}
        for did, (_, part) in self.people_read.items():
            if did not in listed_ids:
                continue
            for form, keys in part.items():
                for key, x in keys.items():
                    slot = index.setdefault(form, {}).setdefault(key, {'analysis': x['analysis'], 'count': 0})
                    slot['count'] += x['count']
        self.people = index

    @staticmethod
    def people_of(doc) -> Dict[str, Dict[str, Any]]:
        """One document's part of the index: form -> {key: {analysis,
        count}} over its words people analysed."""
        part: Dict[str, Dict[str, Any]] = {}
        for s in doc.sentences:
            for w in s.words:
                if word_state(w) != 'protected':
                    continue
                a = word_analysis(w)
                slot = part.setdefault(form_key(w.surface), {}).setdefault(analysis_key(canonical(a)),
                                                                           {'analysis': a, 'count': 0})
                slot['count'] += 1
        return part

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

    def write(self, project: IgtProject, document_id: str, ws: JobWorkspace, doc, part: List[Sentence],
              st: Stretch, prints: Dict[str, str], ops: List[Dict[str, Any]]) -> None:
        """The stretch's write under the document's lock (SPEC 5.4), then its
        record (:meth:`record`). Safe to do again after a failure anywhere in
        it: a word written is no longer a target, a translation written is
        the job's own, and a sentence recorded is not recorded again."""
        job = self.job
        row = job.rows.get(document_id) or {}
        group = row.get('gloss_group')
        if not group:
            group = uuid7()
            job.update_row(document_id, gloss_group=group)
        for tries in range(2):
            # Keys of its own for each try (REV-J-B3 B3-8): a try never
            # sends a request under a key an earlier try's request used.
            seed_id = uuid7()
            client = job.client()
            lock = self.hold(client, document_id)
            try:
                try:
                    written_ops, counts, changed, after, vouched = self.write_held(
                        project, document_id, client, ws, st, prints, ops, group, seed_id)
                finally:
                    lock.__exit__(None, None, None)
            except DocumentLockLost as e:
                # The lock lapsed as the write ended (REV-J-B3 B3-4): put off
                # as any lock conflict, what landed recorded when it comes back.
                raise Deferred(document_id) from e
            except PlanError as e:
                # The starter's own browser wrote between the read under the
                # lock and the write (strict mode): taken again at once when
                # nothing of it landed. Sent again after a batch had landed, it
                # would send other requests under that batch's keys, which core
                # refuses (422 idempotency-key-reused, REV-J-B3 B3-8). When a batch of it had landed, the
                # document is put off: it is recorded when it comes back, as
                # an interrupted write is (``settle``), never vouched for past
                # the person's edit (REV-J-B3 B3-2).
                if _status(e) == 409 and tries == 0 and not (e.applied or e.unknown):
                    continue
                # A conflict, or something the write names gone in the moment
                # since the check (the document, an entry): put off, and the
                # next walk reads what is there (REV-J-B3 B3-3).
                # A lock lost in the write is a 423 (its renewal's refusal,
                # REV-J-B3 B3-4).
                if _status(e) in (409, 423) or _gone_now(e):
                    raise Deferred(document_id) from e
                raise
            break
        # The write landed: the entries the model staged that it did not
        # create are reported as proposed, never before (REV-J-B2 S4).
        for o in ops:
            if o.get('kind') == 'create_entry' and not any(o is w for w in written_ops):
                self.propose(project, o)
        made = self.made_entries(ws, after, st, written_ops)
        self.record(project, document_id, after, part, st, counts, written_ops, made, changed, vouched)

    def gloss_ref(self, document_id: str) -> str:
        return f'job:{self.job.id}/doc:{document_id}/pass:gloss'

    def hold(self, client, document_id: str):
        """The document's lock with strict mode (``locked_for_writes``),
        entered, after up to JOB_LOCK_TRIES tries, else :class:`Deferred`."""
        for i in range(JOB_LOCK_TRIES):
            try:
                lock = locked_for_writes(client, document_id)
                lock.__enter__()
                return lock
            except PlaidAPIError as e:
                if e.status != 423:
                    raise self.refused(e, document_id) from e
                if i + 1 < JOB_LOCK_TRIES:
                    self.job.sleep(JOB_LOCK_WAIT_S)
        raise Deferred(document_id)

    def write_held(self, project: IgtProject, document_id: str, client, ws: JobWorkspace, st: Stretch,
                   prints: Dict[str, str], ops: List[Dict[str, Any]], group: str, seed_id: str):
        """The write, the lock held: the stretch's ops checked again against
        the document as it is (:meth:`recheck`), written, and the document
        read again BEFORE the lock goes. ``(written ops, dropped counts,
        changed sentences, the document after, the words vouched for)``.

        The words vouched for are those the job knows it wrote exactly as
        they now read (REV-J-B3 B3-1, B3-2): targets still blank as the lock
        was taken, in a document whose version is still the one the job's
        own last batch left (strict mode moves the client's version with
        each of the job's writes, and under the lock only the starter's own
        browser could write besides). Any other write since, and none is
        vouched for: their sentence is recorded without their keys, and
        harmonize leaves them."""
        job = self.job
        fresh = self.read(project, document_id, client)
        kept, counts, changed = self.recheck(ws, project, fresh, st, prints, ops)
        blank = {w.id for s in fresh.sentences if s.id in st.sentence_ids and s.id not in changed
                 for w in s.words if w.id in st.words and word_target(w)}
        if kept:
            self.machine_status(project, kept)
            kept = self.apply(client, project, document_id, group, kept, seed_id, counts)
        known = client.document_versions.get(document_id)
        after = self.read(project, document_id, client)
        exact = known is not None and str(after.version) == str(known)
        if not exact:
            logger.info('Job %s: %s moved during the write (version %s, read %s): its words are not vouched for',
                        job.id, document_id, known, after.version)
        return kept, counts, changed, after, frozenset(blank) if exact else frozenset()

    def apply(self, client, project: IgtProject, document_id: str, group: str, kept: List[Dict[str, Any]],
              seed_id: str, counts: Counter) -> List[Dict[str, Any]]:
        """Write ``kept`` as one more part of the document's glossing entry.
        A link to an entry gone since the model read it (deleted, merged
        away, its lexicon taken out of the project) is dropped as
        ``changed`` and the rest is written (SPEC 12, REV-J-B3 B3-3): the
        plan's own check, asked again of each link and entry alone, says
        which. An entry that nothing kept links is not created. A plan still
        out of date after that, or one whose ops are none of them out of date
        alone, puts the document off. The ops written."""
        label = gloss_label(self.job.tasks)
        for n in range(2):
            try:
                with client.operation(label, kind='job', ref=self.gloss_ref(document_id), group_id=group,
                                      keys={'seed': seed_id, 'stamps': {}}):
                    execute_plan(client, kept, source=self.source, label=label, project=project,
                                 stamp_mode='machine', detail=self.detail, seed=seed_id)
                return kept
            except PlanOutOfDate as e:
                # Raised before anything is written. Core out of reach while
                # checking is core's trouble: it goes up, the walk is tried again.
                if core_job.plaid_error(e) is not None:
                    raise
                gone = {id(o) for o in kept if o.get('kind') in ('link', 'create_entry')
                        and out_of_date(client, project, o)} if n == 0 else set()
                if not gone:
                    raise Deferred(document_id) from e
                logger.info('Job %s: links or entries out of date in %s are dropped: %s', self.job.id, document_id, e)
                unmade = {o.get('key') for o in kept if id(o) in gone and o.get('kind') == 'create_entry'}
                rest = [o for o in kept if id(o) not in gone
                        and not (o.get('kind') == 'link' and o.get('new_entry_key') in unmade)]
                left = {id(o) for o in rest}
                counts['changed'] += sum(1 for o in kept if o.get('kind') == 'link' and id(o) not in left)
                linked = {o.get('new_entry_key') for o in rest if o.get('kind') == 'link'}
                kept = [o for o in rest if o.get('kind') != 'create_entry' or o.get('key') in linked]
                if not kept:
                    return kept
        return kept

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
        # An entry no kept link names is not created: it is reported as
        # proposed once the stretch's write has landed (``write``).
        keys = {o.get('new_entry_key') for o in kept if o.get('kind') == 'link'}
        kept = [o for o in kept if o.get('kind') != 'create_entry' or o.get('key') in keys]
        return kept, counts, changed

    def propose(self, project: IgtProject, op: Dict[str, Any]) -> None:
        """An entry the model staged that nothing it kept links: not
        created (a job writes no entry nobody uses), and listed in the
        report so a person sees what the model wanted (J-INT 4)."""
        v = next((x for x in project.vocabs if x['id'] == op.get('vocab_id')), None)
        gloss = IgtProject.lexicon_field(v, ROLE_GLOSS) if v else None
        entry = {'lexicon': op.get('vocab_id'), 'form': op.get('form'),
                 'gloss': (op.get('metadata') or {}).get(gloss) if gloss else None}
        k = (entry['lexicon'], entry['form'], entry['gloss'])
        if k in self.proposed:
            return
        self.proposed[k] = entry
        text = canonical(entry)
        key = analysis_key(text)
        self.job.add_decisions([{'form': PROPOSED_FORM + key, 'key': key, 'analysis': text, 'count': 1,
                                 'document_id': None, 'sentence_id': None}])

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

    @staticmethod
    def made_entries(ws: JobWorkspace, doc, st: Stretch, ops: List[Dict[str, Any]]) -> frozenset:
        """The entries this stretch created: those its target words now link
        to that were not in the lexicon as the stretch read it (a create is
        staged only after its lexicon was read, ``fit_guard``). No read of
        the lexicon is made for it (REV-J-B S3-10)."""
        if not any(o.get('kind') == 'create_entry' for o in ops):
            return frozenset()
        known = {it['id'] for items in ws._lexicons.values() for it in items}
        linked = {m.link.item_id for s in doc.sentences for w in s.words if w.id in st.words
                  for m in w.morphemes if m.link is not None}
        return frozenset(linked - known)

    # --- the record of a stretch (SPEC 3.8, 7.3) ---------------------------------------

    def record(self, project: IgtProject, document_id: str, doc, part: List[Sentence], st: Stretch,
               dropped: Counter, ops: List[Dict[str, Any]], made: frozenset = frozenset(),
               changed=frozenset(), vouched=frozenset()) -> None:
        """After a stretch's write: each finished sentence's counts and
        decisions, stored once (:meth:`commit`), and the row's cursor.
        ``vouched``: the words the job knows it wrote as ``doc`` reads them
        (:meth:`write_held`)."""
        job = self.job
        row = job.rows.get(document_id) or {}
        now = {s.id: s for s in doc.sentences}
        translated = {o.get('token_id'): o for o in ops if o.get('kind') == 'set_span'}
        extra = self.carry.pop(document_id, Counter())
        extra['changed'] += dropped.get('changed', 0)
        extra['protected'] += dropped.get('protected', 0)
        extra['entries'] += len(made)
        records = []
        last = None
        retry = []
        skipped = list(row.get('skipped') or [])
        for s in part:
            if s.id in changed:
                self.changed[s.id] += 1
                if self.changed[s.id] < 2:
                    retry.append(s.id)
                    continue
                skipped.append({'sentence': f's{s.index}', 'sentence_id': s.id, 'reason': 'changed', 'kind': None})
                if not retry:
                    last = s.id
                continue
            if not retry:
                last = s.id
            cur = now.get(s.id, s)
            words = [w for w in cur.words if w.id in st.words]
            translation = None
            if s.id in st.translations:
                state = translation_state(cur, project, job.id)
                if state == 'own' and s.id in translated:
                    translation = 'refreshed' if translated[s.id].get('span_id') is not None else 'translations'
                else:
                    translation = 'left' if state in ('empty', 'machine') else None
            records.append(self.sentence_record(document_id, cur, words, translation, made, vouched))
        if records:
            for k, n in extra.items():
                records[0]['counts'][k] = records[0]['counts'].get(k, 0) + n
        elif any(extra.values()):
            self.carry[document_id] = extra
        fields: Dict[str, Any] = {}
        if retry:
            first = retry[0]
            ids = [x.id for x in doc.sentences]
            i = ids.index(first) if first in ids else 0
            before = ids[i - 1] if i > 0 else None
            if before is None or self._after_cursor(row, doc, before) or row.get('last_sentence') == before:
                fields['last_sentence'] = before
        elif last is not None and self._after_cursor(row, doc, last):
            fields['last_sentence'] = last
        if len(skipped) != len(row.get('skipped') or []):
            fields['skipped'] = skipped
        self.commit(document_id, records, fields)

    def sentence_record(self, document_id: str, s: Sentence, words: List[Word], translation: Optional[str],
                        made: frozenset = frozenset(), vouched=frozenset()) -> Dict[str, Any]:
        """One sentence's part of a stretch's record: what the job wrote on
        ``words`` (those of them now the job's own), what it left blank of
        them, the translation's outcome (``translations``, ``refreshed``,
        ``left`` or None), and, for the words written that the job vouches
        for (``vouched``, ids), each one's key (``words``, which harmonize
        compares the word with) and their decisions (the precedent of later
        stretches). A word written and not vouched for is counted and
        nothing more: harmonize leaves it, and no stretch learns from it."""
        counts = Counter()
        decisions: Dict[Tuple[str, str], Dict[str, Any]] = {}
        left: List[Dict[str, Any]] = []
        keys: Dict[str, str] = {}
        for w in words:
            if job_owned(w, self.job.id):
                counts['words'] += 1
                a = word_analysis(w, made)
                counts['links'] += sum(1 for m in a['morphemes'] if m['entry'])
                if w.id not in vouched:
                    continue
                keys[word_tag(w.id)] = word_key(w)
                text = canonical(a)
                if len(text) > JOB_ANALYSIS_MAX_CHARS:
                    # Core keeps no analysis this long: the word is counted,
                    # and its analysis is not offered as a decision.
                    continue
                key = (form_key(w.surface), analysis_key(text))
                slot = decisions.setdefault(key, {'form': key[0], 'key': key[1], 'analysis': text, 'count': 0,
                                                  'document_id': document_id, 'sentence_id': s.id})
                slot['count'] += 1
            elif word_target(w):
                counts['left'] += 1
                left.append({'ref': f's{s.index}.w{w.index}', 'begin': w.begin, 'form': w.surface})
        if translation:
            counts[translation] += 1
            if translation == 'left':
                left.append({'ref': f's{s.index}', 'begin': None, 'form': None})
        if counts['words'] or translation in ('translations', 'refreshed'):
            counts['analyzed'] = 1
        return {'sentence': s.id, 'counts': dict(counts), 'decisions': list(decisions.values()), 'left': left,
                'words': keys}

    def commit(self, document_id: str, records: List[Dict[str, Any]], fields: Dict[str, Any]) -> None:
        """Store each sentence's record once, then the row.

        A sentence's decisions go to core in one call with a MARK of their
        own, a decision row whose form is ``RECORD_FORM`` and the sentence id
        (a form with a space, which no word has) and whose analysis holds the
        sentence's counts. A mark core holds says the sentence was recorded:
        before a call the marks are asked again, so a call that landed before
        an error, or before a crash, is never sent twice. The row's counts
        and ``done`` are then the sum of the document's marks and its skipped
        sentences, written whole, so writing them again changes nothing."""
        job = self.job
        marks = self.recorded.setdefault(document_id, {})
        fresh = [r for r in records if r['sentence'] not in marks]
        if fresh:
            there = self.marks_in_core([r['sentence'] for r in fresh])
            batch: List[Dict[str, Any]] = []
            for r in fresh:
                if r['sentence'] in there:
                    continue
                text = mark_text(r['counts'], document_id, r.get('left') or [], r.get('words') or {})
                group = r['decisions'] + [{'form': mark_form(r['sentence']), 'key': analysis_key(text),
                                           'analysis': text, 'count': 1, 'document_id': document_id,
                                           'sentence_id': r['sentence']}]
                if len(batch) + len(group) > JOB_DECISIONS_PER_CALL:
                    job.add_decisions(batch)
                    batch = []
                batch += group
            if batch:
                job.add_decisions(batch)
            for r in fresh:
                marks[r['sentence']] = r['counts']
        row = job.rows.get(document_id) or {}
        job.update_row(document_id, **fields, **self.tally(document_id, fields.get('skipped', row.get('skipped'))))

    def tally(self, document_id: str, skipped) -> Dict[str, Any]:
        """A row's counts and ``done`` as its record makes them: the counts of
        the document's recorded sentences, and how many sentences were
        finished, each once (recorded or skipped). ``targets`` grows with a
        sentence that became a target after the checks, so done never passes
        it."""
        marks = self.recorded.get(document_id) or {}
        counts = empty_counts()
        for c in marks.values():
            for k, n in c.items():
                counts[k] = counts.get(k, 0) + n
        row = self.job.rows.get(document_id) or {}
        failed = len(self.unlisted.get(document_id) or ())
        more = max((row.get('counts') or {}).get(SKIPPED_MORE) or 0,
                   failed + len(self.too_long.get(document_id) or ()))
        if more:
            counts[SKIPPED_MORE] = more
        # A sentence too long for a stretch was never a target (the checks
        # leave it out of ``targets``), so it is not counted done.
        done = len(set(marks) | {s.get('sentence_id') for s in skipped or [] if s.get('reason') != 'too-long'}) \
            + failed
        out = {'counts': counts, 'done': done}
        if done > (row.get('targets') or 0):
            out['targets'] = done
        return out

    def marks_in_core(self, sentence_ids: List[str]) -> Dict[str, Dict[str, int]]:
        """The sentences of ``sentence_ids`` core holds a record of, with the
        counts each was recorded with."""
        return {sid: dict(mark.get('counts') or {}) for sid, mark in self.marks(sentence_ids).items()}

    def marks(self, sentence_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """The record core holds of each sentence of ``sentence_ids`` that
        has one, as :func:`mark_text` wrote it (an unreadable one is empty)."""
        out: Dict[str, Dict[str, Any]] = {}
        for r in self.job.lookup_decisions([mark_form(sid) for sid in sentence_ids]):
            form = r.get('form') or ''
            if form.startswith(RECORD_FORM):
                try:
                    mark = json.loads(r['analysis'])
                except (ValueError, TypeError):
                    mark = None
                out[form[len(RECORD_FORM):]] = mark if isinstance(mark, dict) else {}
        return out

    def settle(self, project: IgtProject, document_id: str, doc, own: bool = False) -> None:
        """Before a document's stretches: what core holds of its record (once
        per document a runner visits), and a record for every sentence the
        job wrote in without recording it, which a crash, an error or a write
        put off between a write and its record leaves (SPEC 3.8). Such a
        sentence is recorded from the document as it is, as its stretch would
        have recorded it: the job's own words and translation, and the
        targets left blank. Its words are vouched for only
        when ``own``, the newest change of the document being the job's own
        glossing (``walk``), so that nobody wrote since: otherwise a person's
        deletion would read as the job's work (REV-J-B3 B3-2)."""
        job = self.job
        if document_id not in self.recorded:
            self.recorded[document_id] = self.marks_in_core([s.id for s in doc.sentences])
            row = job.rows.get(document_id) or {}
            if self.recorded[document_id]:
                job.update_row(document_id, **self.tally(document_id, row.get('skipped')))
        marks = self.recorded[document_id]
        skipped = {s.get('sentence_id') for s in (job.rows.get(document_id) or {}).get('skipped') or []}
        orphans = []
        for s in doc.sentences:
            if s.id in marks or s.id in skipped:
                continue
            mine = [w for w in s.words if job_owned(w, job.id)]
            state = translation_state(s, project, job.id) if 'translate' in job.tasks else None
            if not mine and state != 'own':
                continue
            # As its stretch would have recorded it (REV-J-B3 B3-7): the
            # job's words, the targets still blank (left), and the
            # translation, written or left blank.
            ids = {w.id for w in mine}
            words = [w for w in s.words if w.id in ids or ('gloss' in job.tasks and word_target(w))]
            translation = 'translations' if state == 'own' else 'left' if state in ('empty', 'machine') else None
            orphans.append(self.sentence_record(document_id, s, words, translation,
                                                vouched=ids if own else frozenset()))
        if orphans:
            self.commit(document_id, orphans, {})

    # --- harmonize (SPEC 8) -------------------------------------------------------------

    def harmonize(self, job) -> Dict[str, Any]:
        if 'gloss' not in job.tasks:
            return {'changed': [], 'left': []}
        # Taken again from its start (``through_core``, after core trouble):
        # what an earlier run of it wrote stays in the report (REV-J-B3 B3-6).
        earlier = (self.harmonize_done or {}).get('changed') or []
        project = self.project()
        client = job.client()
        self.read_people(project)
        people = self.people
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        docs = {}
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') == 'gone':
                continue
            try:
                docs[d] = self.read(project, d, client)
            except Gone:
                job.update_row(d, state='gone')
                continue
        recorded = self.recorded_words(docs)
        # form -> key -> {analysis, words: [(document, word)]}: the words the
        # job may rewrite, which vote, and per reason those it leaves whole
        # (``harmonize_bar``), which neither vote nor change.
        mine: Dict[str, Dict[str, Dict[str, Any]]] = {}
        held: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {}
        for d, doc in docs.items():
            commented = self.commented(client, project, d)
            for s in doc.sentences:
                for w in s.words:
                    why = harmonize_bar(w, job.id, recorded, commented)
                    if why == NOT_THE_JOBS:
                        continue
                    into = mine if why is None else held.setdefault(why, {})
                    full = word_analysis(w)
                    a = harmonized_part(full, job.tasks)
                    slot = into.setdefault(form_key(w.surface), {}).setdefault(
                        analysis_key(canonical(a)), {'analysis': a, 'words': [], 'word': Counter()})
                    slot['words'].append((d, w.id))
                    slot['word'][canonical(full['word'])] += 1
        left: List[Dict[str, Any]] = []
        moves: List[Dict[str, Any]] = []
        rewrites: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
        forms = set(mine) | {form for by_form in held.values() for form in by_form}
        for form in sorted(forms):
            keys = mine.get(form) or {}
            kept = {why: by_form[form] for why, by_form in sorted(held.items()) if by_form.get(form)}
            if len(set(keys) | {k for slots in kept.values() for k in slots}) < 2:
                continue
            theirs: Dict[str, Dict[str, Any]] = {}
            for x in people.get(form, {}).values():
                a = harmonized_part(x['analysis'], job.tasks)
                slot = theirs.setdefault(analysis_key(canonical(a)), {'analysis': a, 'count': 0, 'word': Counter()})
                slot['count'] += x['count']
                slot['word'][canonical(x['analysis'].get('word') or {})] += x['count']
            # SPEC 8.2: only a form the job's rewritable words hold two or
            # more ways is made consistent. A form they hold one way is left
            # as it is, and its words harmonize leaves are listed all the same.
            if len(keys) >= 2:
                target, by = harmonized({k: len(v['words']) for k, v in keys.items()},
                                        {k: x['count'] for k, x in theirs.items()})
            else:
                target, by = next(iter(keys), None), None
            if by is not None and target is None:
                left.append({'form': form, 'reason': by,
                             'analyses': [{'analysis': rendering(v['analysis'], gloss), 'count': len(v['words'])}
                                          for v in keys.values()]})
            # The job's analyses of the form on words harmonize leaves whole
            # (``harmonize_bar``), listed by reason, but for those already
            # the analysis the form is set to.
            for why, slots in kept.items():
                others = [v for k, v in slots.items() if k != target]
                if others:
                    left.append({'form': form, 'reason': why,
                                 'analyses': [{'analysis': rendering(v['analysis'], gloss),
                                               'count': len(v['words'])} for v in others]})
            if by is None or target is None:
                continue
            chosen = keys.get(target) or theirs[target]
            # The word fields go with the analysis (REV-J-B2 S3-3).
            word = chosen_word_fields((theirs.get(target) or {}).get('word') or Counter(),
                                      (keys.get(target) or {}).get('word') or Counter())
            to = {**chosen['analysis'], 'word': word}
            moving = {k: v for k, v in keys.items() if k != target}
            moves.append({'form': form, 'to': to, 'by': by, 'from': moving})
            for v in moving.values():
                for d, wid in v['words']:
                    rewrites.setdefault(d, []).append((wid, to))
        written: set = set()
        #: (document, word) -> why a word to rewrite was not: its document
        #: stayed in use, or under the lock it was found changed, or its
        #: rewrite was refused
        unwritten: Dict[Tuple[str, str], str] = {}
        self.harmonize_done = with_earlier(earlier, self.harmonize_report(moves, left, written, unwritten, gloss))
        for d in job.order:
            if d not in rewrites:
                continue
            # A stop is asked before each document: nothing is written after it.
            job.check()
            done = self.rewrite(project, d, rewrites[d], recorded)
            if done is None:
                unwritten.update({(d, wid): 'in-use' for wid, _ in rewrites[d]})
            else:
                written |= {(d, wid) for wid in done['written']}
                unwritten.update({(d, wid): why for wid, why in done['left'].items()})
            self.harmonize_done = with_earlier(earlier,
                                              self.harmonize_report(moves, left, written, unwritten, gloss))
        return self.harmonize_done

    @staticmethod
    def harmonize_report(moves, left, written: set, unwritten: Dict[Tuple[str, str], str], gloss) -> Dict[str, Any]:
        """Harmonize's part of the report from what was written: a form is
        changed with the words rewritten (each analysis's count and the
        documents it was rewritten in), and left, by reason, with the words
        that were to be rewritten and were not (``unwritten``: their
        document stayed in use, they changed before the lock, their rewrite
        was refused). Only a word of a document gone or not reached before a
        stop is in neither: the document's row says so."""
        changed, held = [], []
        for m in moves:
            moved = []
            kept: Dict[str, List[Dict[str, Any]]] = {}
            for v in m['from'].values():
                done = [(d, w) for d, w in v['words'] if (d, w) in written]
                if done:
                    moved.append({'analysis': rendering(v['analysis'], gloss), 'count': len(done),
                                  'documents': sorted({d for d, _ in done})})
                why = Counter(unwritten[x] for x in v['words'] if x in unwritten)
                for reason, n in sorted(why.items()):
                    kept.setdefault(reason, []).append({'analysis': rendering(v['analysis'], gloss), 'count': n})
            if moved:
                changed.append({'form': m['form'], 'to': rendering(m['to'], gloss), 'by': m['by'], 'from': moved})
            for reason, analyses in sorted(kept.items()):
                held.append({'form': m['form'], 'reason': reason, 'analyses': analyses})
        return {'changed': changed, 'left': list(left) + held}

    def recorded_words(self, docs: Dict[str, Any]) -> Dict[str, str]:
        """Word id to the key the job's record holds for that word
        (:func:`word_key`), over the sentences of ``docs``: what the job
        wrote on each word it vouched for (CONTRACT, added by J-FIX-B3)."""
        out: Dict[str, str] = {}
        for doc in docs.values():
            marks = self.marks([s.id for s in doc.sentences])
            for s in doc.sentences:
                keys = (marks.get(s.id) or {}).get('words')
                if not isinstance(keys, dict):
                    continue
                for w in s.words:
                    key = keys.get(word_tag(w.id))
                    if key:
                        out[w.id] = key
        return out

    @staticmethod
    def commented(client, project: IgtProject, document_id: str) -> set:
        """The ids the comments in a document are anchored to."""
        return {c.get('entity_id') for c in client.comments.list(project.id, document_id=document_id) or []}

    def rewrite(self, project: IgtProject, document_id: str, words: List[Tuple[str, Dict[str, Any]]],
                recorded: Dict[str, str]) -> Optional[Dict[str, Any]]:
        """Set each of ``words`` to its target analysis, under the lock, as
        one History entry of its own, through the job's workspace and its
        guards, as a stretch stages (REV-J-B2 S3-2). ``{written: ids, left:
        {id: reason}}``: the words rewritten, and those not with why (found
        changed under the lock, ``harmonize_bar``'s reason or ``touched``
        for a word gone, or ``refused`` by staging). Nothing when the
        document is gone (its row says so), None when it stayed in use."""
        job = self.job
        # A look, then JOB_DEFER_ROUNDS waits for people, as the walk waits.
        for attempt in range(JOB_DEFER_ROUNDS + 1):
            if attempt:
                self.wait_for_people([document_id])
            client = job.client()
            if self.in_use(self.newest_change(client, document_id), f'job:{job.id}/'):
                continue
            row = job.rows.get(document_id) or {}
            group = row.get('harmonize_group')
            if not group:
                group = uuid7()
                job.update_row(document_id, harmonize_group=group)
            try:
                staged, held = set(), {}
                with locked_for_writes(client, document_id):
                    ws = JobWorkspace(client, project, job.tasks)
                    doc = self.read(project, document_id, client)
                    ws._docs[document_id] = doc
                    doc = ws.doc(document_id)
                    commented = self.commented(client, project, document_id)
                    for wid, to in words:
                        hit = doc.find(wid)
                        why = harmonize_bar(hit[1], job.id, recorded, commented) \
                            if hit and hit[1] is not None else TOUCHED
                        if why is None:
                            refusal = self.stage(ws, doc, hit[0], hit[1], to)
                            if refusal is not None:
                                logger.warning('Job %s: harmonize\'s rewrite of %s in %s was refused: %s', job.id, wid,
                                               document_id, refusal)
                                why = REFUSED
                        if why is None:
                            staged.add(wid)
                        else:
                            held[wid] = TOUCHED if why == NOT_THE_JOBS else why
                    if ws.ops:
                        seed_id = uuid7()
                        with client.operation(HARMONIZE_LABEL, kind='job',
                                              ref=f'job:{job.id}/doc:{document_id}/pass:harmonize', group_id=group,
                                              keys={'seed': seed_id, 'stamps': {}}):
                            execute_plan(client, list(ws.ops), source=self.source, label=HARMONIZE_LABEL,
                                         project=project, stamp_mode='machine', detail=self.detail, seed=seed_id)
                return {'written': staged, 'left': held}
            except Gone:
                job.update_row(document_id, state='gone')
                return {'written': set(), 'left': {}}
            except PlaidAPIError as e:
                if e.status != 423:
                    why = self.refused(e, document_id)
                    if isinstance(why, Gone):
                        job.update_row(document_id, state='gone')
                        return {'written': set(), 'left': {}}
                    raise why from e
            except PlanOutOfDate as e:
                # An entry a rewrite links went between staging and the write
                # (REV-J-B3 B3-3): nothing was written, the words are left.
                if core_job.plaid_error(e) is not None:
                    raise
                logger.warning('Job %s: harmonize\'s rewrites in %s are out of date: %s', job.id, document_id, e)
                return {'written': set(), 'left': {wid: REFUSED for wid, _ in words}}
            except PlanError as e:
                if _gone_now(e) and not (e.applied or e.unknown):
                    logger.warning('Job %s: harmonize\'s rewrites in %s were refused: %s', job.id, document_id, e)
                    return {'written': set(), 'left': {wid: REFUSED for wid, _ in words}}
                if _status(e) not in (409, 423):
                    raise
        return None

    @staticmethod
    def stage(ws: Workspace, doc, s: Sentence, w: Word, to: Dict[str, Any]) -> Optional[str]:
        """Stage ``to`` on word ``w``: its analysis, its links, and every word
        field the word holds set to ``to``'s value for it, or cleared where
        ``to`` has none, through the tools, so every guard of theirs applies.
        Asked only of a word harmonize may rewrite (``harmonize_bar``), so
        each field it holds is one the job wrote: harmonize rewrites
        everything the job wrote on the word and nothing else, and adds no
        field the word does not hold (the owner, 2026-11-12). None when all
        of it was staged, else the refusal, and nothing of the word is
        staged: a word is rewritten whole or not at all."""
        ref = f's{s.index}.w{w.index}'
        name = doc.name
        calls = [('set_analysis', {'document': name, 'ref': ref, 'morphemes': [
            {'form': m['form'], **({'type': m['type']} if m.get('type') else {}), 'equals': bool(m.get('equals')),
             'fields': dict(m.get('fields') or {})} for m in to['morphemes']]})]
        calls += [('link_entry', {'document': name, 'refs': [f'{ref}.m{i}'], 'entry_id': m['entry']})
                  for i, m in enumerate(to['morphemes'], start=1) if m.get('entry')]
        values = {field: (to.get('word') or {}).get(field, '') for field, sp in sorted(w.fields.items())
                  if (to.get('word') or {}).get(field, '') != _nfc(sp.value)}
        if values:
            calls.append(('set_field', {'document': name, 'refs': [ref], 'values': values}))
        saved = ws.snapshot()
        for tool, args in calls:
            out = toolkit.call_tool(ws, tool, args)
            if isinstance(out, Refusal):
                ws.restore(saved)
                return str(out)
        return None

    # --- the entries pass (SPEC 7.5) ------------------------------------------------------

    def entries(self, job, delete: bool = True) -> Dict[str, Any]:
        """The entries this job made, after the job's last write: those it
        created, its unlinked drafts deleted (SPEC 7.5) and those left. With
        ``delete`` False (a job that stopped) nothing is deleted: the entries
        are only read for the report."""
        if 'link' not in job.tasks:
            return entries_part([], [], [])
        project = self.project()
        client = job.client()
        ws = Workspace(client, project)
        maintains = job.starter in (project.roles.get('maintainers') or [])
        created, deleted, unlinked = [], [], []
        doomed = []
        for v in project.vocabs:
            if v.get('borrowed'):
                continue
            status = IgtProject.lexicon_field(v, ROLE_STATUS)
            gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
            items = ws.lexicon(v)
            comments = None
            for it in items:
                md = it.get('metadata') or {}
                if _job_of(md) != job.id:
                    continue
                entry = {'id': it['id'], 'lexicon': v['id'], 'form': it.get('form'),
                         'gloss': md.get(gloss) if gloss else None}
                if not status or md.get(status) != MACHINE_STATUS or self.linked(ws, it['id']):
                    created.append(entry)
                    continue
                if comments is None:
                    comments = {c.get('entity_id') for c in client.comments.list_in_vocab(v['id']) or []}
                if delete and maintains and self.nothing_hangs_on(client, v, items, it, comments):
                    doomed.append(entry)
                else:
                    created.append(entry)
                    unlinked.append(entry)
        if doomed:
            job.check()
            kept = self.delete_entries(client, project, doomed)
            for e in doomed:
                if e['id'] in kept:
                    created.append(e)
                    unlinked.append(e)
                else:
                    deleted.append({k: e[k] for k in ('id', 'form', 'gloss')})
        # A proposal the job created later (another stretch staged it again
        # and linked it) is reported created, never proposed as well.
        made = {(e['lexicon'], _nfc(e['form']), _nfc(e['gloss'])) for e in created + doomed}
        proposed = [p for p in self.proposed_entries()
                    if (p.get('lexicon'), _nfc(p.get('form')), _nfc(p.get('gloss'))) not in made]
        return entries_part(created, deleted, unlinked, proposed)

    def proposed_entries(self) -> List[Dict[str, Any]]:
        """Every entry the model staged and nothing linked, in this run and
        in any run of the job before it (kept among its decisions)."""
        out = dict(self.proposed)
        for r in self.job.decisions():
            if str(r.get('form') or '').startswith(PROPOSED_FORM):
                try:
                    e = json.loads(r['analysis'])
                except (ValueError, TypeError):
                    continue
                out.setdefault((e.get('lexicon'), e.get('form'), e.get('gloss')), e)
        return list(out.values())

    @staticmethod
    def linked(ws: Workspace, item_id: str) -> bool:
        """Whether anything links to entry ``item_id``: one query, asked of
        the job's drafts alone, in place of a walk of every document of the
        project (REV-J-B S3-10)."""
        return bool(ws.corpus.entities([['vocab', '?v', {}], ['=', '?v.id', item_id], ['vocab-link', '?t', '?v']],
                                       ['?t'], 1))

    def nothing_hangs_on(self, client, v: Dict[str, Any], items: List[Dict[str, Any]], it: Dict[str, Any],
                         commented: set) -> bool:
        """Whether nothing at all hangs on the job's draft ``it`` that the
        job did not make (REV-J-B S2-1): the entry is the job's own
        unverified work (:func:`job_piece`), no sense sits under it, no entry
        refers to it, nobody commented on it, and every change in its History
        is this job's. Links are counted by the caller."""
        if not job_piece(it.get('metadata'), self.job.id) or it['id'] in commented:
            return False
        if references_to(items, v.get('fields'), it['id']):
            return False
        mine = f'job:{self.job.id}/'
        return all(str(e.get('ref') or '').startswith(mine)
                   for e in client.vocab_layers.audit(v['id'], item_id=it['id']) or [])

    def delete_entries(self, client, project: IgtProject, doomed: List[Dict[str, Any]]) -> set:
        """Delete the job's unlinked drafts ``doomed`` as the app deletes an
        entry: through the plan's ``delete_entry`` (its links taken with it
        and claimed by count, its senses freed and the references to it
        cleared in the same operation, refused when anything changed since
        it was read), as one History entry with no document. The ids kept."""
        ws = Workspace(client, project)
        kept = set()
        for e in doomed:
            if isinstance(toolkit.call_tool(ws, 'delete_entry', {'entry_id': e['id']}), Refusal):
                kept.add(e['id'])
        if not ws.ops:
            return kept
        seed_id = uuid7()
        try:
            with client.operation(ENTRIES_LABEL, kind='job', ref=f'job:{self.job.id}/pass:entries',
                                  keys={'seed': seed_id, 'stamps': {}}):
                execute_plan(client, list(ws.ops), source=self.source, label=ENTRIES_LABEL, project=project,
                             stamp_mode='machine', detail=self.detail, seed=seed_id)
        except (PlanError, PlanOutOfDate) as err:
            # Refused, or out of date before anything was written (a draft
            # deleted or linked since it was staged, REV-J-B3 B3-3).
            logger.warning('Job %s: its unlinked drafts were kept: %s', self.job.id, err)
            return {e['id'] for e in doomed}
        return kept

    # --- the report (SPEC 9) --------------------------------------------------------------

    def document_reports(self, job) -> List[Dict[str, Any]]:
        out = []
        blank = self.left_blank(job)
        for d in job.order:
            row = job.rows.get(d) or {}
            state = row.get('state')
            counts = row.get('counts') or empty_counts()
            # What the job could not decide, for people to (CONTRACT, added by
            # JB): every target of the document's recorded sentences it left
            # blank, cut as every report list is. A sentence whose record
            # could not hold its whole list counts the rest as more.
            listed = blank.get(d) or []
            left, _ = core_job.cut(listed)
            out.append({'document_id': d, 'name': self.names.get(d) or row.get('name'),
                        'state': state if state in ('done', 'in-use', 'gone') else 'not-reached',
                        'sentences': row.get('sentences'), 'targets': row.get('targets'), 'done': row.get('done'),
                        'counts': counts, 'skipped': row.get('skipped') or [],
                        'gloss_group': row.get('gloss_group'), 'harmonize_group': row.get('harmonize_group'),
                        'left': left, 'left_more': max(len(listed), counts.get('left') or 0) - len(left)})
        return out

    def left_blank(self, job) -> Dict[str, List[Dict[str, Any]]]:
        """Per document, the targets the job left blank, read from every
        sentence record the job holds in core (a resumed job's runs before
        this one included), in document order: ``{ref, sentence_id, begin,
        form}``, ``begin`` and ``form`` None for a translation. Nothing when
        the records cannot be read: the report is still written."""
        try:
            rows = core_job.through_core(job, job.decisions)
        except Exception as e:  # noqa: BLE001 - a report without the list rather than none
            logger.warning('Job %s: the words it left blank could not be read for the report: %s', job.id, e)
            return {}
        out: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            form = str(r.get('form') or '')
            if not form.startswith(RECORD_FORM):
                continue
            try:
                record = json.loads(r['analysis'])
            except (ValueError, TypeError, KeyError):
                continue
            for e in record.get('left') or []:
                out.setdefault(record.get('document'), []).append({**e, 'sentence_id': form[len(RECORD_FORM):]})
        for listed in out.values():
            listed.sort(key=lambda e: [int(n) for n in re.findall(r'\d+', e.get('ref') or '')])
        return out


def runner_factory(cfg: ModelConfig, trace_dir: Optional[str] = None, count=None):
    """What the worker builds a claimed igt job's runner with."""
    return lambda job: IgtRunner(job, cfg, trace_dir=trace_dir, count=count)
