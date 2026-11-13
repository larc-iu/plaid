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
from ..core.limits import (JOB_ANALYSIS_MAX_CHARS, JOB_CHANGE_VALUE_CHARS, JOB_CHANGES_MAX, JOB_CONTEXT_SENTENCES,
                           JOB_DOCUMENT_PIECE_MAX_CHARS, JOB_NOTE_MAX_CHARS, JOB_SUMMARY_MAX_CHARS,
                           JOB_SUMMARY_NOTES_CHARS, JOB_SUMMARY_TABLE_CHARS, JOB_TABLES_MAX, JOB_TABLES_PER_PIECE,
                           JOB_DECISIONS_PER_CALL, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S, JOB_GUIDELINES_MAX_CHARS,
                           JOB_LOCK_TRIES, JOB_LOCK_WAIT_S, JOB_PERSON_QUIET_S, JOB_PRECEDENT_CHARS,
                           JOB_PRECEDENT_PER_FORM, JOB_SENTENCE_MAX_CHARS, JOB_SENTENCE_MAX_WORDS,
                           JOB_SKIPPED_PER_DOCUMENT, JOB_STRETCH_SENTENCES)
from ..core.plan import JOB_DETAIL_KEY, PlanError, held_changes
from ..core.tools import Refusal, ToolError
from ..core.version import agent_version
from . import toolkit
from .plan import PlanOutOfDate, check_entries, execute_plan
from .project import IgtProject, Sentence, Word, is_virtual, load_project, render_sentence
from .prompt import JOB_SYSTEM, build_job_prompt
from .trace import TRACER
from .vocab import ROLE_GLOSS, ROLE_STATUS, parent_of
from .workspace import Workspace

logger = logging.getLogger(__name__)

#: The phase of the work on the documents (CONTRACT 2.1).
WORK_PHASE = 'working'
#: The Status value of an entry a job creates (CONTRACT 10).
MACHINE_STATUS = 'machine'
#: How many words of its instructions name a job in History (CONTRACT, added by JG).
LABEL_WORDS = 6
HARMONIZE_LABEL = 'Assistant job: analyses made consistent'


#: The form of a sentence's record among the job's decisions: a space, then
#: words no word form has (a word never holds a space), then the sentence id.
RECORD_FORM = ' sentence '
#: The form of an entry the model staged and nothing linked (``propose``),
#: kept among the decisions the same way, so a resumed job still reports it.
PROPOSED_FORM = ' proposed '
#: The form of a sentence's writing row: the job is about to write in it.
#: Written before the write is sent, so that the job's having written in a
#: sentence is a fact core holds, never one read back from the document,
#: where a person may have removed it (REV-FIX3-1).
WRITING_FORM = ' writing '
#: Why a sentence is skipped when the job wrote in it, its record was lost,
#: and nothing of the job is left in it now: whether the write landed and a
#: person removed it, or it never landed, cannot be told, and the job writes
#: nothing more there (REV-FIX3-1).
INTERRUPTED = 'interrupted'
#: The job's plan, made once (``plan_work`` or the default), and where the
#: plan's pieces were cut smaller (a document too large for one piece, a
#: selection that failed): rows of the job's decisions, so a resumed job
#: never plans again (CONTRACT, added by JG).
PLAN_FORM = ' plan'
FALLBACK_FORM = ' fallback '
#: A change a piece staged that the apply rule did not apply, a piece's
#: note, a table a piece's code made, and how many changes the cap dropped.
CHANGE_FORM = ' change '
NOTE_FORM = ' note '
TABLE_FORM = ' table '
DROPPED_FORM = ' dropped'
#: How many tables pieces handed the report past JOB_TABLES_MAX a job keeps.
TABLES_DROPPED_FORM = ' tables dropped'
#: The form of an entry the job creates: a row written with the write's
#: writing rows, before the write is sent, keyed by the entry's lexicon,
#: form and gloss (:func:`entry_key`). An entry the job made is never made
#: again once it is gone: a create of that key that nothing fits is a
#: proposed change (the lead's ruling on REV-JG3-5).
MADE_FORM = ' made '
#: Why a create is a proposed change and not applied, as its change says:
#: the job made this entry before, and it is gone or no longer reads so.
ENTRY_GONE = 'This job made this entry before, and it was deleted or changed since.'
#: Why a selection's create is a proposed change: an entry of someone else's
#: that fits it was made after the piece staged it, and nobody chose it.
ENTRY_EXISTS = 'An entry of this form and gloss was made during the job.'
#: How the plan cuts the work (``plan_work``'s ``pieces``).
SENTENCES, DOCUMENT, SELECTION = 'sentences', 'document', 'selection'
#: Why a document of a selection is worked as a piece of its own: the
#: selection's piece never read it (REV-JG2-5, CONTRACT, added by JG-FIX2).
NOT_READ = 'not-read'
PIECES = (SENTENCES, DOCUMENT, SELECTION)


def _cut(text, limit: int):
    """``text`` at most ``limit`` characters, "…" where it was cut, None as
    None."""
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= limit else text[:limit - 1] + '…'


def _first_line(text) -> str:
    return next((line.strip() for line in str(text or '').splitlines() if line.strip()), '')


def table_rows_text(table: Dict[str, Any]) -> List[str]:
    """A table a piece's code made, as the decision rows that keep it: its
    title, columns and rows split over as many rows as JOB_ANALYSIS_MAX_CHARS
    needs, each saying which part of how many it is."""
    head = {'title': table.get('title'), 'columns': table.get('columns'), 'more': table.get('more') or 0}
    chunks: List[List[Any]] = [[]]
    for row in table.get('rows') or []:
        trial = canonical({**head, 'rows': chunks[-1] + [row], 'part': 999, 'of': 999})
        if chunks[-1] and len(trial) > JOB_ANALYSIS_MAX_CHARS:
            chunks.append([])
        chunks[-1].append(row)
    return [canonical({**head, 'rows': rows, 'part': i, 'of': len(chunks)}) for i, rows in enumerate(chunks)]


def _n(n: int, word: str) -> str:
    return f'{n} {word}{"" if n == 1 else "s"}'


def mark_form(sentence_id: str) -> str:
    return RECORD_FORM + sentence_id


def writing_form(sentence_id: str) -> str:
    return WRITING_FORM + sentence_id


def writing_text(document_id: str, translation: Optional[str], words: List[str], others=()) -> str:
    """A writing row's analysis: the document, what the write does to the
    sentence's translation (``translations`` fills a blank, ``refreshed``
    replaces a machine draft, None leaves it), the tags of the words it
    analyses (:func:`word_tag`) and the tags of the sentence's other words
    (``others``), so that every word of a sentence the job wrote in is known
    to it wherever a person moves it (REV-B4-1). Every tag of a sentence of
    JOB_SENTENCE_MAX_WORDS words fits a decision's analysis. Past that (a
    sentence a person made longer since the checks) the others are cut
    first, then the words."""
    words, others = list(words), list(others)
    while True:
        text = canonical({'document': document_id, 'others': others, 'translation': translation, 'words': words})
        if len(text) <= JOB_ANALYSIS_MAX_CHARS or not (words or others):
            return text
        if others:
            others.pop()
        else:
            words.pop()


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


def job_label(instructions: Optional[str]) -> str:
    """The History name of a job's work in a document: "Assistant job: "
    and the first LABEL_WORDS words of its instructions, with "…" when there
    are more. One dumb rule: a job has no name of its own, and its
    instructions say what it did."""
    words = str(instructions or '').split()
    head = ' '.join(words[:LABEL_WORDS])
    return 'Assistant job: ' + (head + ('…' if len(words) > LABEL_WORDS else '') if head else 'work')


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


def translation_layer(project: IgtProject) -> Optional[str]:
    """The layer of the translation field, by which a write is known to be
    one of a translation (never by a field's name)."""
    f = translation_field(project)
    return f.layer_id if f is not None else None


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


def translated_by(s: Sentence, project: IgtProject, job_id: str) -> bool:
    """Whether ``s``'s translation is one this job wrote, confirmed by a
    person since or not: approving keeps a piece's ``provDetail``, which
    names the job (REV-B4-5)."""
    f = translation_field(project)
    sp = s.fields.get(f.name) if f else None
    return sp is not None and (sp.value or '') != '' and _job_of(sp.metadata) == job_id


def translation_target(s: Sentence, project: IgtProject, job_id: str) -> bool:
    """An empty translation. Another producer's machine translation is not
    one: replacing it is a proposed change (the apply rule)."""
    return translation_field(project) is not None and translation_state(s, project, job_id) == 'empty'


def sentence_targets(s: Sentence, project: IgtProject, job_id: str,
                     known=frozenset()) -> Tuple[List[Word], bool]:
    """What is empty in ``s``: its blank words and whether its translation
    is empty. A job walks a document's sentences that hold something empty
    (a job has no task types: what it fills is its instructions' business).
    Nothing in a sentence that holds a word of a sentence the job began to
    write in (``known``, :meth:`IgtRunner.known_words`)."""
    if wrote_in(s, known):
        return [], False
    return [w for w in s.words if word_target(w)], translation_target(s, project, job_id)


def wrote_in(s: Sentence, known) -> bool:
    """Whether ``s`` holds a word of a sentence the job began to write in:
    ``known`` holds the tags (:func:`word_tag`) of every word of such
    sentences, as their writing rows name them. A sentence split or merged
    keeps its words' ids and may get a new id of its own, so the job knows
    where it wrote by word as well as by sentence: such a sentence is never
    a target again, whatever its id now (REV-B4-1)."""
    return bool(known) and any(word_tag(w.id) in known for w in s.words)


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


def job_wrote(w: Word, job_id: str) -> bool:
    """A word whose analysis is wholly this job's work, whether or not a
    person has confirmed it since: every piece on it names this job
    (approving keeps a piece's ``provDetail``). Counted as a word the job
    analysed. Only :func:`job_owned` words are the job's to harmonize
    (REV-B4-5)."""
    if word_state(w) == 'unanalyzed':
        return False
    pieces = word_pieces(w)
    return bool(pieces) and all(_job_of(p) == job_id for p in pieces)


#: Why harmonize leaves a word the job wrote on, as its report lists it
#: (CONTRACT, added by J-FIX-B and J-FIX-B2), and the word it never looks at.
TOUCHED, COMMENTED, IN_MWE, NOT_THE_JOBS = 'touched', 'commented', 'in-mwe', 'not-the-jobs'
#: A word the job wrote and could not vouch for: its sentence's record holds
#: no key for it (REV-FIX3-2).
UNVOUCHED = 'unvouched'
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


def blank_word(w: Word, job_id: str, commented=frozenset()) -> bool:
    """THE blank word of the apply rule, the job's to fill (the lead's
    rulings on REV-JG and REV-JG2-4), in one place: no analysis and no value
    (:func:`word_target`), and nothing anyone but this job made hangs on it
    or on its morphemes: no span (an empty one included), link (the whole
    word's own included) or stamped morpheme that is not this job's own
    unverified work (:func:`job_piece`), no comment on it or a piece of it
    (``commented``, the ids the document's comments are anchored to), and no
    multi-word expression over it but the job's. Anything else there is
    people's ground: what fills it is a proposed change. A comment on the
    word's sentence or its translation is not on the word."""
    if not word_target(w):
        return False
    if any(not job_piece(p, job_id) for p in word_pieces(w)):
        return False
    if any(not job_piece(link.metadata, job_id) for link in w.mwes):
        return False
    return not (word_ids(w) & set(commented))


def blank_value(s: Sentence, name: str, job_id: str, commented=frozenset()) -> bool:
    """THE empty sentence value of the apply rule, beside :func:`blank_word`
    and of its shape (the lead's ruling on REV-JG3-4): a sentence's value of
    field ``name`` (its translation, any sentence field) is the job's to
    fill only when no span is there but the job's own unverified one, and
    that empty (a person's empty span keeps the job off), and no comment
    hangs on the sentence or on that field's span (``commented``, the ids
    the document's comments are anchored to). A comment on a word of the
    sentence is not on the sentence."""
    sp = s.fields.get(name)
    if sp is not None and ((sp.value or '') != '' or not job_piece(sp.metadata, job_id)):
        return False
    return not (({s.id} | ({sp.id} if sp is not None else set())) & set(commented))


def own_value(s: Sentence, name: str, job_id: str, commented=frozenset()) -> bool:
    """A sentence's value of field ``name`` that the job may revise: its own
    unverified work (:func:`job_piece`), with no comment on the sentence or
    on that field's span, as harmonize leaves a word with a comment."""
    sp = s.fields.get(name)
    return sp is not None and job_piece(sp.metadata, job_id) and not ({s.id, sp.id} & set(commented))


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
      sentence's record holds for it). So a piece a person deleted or
      changed is never put back, even when the job wrote what is left of the
      word elsewhere,
    * ``unvouched``: the job could not vouch for its own write on the word
      (its sentence's record holds no key for it, REV-J-B3 B3-2), so it
      cannot tell whether anyone changed it, and leaves it,
    * ``commented``: a comment hangs on the word or a piece of it
      (``commented``, the ids the document's comments are anchored to),
    * ``in-mwe``: the word is a member of a multi-word expression, which a
      job never makes."""
    pieces = word_pieces(w)
    if not any(job_piece(p, job_id) for p in pieces):
        return NOT_THE_JOBS
    if not job_owned(w, job_id):
        return TOUCHED
    if w.id not in recorded:
        return UNVOUCHED
    if recorded[w.id] != word_key(w):
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


def harmonized_part(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """What harmonize compares an analysis by: the morphemes (form, type,
    "=", their fields, their entries), never ``made``. The word fields do not
    decide a form's analysis: they go with it (:meth:`IgtRunner.stage`)."""
    return {'morphemes': [{**m, 'made': False} for m in analysis['morphemes']], 'word': {}}


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


def summary_message(report: Dict[str, Any]) -> str:
    """What the final context is handed: the report's sections as text, each
    bounded (JOB_SUMMARY_NOTES_CHARS for the notes, JOB_SUMMARY_TABLE_CHARS
    for the tables), saying what it left out."""
    totals = report.get('totals') or {}
    lines = ['The job\'s instructions:', report.get('instructions') or '', '',
             'The report\'s totals (the worker counted these):',
             ', '.join(f'{k.replace("_", " ")} {v:,}' for k, v in sorted(totals.items()) if v), '']
    plan = report.get('plan') or {}
    if plan:
        lines += [f'How the work was cut: {plan.get("pieces")}.', '']
    lines.append('Documents:')
    for d in report.get('documents') or []:
        c = d.get('counts') or {}
        lines.append(f'- "{d.get("name")}": {d.get("state")}, '
                     + ', '.join(f'{k} {v:,}' for k, v in sorted(c.items()) if v and isinstance(v, int)))
    proposed = len(report.get('proposed') or []) + (report.get('proposed_more') or 0)
    lines += ['', f'Changes proposed for a person to approve: {proposed:,}.', '', 'Each piece\'s note:']
    size, left = 0, 0
    for n in report.get('notes') or []:
        line = f'- {n.get("name") or ""} {n.get("sentences") or ""}: {n.get("note")}'.replace('  ', ' ')
        if size + len(line) > JOB_SUMMARY_NOTES_CHARS:
            left += 1
            continue
        lines.append(line)
        size += len(line) + 1
    if left or report.get('notes_more'):
        lines.append(f'and {left + (report.get("notes_more") or 0):,} more notes not shown')
    tables = report.get('tables') or []
    if tables:
        lines += ['', 'Tables the job\'s code made (in the report as they are):']
        size = 0
        for t in tables:
            text = canonical({'title': t.get('title'), 'columns': t.get('columns'), 'rows': t.get('rows')})
            if size + len(text) > JOB_SUMMARY_TABLE_CHARS:
                lines.append(f'- "{t.get("title")}": {len(t.get("rows") or [])} rows, not shown')
                continue
            lines.append(text)
            size += len(text)
    lines += ['', 'Write the summary now.']
    return '\n'.join(lines)


# --- the job's workspace ---------------------------------------------------------

class Stretch:
    """The targets of one stretch: which words and translations may be
    written, and where every token of the document sits."""

    def __init__(self, doc, project: IgtProject, sentences: List[Sentence], job_id: str, known=frozenset()):
        self.doc = doc
        self.project = project
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
            words, translate = sentence_targets(s, project, job_id, known)
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
    """The igt workspace of a job's model. A piece of the job (``mode``
    ``piece``) stages as the assistant stages, with every guard of the
    workspace, and nothing it stages is refused for what it would change:
    the worker decides that when it applies the plan, by the apply rule
    (:mod:`plaid_agent.igt.jobapply`). One guard is the job's own: no entry
    is created where one of the same form and gloss exists, so the model
    links that one. The job's planning context (``plan``) stages nothing.
    Harmonize stages through it too, with no stretch.

    ``tables`` collects what code hands ``table()`` in a piece, kept as data
    in the job's report (:func:`plaid_agent.igt.sandbox.api`)."""

    PIECE, PLAN = 'piece', 'plan'

    def __init__(self, client, project: IgtProject, stretch: Optional[Stretch] = None, mode: str = PIECE):
        super().__init__(client, project)
        self.stretch = stretch
        self.mode = mode
        self.decide_now = False
        self.tables: List[Dict[str, Any]] = []
        #: the planning context's plan_work, once valid
        self.plan_work: Optional[Dict[str, Any]] = None

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        if self.mode == self.PLAN:
            raise ToolError('This context plans the job and stages no change: end with plan_work.',
                            kind='not-allowed')
        if op.get('kind') == 'create_entry':
            self.fit_guard(op)
        super().guard_op(op, replacing=replacing)

    # What a staging tool says back, and the line every result ends with,
    # worded for a job: nothing waits for anyone, what is staged is applied
    # by the job's rule when the piece ends (REV-J-B S3-3). The chat's own
    # say a person approves a plan card and is told of it in a reply.

    tool_fault_next = 'Try another way of asking rather than the same call again.'

    def staged_count(self) -> int:
        return held_changes(self)

    def planned_note(self, n: int, what: Optional[str] = None) -> str:
        held = self.staged_count()
        return (f'Staged {what or _n(n, "change")}. {_n(held, "change")} staged in all, applied when you end.'
                + self.superseded_note())

    def result_line(self) -> str:
        held = self.staged_count()
        return f'[Staged: {_n(held, "change")}.]' if held else '[Staged: nothing yet.]'

    def unknown_new_entry(self, entry_id: str) -> str:
        return (f'No entry staged in this piece has id {entry_id}. Name an entry made before it by its form, '
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

    def fit_guard(self, op: Dict[str, Any]) -> None:
        """No entry is created where one fits: same form and gloss, after NFC,
        made by anyone, of any status, or staged earlier in this piece
        (SPEC 7.2)."""
        v = next((x for x in self.project.vocabs if x['id'] == op.get('vocab_id')), None)
        if v is None or v.get('borrowed'):
            return
        value = _entry_gloss(op, IgtProject.lexicon_field(v, ROLE_GLOSS))
        item = fitting_entry(v, self.lexicon(v), op)
        if item is not None:
            raise ToolError(f'{self.entry_name(item)} ‘{value}’ exists: link it.', kind='conflict')
        staged = fitting_entry(v, [o for o in self.ops if o.get('kind') == 'create_entry'
                                   and o.get('vocab_id') == v['id']], op)
        if staged is not None:
            raise ToolError(f'"{_nfc(op.get("form"))}" ‘{value}’ is staged already as entry_id {staged.get("key")}: '
                            'link it.', kind='conflict')


def _entry_gloss(item: Dict[str, Any], gloss: Optional[str]) -> str:
    return _nfc((item.get('metadata') or {}).get(gloss)) if gloss else ''


def _morph_type(item: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """The morph type an entry goes by: its own (the reserved key
    ``morphType``), else its headword's, else None. ``morph_type_of``'s rule,
    for items that may be staged creates with no id."""
    seen, cur = set(), item
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        t = (cur.get('metadata') or {}).get('morphType')
        if isinstance(t, str) and t:
            return t
        cur = by_id.get(parent_of({'metadata': cur.get('metadata') or {}}) or '')
    return None


def fitting_entry(v: Dict[str, Any], items: List[Dict[str, Any]], op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The first of ``items`` (entries of lexicon ``v``) that fits the
    create ``op``: the same form, gloss and morph type, after NFC (SPEC 7.2,
    the type since REV-JG3-8: a suffix -ka 'go' is not the stem ka 'go'). No
    entry is created where one fits, made by anyone, of any status."""
    gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
    form, value = _nfc(op.get('form')), _entry_gloss(op, gloss)
    by_id = {it['id']: it for it in items if it.get('id')}
    kind = _morph_type(op, by_id)
    return next((it for it in items if _nfc(it.get('form')) == form and _entry_gloss(it, gloss) == value
                 and _morph_type(it, by_id) == kind), None)


def entry_key(v: Dict[str, Any], op: Dict[str, Any]) -> str:
    """The key of the entry a create ``op`` makes in lexicon ``v``, as the
    job's row of an entry it made holds it: what :func:`fitting_entry`
    compares, its lexicon, form and gloss after NFC."""
    gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
    return analysis_key(canonical({'lexicon': v['id'], 'form': _nfc(op.get('form')),
                                   'gloss': _entry_gloss(op, gloss), 'type': _morph_type(op, {})}))


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


def entries_part(created, unlinked) -> Dict[str, Any]:
    """The report's entries part (CONTRACT 5.3), its two lists uncut (the
    entries the job created, and those of them with no links), with
    ``lexicons``: every lexicon the job created an entry in, in the order
    first met, so the job page links each one's machine drafts (J-INT). An
    entry the model staged and the job did not create is one of the job's
    proposed changes (the apply rule)."""
    return {'created': created, 'unlinked': unlinked,
            'lexicons': list(dict.fromkeys(e['lexicon'] for e in created))}


class IgtRunner:
    """One job over interlinear text, run by ``core.job.run_job``."""

    WORK_PHASE = WORK_PHASE
    #: The entries part of a job that never reached its entries.
    NO_ENTRIES = entries_part([], [])

    def __init__(self, job, cfg: ModelConfig, trace_dir: Optional[str] = None, count=None,
                 write_summary: bool = True):
        self.job = job
        #: whether the report's prose is written (the worker always does)
        self.write_summary = write_summary
        self.cfg = cfg
        self.trace_dir = trace_dir
        self.count = count
        self.version = agent_version([JOB_SYSTEM], toolkit.TOOLS)
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
        #: document id -> the sentences the job has a writing row for in
        #: core, each with what its writes were to do (:meth:`intents`)
        self.writing: Dict[str, Dict[str, Dict[str, Any]]] = {}
        #: document id -> sentences with a writing row whose write this
        #: worker knows did not land: they are targets again
        self.unsent: Dict[str, set] = {}
        #: document id -> sentence id -> its writing rows as core held them
        #: when this worker first read them (:meth:`intents`), None before
        self.rows_read: Optional[Dict[str, Dict[str, Dict[str, Any]]]] = None
        #: (document id, a stretch's first sentence id) -> how many of that
        #: stretch's writes core refused for something gone
        self.gone_refused: Counter = Counter()
        #: the job's plan (``plan_work`` or the default), once read or kept
        self.plan_made: Optional[Dict[str, Any]] = None
        #: the plan made and not yet kept in core (its row's call failed)
        self.plan_pending: Optional[Dict[str, Any]] = None
        #: the tables the job keeps among its decisions, read once per worker
        self.tables_kept: Optional[set] = None
        #: keys of the proposed changes core holds for the job, and how many
        #: the cap dropped (CONTRACT, added by JG), read once per worker
        self.changes: Optional[set] = None
        self.changes_dropped = 0
        #: the keys (:func:`entry_key`) of the entries the job made, as its
        #: rows hold them, read once per worker and kept as it writes them
        self.made: Optional[set] = None
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
                words, translate = sentence_targets(s, project, job.id)
                if not words and not translate:
                    continue
                # Every word of a sentence the job writes in is named in its
                # writing row (REV-B4-1), which holds JOB_SENTENCE_MAX_WORDS.
                if len(render_sentence(s, project)) > JOB_SENTENCE_MAX_CHARS \
                        or len(s.words) > JOB_SENTENCE_MAX_WORDS:
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
        """The work the job's plan cuts: a document at a time (stretches of
        sentences, or the whole document as one piece), or the whole
        selection as one piece. Documents the plan leaves out are not
        reached."""
        plan = self.plan_made or self.plan(job)
        order = self.planned_order(job, plan)

        def left_out():
            for d in job.order:
                if d not in order and (job.rows.get(d) or {}).get('state') not in ROW_FINAL + ('not-reached',):
                    job.update_row(d, state='not-reached')
        core_job.through_core(job, left_out)
        if plan['pieces'] == SELECTION and SELECTION not in core_job.through_core(job, self.fallen_back):
            self.selection(job, order)
        # Every document still to finish is walked, a selection's too: the
        # walk settles it, ends it done when nothing is left, and works what
        # is (a sentence a person changed during the piece is taken again,
        # a document whose write was put off is worked as a piece of its own).
        deferred = []
        for d in order:
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

    # --- the plan (the owner's ruling 14) -----------------------------------------

    def plan(self, job) -> Dict[str, Any]:
        """The job's plan: read back when the job has one (a resumed job
        never plans again), else made by the planning context and kept. The
        planning context is given the instructions and the documents (names,
        sentences, words, how much is blank) with the assistant's reads and
        code, writes nothing, and ends with ``plan_work``. When it ends
        without a valid one after its budget and one decide-now round, the
        job works in stretches of sentences, and its plan says why."""
        if self.plan_made is not None:
            return self.plan_made
        stored = [r for r in self.rows_of(PLAN_FORM) if r.get('form') == PLAN_FORM]
        if stored and isinstance(stored[0]['value'], dict):
            self.plan_made = self.plan_read(stored[0]['value'])
            return self.plan_made
        if self.plan_pending is None:
            project = self.project()
            facts = self.document_facts(project, job)
            plan, why = None, None
            try:
                plan = self.planning(project, facts)
                why = None if plan else 'no-plan'
            except StretchFailed as e:
                why = e.kind
            made = plan or {'pieces': SENTENCES, 'piece_instructions': '', 'documents': None}
            # Made once: a passing error on its row below sends the same plan
            # again, never plans again (REV-JG-8).
            self.plan_pending = {**made, 'by': 'model' if plan else 'default', 'why': why}
        text = canonical(self.plan_kept(self.plan_pending))
        job.add_decisions([{'form': PLAN_FORM, 'key': analysis_key(text), 'analysis': text, 'count': 1,
                            'document_id': None, 'sentence_id': None}])
        # The job works by its plan only once core holds it.
        self.plan_made = self.plan_pending
        return self.plan_made

    def plan_kept(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """The plan as its decision row holds it: the documents it names
        as their places in the job's order, so the plan of a job of the most
        documents, named in any order, fits one row (REV-JG-3)."""
        named = plan.get('documents')
        if not named:
            return plan
        place = {d: i for i, d in enumerate(self.job.order)}
        return {**plan, 'documents': [place[d] for d in named if d in place]}

    def plan_read(self, value: Dict[str, Any]) -> Dict[str, Any]:
        """The plan as its row holds it (:meth:`plan_kept`), with its
        documents named by id again."""
        places = value.get('documents')
        if not places:
            return value
        order = list(self.job.order)
        return {**value, 'documents': [order[i] for i in places if isinstance(i, int) and 0 <= i < len(order)]}

    def document_facts(self, project: IgtProject, job) -> List[Dict[str, Any]]:
        """What the planning context is told of each document still to work:
        its name, its sentences and words, and how much is blank."""
        out = []
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') in ROW_FINAL:
                continue
            try:
                doc = self.read(project, d)
            except Gone:
                job.update_row(d, state='gone')
                continue
            words = [w for s in doc.sentences for w in s.words]
            out.append({'id': d, 'name': doc.name, 'sentences': len(doc.sentences), 'words': len(words),
                        'blank_words': sum(1 for w in words if word_target(w)),
                        'empty_translations': sum(1 for s in doc.sentences
                                                  if translation_target(s, project, job.id)),
                        'characters': sum(len(render_sentence(s, project)) + 1 for s in doc.sentences)})
        return out

    def planning(self, project: IgtProject, facts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """The planning context: its plan_work, or None. A model that does
        not answer is asked again later, as a piece's is (SPEC 3.7)."""
        from .prompt import JOB_PLAN_NOW, build_plan_prompt
        job = self.job
        while True:
            job.check()
            ws = JobWorkspace(job.client(), project, mode=JobWorkspace.PLAN)
            ws.job_documents = [{'id': f['id'], 'name': f['name']} for f in facts]
            system = build_plan_prompt(project)
            transcript = [{'role': 'user', 'content': self.plan_message(facts)}]
            seed(ws.seen, system, transcript, lambda tool, args: True)
            kit = Toolkit(tools_for=lambda w: toolkit.job_plan_tools(w, plan_only=w.decide_now),
                          call_tool=toolkit.job_plan_call, tracer=TRACER)
            self.trace(ws, system, kit, 'plan')

            def decided():
                ws.decide_now = True
            try:
                result = self.turn(ws, kit, system, transcript, decided)
                if ws.plan_work is None and not ws.decide_now:
                    # One decide-now round, plan_work alone offered.
                    ws.decide_now = True
                    more = transcript + list(result.messages or []) + [{'role': 'user', 'content': JOB_PLAN_NOW}]
                    self.turn(ws, kit, system, more)
                return ws.plan_work
            except (StretchFailed, JobStopped):
                raise
            except TurnCancelled:
                job.check()
                raise JobStopped('cancelled')
            except Exception as e:  # noqa: BLE001 - sorted as a piece's are
                if core_job.core_fault(e) is not None:
                    raise
                if not_answering(e):
                    job.wait_for_model()
                    continue
                kind = failure_kind(e)
                if kind is None:
                    raise
                raise StretchFailed(kind, str(e)) from e

    def plan_message(self, facts: List[Dict[str, Any]]) -> str:
        """What the planning context is handed: the instructions and the
        documents, one line each, at most JOB_PLAN_DOCUMENT_LINES."""
        from ..core.limits import JOB_PLAN_DOCUMENT_LINES
        lines = [f'Instructions from {self.job.starter_name}:', self.job.instructions or '', '',
                 f'The job\'s documents, in its order ({len(facts)}):']
        for f in facts[:JOB_PLAN_DOCUMENT_LINES]:
            lines.append(f'- "{f["name"]}": {_n(f["sentences"], "sentence")}, {_n(f["words"], "word")}, '
                         f'{f["blank_words"]:,} words nobody analysed, {f["empty_translations"]:,} empty '
                         f'translations, {f["characters"]:,} characters.')
        if len(facts) > JOB_PLAN_DOCUMENT_LINES:
            lines.append(f'and {len(facts) - JOB_PLAN_DOCUMENT_LINES} more documents not shown')
        lines += ['', 'Plan the job and end with plan_work.']
        return '\n'.join(lines)

    def planned_order(self, job, plan: Dict[str, Any]) -> List[str]:
        """The documents the job works, in the plan's order: the plan's
        subset when it names one, else the job's own order."""
        named = plan.get('documents')
        if not named:
            return list(job.order)
        return [d for d in named if d in job.rows]

    # --- a selection: one piece for the whole job --------------------------------------

    def selection(self, job, order: List[str]) -> bool:
        """The whole selection as one piece: one model context reads the
        documents with its tools, and what it staged is written document by
        document, each through THE write (:meth:`write`: the gate, the lock,
        the apply rule, the record). The walk then finishes every document
        (:meth:`work`). True when the piece ran, False when it failed (the
        documents are then worked one piece each, and the report says so).

        Every call to core in it goes through ``core_job.through_core``, as
        the walk's do (REV-JG2-3): its start, the piece (taken again from
        its start, as a stretch is, when core fails one of its reads or its
        note), and each document's write and what follows it. When core's
        trouble outlasts the piece's tries, the selection is left to the
        walk, which puts off what core does not take."""
        def begin():
            project_ = self.project()
            live_ = [d for d in order if (job.rows.get(d) or {}).get('state') not in ROW_FINAL]
            for d in live_:
                if (job.rows.get(d) or {}).get('state') != 'working':
                    job.update_row(d, state='working')
            return project_, live_
        project, live = core_job.through_core(job, begin)
        if not live:
            return True
        job.set(current_document=None, message=f'Working on {_n(len(live), "document")} as one piece.')
        while True:
            try:
                staged = core_job.through_core(job, lambda: self.selection_work(project, live),
                                               gave_up=lambda: None)
                if staged is None:
                    # Core's trouble outlasted the piece's tries: the walk
                    # works the documents, and the report's plan says so
                    # when core takes the row (REV-JG3-9).
                    core_job.through_core(job, lambda: self.fall_back(SELECTION, 'failed'), gave_up=lambda: None)
                    return False
                break
            except (JobStopped, Deferred, Gone):
                raise
            except TurnCancelled:
                job.check()
                raise JobStopped('cancelled')
            except StretchFailed:
                self.fall_back(SELECTION, 'failed')
                return False
            except Exception as e:  # noqa: BLE001 - sorted as a piece's are
                if core_job.core_fault(e) is not None:
                    raise
                if not_answering(e):
                    job.wait_for_model()
                    continue
                if failure_kind(e) is None:
                    raise
                self.fall_back(SELECTION, 'failed')
                return False
        ws, note = staged
        # The piece's note and tables, tried again on their own: a passing
        # error on their row never runs the model context again (REV-JG3-9).
        core_job.through_core(job, lambda: self.record_piece(
            project, {'document': None, 'first': None, 'whole': True}, note, ws.tables))
        by_doc = self.ops_by_document(ws, live)
        # Changes no document holds (a guideline, a setting) go with the
        # first document's write, and are proposed there.
        loose = by_doc.pop(None, [])
        read = [d for d in live if d in ws._docs]
        if loose and read:
            by_doc.setdefault(read[0], []).extend(loose)
        # What the piece staged in a document the job does not write in (one
        # outside the job, or one of its own it has finished) is a proposed
        # change, listed in the report: the job may not write there (REV-JG-6).
        # So is a change of no document when the piece read none of the job's.
        from .jobapply import IGNORED_KINDS
        outside = [self.describe(op, ws._docs[d], project) if d in ws._docs else self.describe_loose(op)
                   for d in by_doc if d not in live for op in by_doc[d] if op.get('kind') not in IGNORED_KINDS]
        if not read:
            outside += [self.describe_loose(op) for op in loose if op.get('kind') not in IGNORED_KINDS]
        core_job.through_core(job, lambda: self.record_changes(outside, note))
        for d in live:
            job.check()
            shown = ws.shown.get(d) or set()
            if d not in ws._docs or not (shown or by_doc.get(d)):
                # The piece never read it (its budget ran out, say): it is not
                # recorded as worked. The walk works it as a piece of its own,
                # and the report's plan says so (REV-JG2-5).
                core_job.through_core(job, lambda: self.fall_back(d, NOT_READ))
                continue
            job.set(current_document=d)
            try:
                self.write_piece(project, d, ws, ws._docs[d], by_doc.get(d, []), note, shown)
            except Deferred:
                # Its writes were dropped: it is worked again as a piece of its own.
                core_job.through_core(job, lambda: (self.fall_back(d, 'in-use'), self.defer(d)))
                continue
            except Gone:
                core_job.through_core(job, lambda: job.update_row(d, state='gone'))
                continue
            # What a read printed to the model is what it read, never what a
            # tool loaded (REV-JG3-1): a sentence it was never shown, and did
            # not write in, is worked by the walk in pieces of its own.
            out = self.excluded(d)
            if any(s.id not in shown and s.id not in out for s in ws._docs[d].sentences):
                core_job.through_core(job, lambda: self.fall_back(d, NOT_READ))
        return True

    def write_piece(self, project: IgtProject, document_id: str, ws: JobWorkspace, doc,
                    ops: List[Dict[str, Any]], note: str, shown=frozenset()) -> None:
        """A selection's write in one of the documents its piece read: THE
        write (:meth:`write`), its piece the sentences of the document a read
        printed to the model (``shown``, sentence ids, REV-JG3-1: the gate
        takes out those the job finished), and every sentence's print, so a
        sentence anyone changed since the read is taken again by the walk.
        What it staged in a sentence it was not shown goes to the apply rule
        as any op of the document. Tried again from the gate after core's
        passing trouble, and put off (:class:`Deferred`) when the trouble
        outlasts the tries, as a stretch's document is (REV-JG-4)."""
        def step():
            part = [s for s in doc.sentences if s.id in shown]
            prints = {s.id: ws.sentence_print(doc, s) for s in doc.sentences}
            self.write(project, document_id, ws, doc, part, prints, ops, note, selection=True)

        def put_off():
            raise Deferred(document_id)
        core_job.through_core(self.job, step, gave_up=put_off)

    def entries_that_fit(self, project: IgtProject, ops: List[Dict[str, Any]],
                         selection: bool = False) -> List[Dict[str, Any]]:
        """``ops`` as the lexicon is at the write, asked of every create
        before any piece's write (a stretch, a document, a selection):

        * no entry is created where one fits now (``fitting_entry``, the rule
          ``fit_guard`` holds at staging). When the entry there is the job's
          own, the create is left out and every link naming it names that
          entry. When it is someone else's, made after the piece staged the
          create, the create is marked (:data:`ENTRY_EXISTS`) and proposed
          with its links: nobody chose that entry. So the entry a selection
          links in several documents is created with the first document
          written, and the others link it, even when that write landed and
          the job was then taken up again (REV-JG2-2);
        * no entry the job made before is made again once nothing fits it (a
          person deleted it, merged it away or changed its form or gloss): the
          create is marked (``job_why``, :data:`ENTRY_GONE`), the apply rule
          proposes it, and the links naming it with it (the lead's ruling on
          REV-JG3-5). A write the job cannot tell from one that never landed
          (a crash before its answer) counts as made: the job never risks
          putting back what a person deleted.

        The lexicon is read again for a selection's creates, staged before
        any of its documents was written, and for a create of an entry the
        job made before. A stretch's or a document's other creates were
        staged against the lexicon as it was after the job's last write
        (``fit_guard``), which is not read again."""
        creates = [o for o in ops if o.get('kind') == 'create_entry']
        vocab = {x['id']: x for x in project.vocabs if not x.get('borrowed')}
        if not selection:
            creates = [o for o in creates if o.get('vocab_id') in vocab
                       and entry_key(vocab[o['vocab_id']], o) in self.made_keys()]
        if not creates:
            return ops
        ws = Workspace(self.job.client(), project)
        found: Dict[str, str] = {}
        why: Dict[str, str] = {}
        for o in creates:
            v = vocab.get(o.get('vocab_id'))
            if v is None:
                continue
            item = fitting_entry(v, ws.lexicon(v), o)
            if item is not None and _job_of(item.get('metadata')) == self.job.id:
                found[o.get('key')] = item['id']
            elif item is not None:
                # Someone else's entry, made after the piece staged the
                # create: nobody chose it, so the create and its links are
                # proposed, never linked to it unasked (REV-JG3-8).
                why[o.get('key')] = ENTRY_EXISTS
            elif entry_key(v, o) in self.made_keys():
                why[o.get('key')] = ENTRY_GONE
        if not found and not why:
            return ops
        out = []
        for o in ops:
            if o.get('kind') == 'create_entry' and o.get('key') in found:
                continue
            if o.get('kind') == 'create_entry' and o.get('key') in why:
                o = {**o, 'job_why': why[o['key']]}
            if o.get('kind') in ('link', 'link_phrase') and o.get('new_entry_key') in found:
                o = {**o, 'item_id': found[o['new_entry_key']], 'new_entry_key': None}
            out.append(o)
        return out

    def made_keys(self) -> set:
        """The keys of the entries the job made (:data:`MADE_FORM` rows),
        read from core once per worker and kept as the worker writes them."""
        if self.made is None:
            self.made = {str(r.get('form'))[len(MADE_FORM):] for r in self.job.decisions()
                         if str(r.get('form') or '').startswith(MADE_FORM)}
        return self.made

    def selection_work(self, project: IgtProject, documents: List[str]):
        job = self.job
        job.check()
        ws = JobWorkspace(job.client(), project)
        names = []
        for d in documents:
            row = job.rows.get(d) or {}
            names.append(f'- "{self.names.get(d) or row.get("name") or d}": '
                         f'{_n(row.get("sentences") or 0, "sentence")}')
        lines = ['The job\'s documents, all of them your piece. Read them with the tools.', *names]
        lines += self.instructions_lines()
        lines += ['', 'Your piece: the whole selection above.']
        note = self.run_piece(ws, project, '\n'.join(lines), 'selection')
        return ws, note

    @staticmethod
    def ops_by_document(ws: JobWorkspace, documents: List[str]) -> Dict[Optional[str], List[Dict[str, Any]]]:
        """A piece's ops by the document each writes in (by the token it
        names, among the documents the piece read), None for an op of no
        document: an entry of its own, a guideline, a setting. A create is
        put with every document whose ops link it: the first written creates
        it, and the others find it there (:meth:`entries_that_fit`), so one
        entry linked in several documents is created once (REV-JG2-2)."""
        from .jobapply import token_of
        where: Dict[str, str] = {}
        for d, doc in ws._docs.items():
            for s in doc.sentences:
                where[s.id] = d
                for w in s.words:
                    where[w.id] = d
                    for m in w.morphemes:
                        where[m.id] = d
        out: Dict[Optional[str], List[Dict[str, Any]]] = {}
        creates = {op.get('key'): op for op in ws.ops if op.get('kind') == 'create_entry'}
        placed = set()
        for op in ws.ops:
            if op.get('kind') == 'create_entry':
                continue
            token = token_of(op)
            if token and is_virtual(token):
                token = token.split(':', 1)[1]
            d = op.get('document_id') or where.get(token)
            out.setdefault(d, []).append(op)
            key = op.get('new_entry_key')
            if key in creates and (d, key) not in placed:
                out[d].insert(0, creates[key])
                placed.add((d, key))
        for key, op in creates.items():
            if not any(k == key for _, k in placed):
                out.setdefault(None, []).append(op)
        return out

    @staticmethod
    def describe_loose(op: Dict[str, Any]) -> Dict[str, Any]:
        """A proposed change of no document."""
        after = op.get('form') if op.get('kind') == 'create_entry' else None
        what = op.get('label') or op.get('kind') or ''
        if op.get('job_why'):
            what = f'{what}. {op["job_why"]}'
        return {'kind': op.get('kind'), 'document_id': None, 'document': None, 'ref': None, 'field': None,
                'from': None, 'to': _cut(after, JOB_CHANGE_VALUE_CHARS),
                'label': _cut(what, JOB_CHANGE_VALUE_CHARS)}

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
        unit by its newest operation, so this is whoever wrote last, at its
        ``end_time`` (its ``time`` is its first operation's, REV-B4-4)."""
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
        when = core_job._iso_seconds(last.get('end_time'))
        if when is None:
            return False
        # Only what was written after the job was made counts: the edit its
        # starter made just before pressing Start is not a person in the
        # document (both times are core's, REV-J-B S3-5).
        created = core_job._iso_seconds(self.job.job.get('created_at'))
        if created is not None and when <= created:
            return False
        return self.job.now() - when < JOB_PERSON_QUIET_S

    def quiet(self, last: Optional[Dict[str, Any]], document_id: str) -> bool:
        """Nobody but the job has written in the document since the job's
        last glossing write in it, or since the job was made: ``last``, its
        :meth:`newest_change`, is that write, or older than the job, or there
        is none. Then everything the job wrote there reads as it wrote it,
        and a write of its that is not there never landed (``settle``)."""
        if not last or str(last.get('ref') or '') == self.gloss_ref(document_id):
            return True
        when = core_job._iso_seconds(last.get('end_time'))
        created = core_job._iso_seconds(self.job.job.get('created_at'))
        return when is not None and created is not None and when <= created

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
            # is still the job's own work (or older than the job), nothing
            # was written between that change and this read, so what the job
            # wrote and did not record is exactly as it wrote it (``settle``,
            # :meth:`quiet`).
            doc = self.read(project, document_id, client)
            last = self.newest_change(client, document_id)
            if self.in_use(last, f'job:{job.id}/'):
                return self.defer(document_id)
            self.settle(project, document_id, doc, own=self.quiet(last, document_id))
            whole = self.whole_document(project, doc)
            pending = self.pending(doc, project, document_id, every=self.every_sentence())
            if not pending:
                # The row's counts whole: a record whose row update core
                # failed is in core, and its counts reach the row here.
                job.update_row(document_id, state='done',
                               **self.tally(document_id, (job.rows.get(document_id) or {}).get('skipped')))
                return 'done'
            row = job.rows.get(document_id) or {}
            total, done = row.get('targets') or 0, row.get('done') or 0
            part = pending if whole else pending[:JOB_STRETCH_SENTENCES]
            last = done + len(part)
            job.set(message=f'Sentences {done + 1} to {last} of {max(total, last)}.')
            halve([s.id for s in part], lambda ids: self.attempt(project, document_id, ids),
                  lambda sid, kind: self.skip(document_id, doc, sid, 'failed', kind))

    def whole_document(self, project: IgtProject, doc) -> bool:
        """Whether this document is worked as one piece: the plan says
        ``document``, and the document as the piece's message renders it
        fits JOB_DOCUMENT_PIECE_MAX_CHARS. A document larger than that is
        worked in stretches of sentences, which the report says (a fallback
        row among the job's decisions)."""
        plan = self.plan_made or {}
        if plan.get('pieces') not in (DOCUMENT, SELECTION):
            return False
        if doc.id in self.fallen_back():
            return False
        size = sum(len(render_sentence(s, project)) + 1 for s in doc.sentences)
        if size <= JOB_DOCUMENT_PIECE_MAX_CHARS:
            return True
        self.fall_back(doc.id, 'too-long')
        return False

    def every_sentence(self) -> bool:
        """Whether the walk takes every sentence of a document, empty or
        not: when the plan cut the work by documents or as one selection.
        A document of such a plan that is worked in stretches (too long for
        one piece, or put off from the selection) is still worked whole: the
        fallback changes the size of the pieces, never what is worked
        (REV-JG-7). A plan in sentences walks only sentences that hold
        something empty."""
        return (self.plan_made or {}).get('pieces') in (DOCUMENT, SELECTION)

    def pending(self, doc, project: IgtProject, document_id: str, every: bool = False) -> List[Sentence]:
        """The sentences after the cursor the job works, in document order,
        less those skipped, those recorded already and those the job has
        begun to write in (a writing row, or a word of such a sentence,
        which a split or a merge may have moved into a sentence of another
        id) unless their write is known not to have landed. In stretches,
        only sentences that hold something empty (:func:`sentence_targets`).
        With ``every`` (:meth:`every_sentence`) every such sentence, empty or
        not: what the piece does is its instructions'. A cursor
        whose sentence is gone starts from the top (SPEC 3.8)."""
        row = self.job.rows.get(document_id) or {}
        skipped = {s.get('sentence_id') for s in row.get('skipped') or []}
        recorded = self.recorded.get(document_id) or {}
        skipped |= (self.unlisted.get(document_id) or set()) | (self.too_long.get(document_id) or set())
        skipped |= set(self.writing.get(document_id) or ()) - (self.unsent.get(document_id) or set())
        known = self.known_words(document_id)
        ids = [s.id for s in doc.sentences]
        start = ids.index(row['last_sentence']) + 1 if row.get('last_sentence') in ids else 0
        out = []
        for s in doc.sentences[start:]:
            if s.id in skipped or s.id in recorded:
                continue
            if every:
                if not wrote_in(s, known):
                    out.append(s)
                continue
            words, translate = sentence_targets(s, project, self.job.id, known)
            if words or translate:
                out.append(s)
        return out

    def skip(self, document_id: str, doc, sentence_id: str, reason: str, kind: Optional[str],
             cursor: bool = True) -> None:
        """List a sentence skipped, or once the row's list holds
        :data:`JOB_SKIPPED_PER_DOCUMENT`, count it past the list (core keeps
        no more), and move the cursor past it (unless ``cursor`` is False:
        ``settle`` skips sentences wherever they stand)."""
        row = self.job.rows.get(document_id) or {}
        s = next((x for x in doc.sentences if x.id == sentence_id), None)
        skipped = list(row.get('skipped') or [])
        fields: Dict[str, Any] = {}
        if len(skipped) < JOB_SKIPPED_PER_DOCUMENT:
            skipped.append({'sentence': f's{s.index}' if s else '?', 'sentence_id': sentence_id, 'reason': reason,
                            'kind': kind})
            fields['skipped'] = skipped
        unlisted = self.unlisted.setdefault(document_id, set())
        new = 'skipped' not in fields and sentence_id not in unlisted
        if new:
            unlisted.add(sentence_id)  # counted in the row's tally below
        if cursor and self._after_cursor(row, doc, sentence_id):
            fields['last_sentence'] = sentence_id
        try:
            self.job.update_row(document_id, **fields, **self.tally(document_id, skipped))
        except Exception:
            if new:
                unlisted.discard(sentence_id)  # skipped again when taken again
            raise

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
        """The model's part of a piece of one document (a stretch, or the
        whole document): what it staged, with what the write needs, or None
        when a stretch had nothing left to do."""
        job = self.job
        job.check()
        client = job.client()
        ws = JobWorkspace(client, project)
        doc = self.read(project, document_id, client)
        ws._docs[document_id] = doc
        doc = ws.doc(document_id)
        part = [s for s in doc.sentences if s.id in sentence_ids]
        st = Stretch(doc, project, part, job.id, self.known_words(document_id))
        whole = self.whole_document(project, doc)
        if st.empty() and not self.every_sentence():
            self.record(project, document_id, doc, part, st, Counter(), [])
            return None
        ws.stretch = st
        # Every sentence's print, not only the piece's: an op the model
        # stages anywhere in the document is checked against the sentence
        # as the model read it.
        prints = {s.id: ws.sentence_print(doc, s) for s in doc.sentences}
        message = self.message(ws, project, doc, part, st, whole)
        note = self.run_piece(ws, project, message, document_id)
        piece = {'document': document_id, 'first': part[0].id if part else None, 'whole': whole}
        self.record_piece(project, piece, note, ws.tables, doc, part)
        # What the piece staged outside its document goes with its write and
        # is proposed there, never written: the rule finds no such token in
        # the document under the lock.
        return ws, doc, part, prints, list(ws.ops), note

    def run_piece(self, ws: JobWorkspace, project: IgtProject, message: str, folder: str) -> str:
        """One piece's model context: the job's prompt, the interactive
        assistant's tools (:func:`toolkit.job_piece_tools`), the piece's
        message, the stretch budgets (:class:`Pace`), its rounds to the trace
        folder. Its reply is the piece's note. Raises the model's failures
        for the caller to sort."""
        job = self.job
        system = build_job_prompt(project)
        transcript = [{'role': 'user', 'content': message}]
        seed(ws.seen, system, transcript, lambda tool, args: True)
        kit = Toolkit(tools_for=lambda w: toolkit.job_piece_tools(w, plan_only=w.decide_now),
                      call_tool=toolkit.job_piece_call, tracer=TRACER)
        self.trace(ws, system, kit, folder)

        def decided():
            ws.decide_now = True
        result = self.turn(ws, kit, system, transcript, decided)
        job.check()
        return _cut((result.text or '').strip(), JOB_NOTE_MAX_CHARS)

    def turn(self, ws, kit, system: str, transcript, decided=lambda: None):
        """One model context of the job, under the stretch's budgets, asked
        only while nobody waits for the model (``yield_to_people``)."""
        job = self.job

        def before_call():
            job.check()
            job.yield_to_people()
        pace = Pace(self.cfg.model, before_call=before_call, count=self.count, decided=decided)
        result = run_turn(self.cfg, kit, ws, system, transcript, cancelled=job.cancelled, pace=pace)
        if result.failure is not None:
            raise result.failure
        return result

    def trace(self, ws, system: str, kit, folder: str) -> None:
        if not self.trace_dir:
            return
        # A folder per run of the worker, so a resumed job's pieces,
        # numbered from 1 again, never mix with the first run's.
        self.stretches += 1
        ws.rounds = DiskRounds(os.path.join(self.trace_dir, self.job.id, self.run_id, folder,
                                            f'piece-{self.stretches:04d}'), system, kit.tools_for(ws))

    def message(self, ws: JobWorkspace, project: IgtProject, doc, part: List[Sentence], st: Stretch,
                whole: bool = False) -> str:
        """What a piece of one document is handed (SPEC 3.4): the sentences
        as read_sentences renders them (two before a stretch for context, or
        the whole document), what is empty in them, how their blank forms
        were analysed before, the job's instructions and the plan's."""
        first = part[0].index if part else 1
        if whole:
            context, shown = [], [s.index for s in doc.sentences]
        else:
            context = [s for s in doc.sentences if first - JOB_CONTEXT_SENTENCES <= s.index < first]
            shown = [s.index for s in context + part]
        # Every sentence of the piece, past a read's cap of sentences: a
        # whole document is within JOB_DOCUMENT_PIECE_MAX_CHARS.
        rendered = ws.render(doc, indexes=shown, max_sentences=len(shown))
        lines = [f'Document "{doc.name}".', '', rendered, '']
        for s in part:
            words = [w for w in s.words if w.id in st.words]
            bits = []
            if words:
                bits.append('words ' + ', '.join(f'w{w.index} "{w.surface}"' for w in words))
            if s.id in st.translations:
                bits.append('the translation')
            if bits:
                lines.append(f'Empty in s{s.index}: ' + ' and '.join(bits) + '.')
        precedent = self.precedent(ws, project, list(st.words.values()))
        if precedent:
            lines += ['', precedent]
        lines += self.instructions_lines()
        if whole:
            lines += ['', f'Your piece: the whole document "{doc.name}", {_n(len(doc.sentences), "sentence")}.']
        else:
            refs = ', '.join(f's{s.index}' for s in part)
            context_refs = ', '.join(f's{s.index}' for s in context)
            lines += ['', f'Your piece: {refs}.' + (f' {context_refs} {"is" if len(context) == 1 else "are"} '
                                                     'context.' if context else '')]
        return '\n'.join(lines)

    def instructions_lines(self) -> List[str]:
        """The starter's instructions, verbatim, and the plan's instructions
        for every piece, which add to them and never replace them."""
        lines = ['', f'Instructions from {self.job.starter_name}:', self.job.instructions or '']
        extra = ((self.plan_made or {}).get('piece_instructions') or '').strip()
        if extra:
            lines += ['', 'How to do every piece, as the job was planned:', extra]
        return lines

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
        entries = self.entry_forms(ws, project)
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

    def unsettled(self, document_id: str) -> bool:
        """Whether this worker may not write in the document before it
        settles it (:meth:`settle`): it has not read the job's record of the
        document yet, or a sentence the job began to write in is neither
        recorded, skipped nor known to have sent nothing (a write whose
        record was lost: a crash, a passing error, a write put off)."""
        if document_id not in self.recorded:
            return True
        marks = self.recorded[document_id]
        unsent = self.unsent.get(document_id) or set()
        skipped = {s.get('sentence_id') for s in (self.job.rows.get(document_id) or {}).get('skipped') or []}
        return any(sid not in marks and sid not in unsent and sid not in skipped
                   for sid in self.writing.get(document_id) or ())

    def gate(self, project: IgtProject, document_id: str, client=None) -> None:
        """THE GATE every write of the job in a document passes first (a
        stretch, a document piece, a selection piece, harmonize): when the
        document is :meth:`unsettled`, the document is read, then its newest
        History unit, and :meth:`settle` records or skips what the job
        wrote there and did not record. So no write starts where the job
        does not know what it wrote: a word a person cleared after a write
        whose record was lost is never taken for an empty one (REV-FIX3-1,
        REV-JG-1). A walk settles before each stretch, so on that path this
        reads nothing."""
        if not self.unsettled(document_id):
            return
        client = client or self.job.client()
        fresh = self.read(project, document_id, client)
        last = self.newest_change(client, document_id)
        self.settle(project, document_id, fresh, own=self.quiet(last, document_id))

    def excluded(self, document_id: str) -> set:
        """The sentences of a document no piece writes in: skipped,
        recorded, or begun (a writing row) and not known to have sent
        nothing."""
        row = self.job.rows.get(document_id) or {}
        out = {s.get('sentence_id') for s in row.get('skipped') or []}
        out |= set(self.recorded.get(document_id) or {})
        out |= (self.unlisted.get(document_id) or set()) | (self.too_long.get(document_id) or set())
        out |= set(self.writing.get(document_id) or ()) - (self.unsent.get(document_id) or set())
        return out

    def write(self, project: IgtProject, document_id: str, ws: JobWorkspace, doc, part: List[Sentence],
              prints: Dict[str, str], ops: List[Dict[str, Any]], note: str = '', selection: bool = False) -> None:
        """THE write of every piece of the job in one document, whatever the
        plan cut (a stretch, a whole document, the whole selection): through
        :meth:`gate` first, then under the document's lock by the apply rule
        (SPEC 5.4), its writing rows before it is sent (:meth:`intend`), then
        its record (:meth:`record`) and the changes it proposes
        (:meth:`record_changes`). ``doc`` is the document as the piece read
        it, ``part`` the piece's sentences in it, ``selection`` whether it is
        a selection's write (:meth:`entries_that_fit`).

        Safe to do again after a failure anywhere in it: the gate settles
        what landed, a sentence it settles (recorded, or skipped as
        interrupted) leaves the piece and the ops the piece staged there are
        dropped, never applied again nor applied where a person removed what
        landed. A word written is no longer a target, a translation written
        is the job's own, and a sentence recorded is not recorded again."""
        job = self.job
        self.gate(project, document_id)
        ops = self.entries_that_fit(project, ops, selection)
        # A sentence of the piece the job has written in already (a write of
        # this piece that landed before a crash or a passing error, settled
        # now: recorded, or skipped as interrupted) leaves the piece, and
        # what the piece staged there is not written again. A stretch's or
        # a document piece's sentences never hold one: the walk leaves them
        # out. Other sentences the job finished leave the piece too, and
        # what was staged there goes to the rule like any op outside it.
        written = set(self.writing.get(document_id) or ()) - (self.unsent.get(document_id) or set())
        again = {s.id for s in part if s.id in written}
        if again:
            from .jobapply import token_of
            where = Stretch(doc, project, [], job.id)
            ops = [o for o in ops if getattr(where.sentence_of(token_of(o)), 'id', None) not in again]
        out = self.excluded(document_id)
        part = [s for s in part if s.id not in out]
        st = Stretch(doc, project, part, job.id, self.known_words(document_id))
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
                    written_ops, counts, changed, after, vouched, proposed = self.write_held(
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
                if _gone_now(e) and not e.wrote and part:
                    # Refused for something gone, nothing landed: the
                    # stretch's sentences are skipped as changed the
                    # JOB_DEFER_ROUNDS-th time the same stretch (known by its
                    # first sentence) is refused, never the document ended in
                    # use for it (REV-FIX3-5, REV-B4-3).
                    refused = (document_id, part[0].id)
                    self.gone_refused[refused] += 1
                    if self.gone_refused[refused] >= JOB_DEFER_ROUNDS:
                        for s in part:
                            self.skip(document_id, doc, s.id, 'changed', None)
                        return
                if _status(e) in (409, 423) or _gone_now(e):
                    raise Deferred(document_id) from e
                raise
            break
        # The write landed: what the rule did not apply is recorded as the
        # piece's proposed changes, never before (REV-J-B2 S4).
        self.record_changes(proposed, note)
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
        kept, counts, changed, proposed = self.recheck(ws, project, fresh, st, prints, ops)
        blank = {w.id for s in fresh.sentences if s.id in st.sentence_ids and s.id not in changed
                 for w in s.words if w.id in st.words and word_target(w)}
        if kept:
            self.machine_status(project, kept)
            sentences, made = self.intend(document_id, st, kept, fresh)
            try:
                kept = self.apply(client, project, document_id, group, kept, seed_id, counts)
            except (PlanOutOfDate, Deferred, PlanError) as e:
                # Known to have written nothing (out of date is found before
                # any write, a plan error says whether anything landed): its
                # sentences are targets again, and its entries were not made.
                if not (isinstance(e, PlanError) and e.wrote):
                    self.unsent.setdefault(document_id, set()).update(sentences)
                    self.made_keys().difference_update(made.values())
                raise
            # An entry the write left out (its links out of date) was not made.
            written = {o.get('key') for o in kept if o.get('kind') == 'create_entry'}
            self.made_keys().difference_update(k for key, k in made.items() if key not in written)
        known = client.document_versions.get(document_id)
        after = self.read(project, document_id, client)
        exact = known is not None and str(after.version) == str(known)
        if not exact:
            logger.info('Job %s: %s moved during the write (version %s, read %s): its words are not vouched for',
                        job.id, document_id, known, after.version)
        return kept, counts, changed, after, frozenset(blank) if exact else frozenset(), proposed

    def intend(self, document_id: str, st: Stretch, kept: List[Dict[str, Any]], fresh):
        """Before a write is sent: a writing row in core for each sentence
        ``kept`` writes in, saying what it writes there and naming every
        word of the sentence as ``fresh`` (the document under the lock)
        holds it, and a row for each entry it creates (:data:`MADE_FORM`),
        in one call. ``(the sentences, {create's key: entry key})``: the
        sentences are no longer targets once the call has landed, nor is any
        sentence a word of theirs is moved into, whatever happens to what
        the write leaves in them (``settle``, :meth:`known_words`), and the
        entries count as made by the job from then on."""
        plans: Dict[str, Dict[str, Any]] = {}
        translation = translation_layer(st.project)
        made: Dict[str, str] = {}
        for o in kept:
            if o.get('kind') == 'create_entry':
                v = next((x for x in st.project.vocabs if x['id'] == o.get('vocab_id')), None)
                if v is not None and entry_key(v, o) not in self.made_keys():
                    made[o.get('key')] = entry_key(v, o)
                continue
            token = o.get('analysis_word_id') or o.get('word_id') or o.get('token_id')
            s = st.sentence_of(token)
            if s is None:
                continue
            plan = plans.setdefault(s.id, {'translation': None, 'words': []})
            if token == s.id:
                # A value of the sentence's own: its translation only when
                # it is the translation field the job writes, by the field's
                # layer, never another sentence field (REV-JG-11).
                if o.get('kind') == 'set_span' and token in st.translations and o.get('layer_id') == translation:
                    plan['translation'] = 'refreshed' if o.get('span_id') is not None else 'translations'
            else:
                tag = word_tag(st.word_of.get(token, token))
                if tag not in plan['words']:
                    plan['words'].append(tag)
        now = {s.id: s for s in fresh.sentences}
        for sid, plan in plans.items():
            s = now.get(sid) or st.where.get(sid)
            plan['others'] = [word_tag(w.id) for w in (s.words if s is not None else [])
                              if word_tag(w.id) not in plan['words']]
        rows = []
        for sid, plan in plans.items():
            text = writing_text(document_id, plan['translation'], plan['words'], plan['others'])
            rows.append({'form': writing_form(sid), 'key': analysis_key(text), 'analysis': text, 'count': 1,
                         'document_id': document_id, 'sentence_id': sid})
        for key in dict.fromkeys(made.values()):
            rows.append({'form': MADE_FORM + key, 'key': key, 'analysis': '{}', 'count': 1,
                         'document_id': document_id, 'sentence_id': None})
        if rows:
            self.job.add_decisions(rows)
        self.made_keys().update(made.values())
        writing = self.writing.setdefault(document_id, {})
        unsent = self.unsent.setdefault(document_id, set())
        for sid, plan in plans.items():
            # A try after one known to have sent nothing replaces it: what
            # that try was for was never written (REV-B4-7).
            writing[sid] = self.merged(None if sid in unsent else writing.get(sid), plan)
        unsent.difference_update(plans)
        return list(plans), made

    @staticmethod
    def merged(had: Optional[Dict[str, Any]], plan: Dict[str, Any]) -> Dict[str, Any]:
        """Two writing rows of one sentence as one (a try after one that
        landed nothing): every word either analyses, every word either names,
        and the translation counted as replacing a machine draft when either
        says so."""
        if not had:
            return {'translation': plan.get('translation'), 'words': set(plan.get('words') or ()),
                    'others': set(plan.get('others') or ())}
        translation = had.get('translation') or plan.get('translation')
        if 'refreshed' in (had.get('translation'), plan.get('translation')):
            translation = 'refreshed'
        return {'translation': translation, 'words': set(had['words']) | set(plan.get('words') or ()),
                'others': set(had.get('others') or ()) | set(plan.get('others') or ())}

    def intents(self, document_id: str) -> Dict[str, Dict[str, Any]]:
        """The writing rows core holds for a document, one per sentence
        (:meth:`merged`), those of sentences it no longer holds included (a
        sentence merged away, whose words are still the ones the job wrote
        in, REV-B4-1). Every row of the job is read once per worker (``GET
        /jobs/{id}/decisions``): no other worker writes rows while this one
        holds the job, and this one's own are kept as it writes them
        (:meth:`intend`)."""
        if self.rows_read is None:
            rows: Dict[str, Dict[str, Dict[str, Any]]] = {}
            for r in self.job.decisions():
                form = r.get('form') or ''
                if not form.startswith(WRITING_FORM):
                    continue
                try:
                    plan = json.loads(r['analysis'])
                except (ValueError, TypeError, KeyError):
                    continue
                if not isinstance(plan, dict):
                    continue
                by_sentence = rows.setdefault(plan.get('document'), {})
                sid = form[len(WRITING_FORM):]
                by_sentence[sid] = self.merged(by_sentence.get(sid), plan)
            self.rows_read = rows
        return dict(self.rows_read.get(document_id) or {})

    def known_words(self, document_id: str) -> frozenset:
        """The tags of every word of every sentence of the document the job
        began to write in (its writing rows), wherever a person has since
        moved them, but those of a sentence whose write this worker knows
        sent nothing. A sentence holding any of them is not a target
        (:func:`wrote_in`, REV-B4-1)."""
        unsent = self.unsent.get(document_id) or set()
        out: set = set()
        for sid, plan in (self.writing.get(document_id) or {}).items():
            if sid not in unsent:
                out |= set(plan.get('words') or ()) | set(plan.get('others') or ())
        return frozenset(out)

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
        label = job_label(self.job.instructions)
        for n in range(2):
            try:
                with client.operation(label, kind='job', ref=self.gloss_ref(document_id), group_id=group,
                                      keys={'seed': seed_id, 'stamps': {}}):
                    try:
                        execute_plan(client, kept, source=self.source, label=label, project=project,
                                     stamp_mode='machine', detail=self.detail, seed=seed_id)
                    except (PlanError, PlanOutOfDate):
                        raise
                    except Exception as e:  # noqa: BLE001 - raised before the first write
                        # The plan's reads (offsets, scopes, entries) come
                        # before its first write, and once it writes nothing
                        # leaves it but a PlanError or PlanOutOfDate
                        # (``applying``). So nothing was sent (REV-B4-6). The
                        # operation's own end, after the write, stays outside:
                        # its error may follow a write that landed.
                        raise PlanError(str(e), 0, len(kept)) from e
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
        """The ops to write to ``fresh`` (the document under the lock), and
        those recorded as proposed changes: an op whose sentence changed
        since the piece read it is dropped as ``changed`` (the piece is taken
        again), and the rest go to THE apply rule
        (:func:`plaid_agent.igt.jobapply.decide`), which applies what fills
        something empty or revises the job's own work and proposes the rest.
        ``(kept, counts, changed sentences, proposed changes)``."""
        from . import jobapply
        counts = Counter()
        now = {s.id: s for s in fresh.sentences}
        changed = set()
        for sid, p in prints.items():
            s = now.get(sid)
            if s is None or ws.sentence_print(fresh, s) != p:
                changed.add(sid)
        live = []
        for op in ops:
            s = st.sentence_of(jobapply.token_of(op))
            if s is not None and s.id in changed:
                counts['changed'] += 1
                continue
            live.append(op)
        known = self.known_words(fresh.id)
        vouch: Dict[str, Any] = {}

        def commented() -> set:
            if 'commented' not in vouch:
                vouch['commented'] = self.commented(ws.client, project, fresh.id)
            return vouch['commented']

        def own(w) -> bool:
            # The words the job vouches for, and the comments, read once,
            # only when an op asks about a word the job wrote on.
            if not any(job_piece(p, self.job.id) for p in word_pieces(w)):
                return False
            if 'recorded' not in vouch:
                vouch['recorded'] = self.recorded_words({fresh.id: fresh})
            return harmonize_bar(w, self.job.id, vouch['recorded'], commented()) is None

        def blank(w) -> bool:
            # The comments are read only for a word blank by its pieces.
            return blank_word(w, self.job.id) and blank_word(w, self.job.id, commented())

        def value_blank(s, name) -> bool:
            return blank_value(s, name, self.job.id) and blank_value(s, name, self.job.id, commented())

        def value_own(s, name) -> bool:
            return own_value(s, name, self.job.id) and own_value(s, name, self.job.id, commented())
        rule = jobapply.Rule(fresh, project, known, own=own, target=blank, tag=word_tag,
                             job_piece=lambda md: job_piece(md, self.job.id), value_blank=value_blank,
                             value_own=value_own)

        def sentence_of(token):
            s = st.sentence_of(token)
            return s.id if s is not None else None

        def reshaped(op):
            got = ws.op_sentences(op, st.doc) if st.doc is not None else None
            return set(got) if got is not None else None
        fates = jobapply.decide(live, rule, sentence_of, reshaped)
        kept = [op for op, fate in zip(live, fates) if fate == jobapply.APPLY]
        proposed = [self.describe(op, self.doc_of(ws, op, fresh), project) if self.doc_of(ws, op, fresh) is not None
                    else self.describe_loose(op) for op, fate in zip(live, fates) if fate == jobapply.PROPOSE]
        counts['proposed'] += len(proposed)
        return kept, counts, changed, proposed

    @staticmethod
    def doc_of(ws: JobWorkspace, op: Dict[str, Any], fresh):
        """The document an op writes in: ``fresh`` (the document under the
        lock) when it holds the op's token, else another the piece read, else
        None (an op of no document)."""
        from .jobapply import _found, token_of
        token = token_of(op)
        if op.get('document_id') == fresh.id or (token and _found(fresh, token) is not None):
            return fresh
        for doc in ws._docs.values():
            if doc.id == op.get('document_id') or (token and _found(doc, token) is not None):
                return doc
        return None

    def describe(self, op: Dict[str, Any], doc, project: IgtProject) -> Dict[str, Any]:
        """A proposed change in the bounded form the report keeps and a
        follow-up conversation reads (CONTRACT, added by JG): its kind, where
        (the document and the reference), the field, the value it would
        replace and the value it would write, and the plan's own words for
        it. Each value is cut at JOB_CHANGE_VALUE_CHARS."""
        from .jobapply import _found, token_of
        kind = op.get('kind')
        hit = _found(doc, token_of(op))
        ref = field = before = after = None
        if hit is not None:
            s, w, m = hit
            ref = f's{s.index}' + (f'.w{w.index}' if w is not None else '') + (
                f'.m{m.index}' if m is not None and not m.virtual else '')
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        if kind == 'set_span':
            f = project.field_by_layer(op.get('layer_id'))
            field = f.name if f else None
            if hit is not None and f is not None:
                holder = hit[2] if f.scope == 'Morpheme' else hit[1] if f.scope == 'Word' else hit[0]
                sp = holder.fields.get(f.name) if holder is not None else None
                before = sp.value if sp is not None else None
            after = op.get('value')
        elif kind == 'set_analysis':
            if hit is not None and hit[1] is not None and word_state(hit[1]) != 'unanalyzed':
                before = rendering(word_analysis(hit[1]), gloss)
            layer = getattr(project.gloss_field('Morpheme'), 'layer_id', None)
            after = rendering({'morphemes': [{'form': m.get('form'), 'equals': m.get('equals_before'),
                                              'fields': {gloss: f.get('value') for f in m.get('fields') or []
                                                         if f.get('layer_id') == layer}}
                                             for m in op.get('morphemes') or []]}, gloss)
        elif kind == 'link':
            if hit is not None and hit[2] is not None and hit[2].link is not None:
                before = hit[2].link.form
            after = op.get('entry_form') or op.get('morpheme_form')
        elif kind == 'create_entry':
            after = op.get('form')
        what = (op.get('label') or kind or '')
        if op.get('job_why'):
            what = f'{what}. {op["job_why"]}'
        return {'kind': kind, 'document_id': doc.id, 'document': doc.name, 'ref': ref, 'field': field,
                'from': _cut(before, JOB_CHANGE_VALUE_CHARS), 'to': _cut(after, JOB_CHANGE_VALUE_CHARS),
                'label': _cut(what, JOB_CHANGE_VALUE_CHARS)}

    # --- what a job keeps besides its writes (CONTRACT, added by JG) -------------------

    def rows_of(self, prefix: str) -> List[Dict[str, Any]]:
        """The job's decision rows whose form starts ``prefix``, each with its
        analysis read (an unreadable one left out)."""
        out = []
        for r in self.job.decisions():
            if str(r.get('form') or '').startswith(prefix):
                try:
                    value = json.loads(r['analysis'])
                except (ValueError, TypeError, KeyError):
                    continue
                out.append({**r, 'value': value})
        return out

    def record_changes(self, changes: List[Dict[str, Any]], note: str = '') -> None:
        """Keep the changes a piece proposed among the job's decisions, each
        once (keyed by what it is), at most JOB_CHANGES_MAX for the job: past
        the cap a change is only counted (a row whose count grows), and the
        report says how many."""
        if not changes:
            return
        if self.changes is None:
            self.changes = {r.get('key') for r in self.job.decisions()
                            if str(r.get('form') or '').startswith(CHANGE_FORM)}
        rows, dropped, keys = [], 0, []
        for c in changes:
            text = self.change_text(c, note)
            key = analysis_key(canonical(c))
            if key in self.changes or key in keys:
                continue
            if len(self.changes) + len(keys) >= JOB_CHANGES_MAX:
                dropped += 1
                continue
            keys.append(key)
            rows.append({'form': CHANGE_FORM + key, 'key': key, 'analysis': text, 'count': 1,
                         'document_id': c.get('document_id'), 'sentence_id': None})
        if dropped:
            rows.append({'form': DROPPED_FORM, 'key': 'dropped', 'analysis': '{}', 'count': dropped,
                         'document_id': None, 'sentence_id': None})
        if rows:
            self.job.add_decisions(rows)
        # Kept as held only once core took them: a call core failed is made
        # again, never found "kept" by the step taken again (REV-JG3-2).
        self.changes.update(keys)

    @staticmethod
    def change_text(change: Dict[str, Any], note: str) -> str:
        """A proposed change as its decision row keeps it, with the first
        line of its piece's note. Its values are each cut at
        JOB_CHANGE_VALUE_CHARS, and cut shorter while the row would pass
        JOB_ANALYSIS_MAX_CHARS, which values of characters JSON escapes can
        (REV-JG-20)."""
        limit = JOB_CHANGE_VALUE_CHARS
        while True:
            row = {k: (_cut(v, limit) if isinstance(v, str) else v) for k, v in change.items()}
            text = canonical({**row, 'note': _cut(_first_line(note), limit)})
            if len(text) <= JOB_ANALYSIS_MAX_CHARS or limit <= 1:
                return text
            limit //= 2

    def record_piece(self, project: IgtProject, piece: Dict[str, Any], note: str, tables, doc=None,
                     part=()) -> None:
        """Keep a piece's note and the tables its code made among the job's
        decisions, keyed by the piece (its document and first sentence), so a
        piece done again after a put-off write keeps its first note."""
        key = analysis_key(canonical(piece))
        where = None
        if doc is not None and part:
            where = f's{part[0].index}' + (f' to s{part[-1].index}' if len(part) > 1 else '')
        rows = []
        if note:
            text = canonical({'document': piece.get('document'), 'name': doc.name if doc is not None else None,
                              'sentences': None if piece.get('whole') else where, 'note': note})
            rows.append({'form': NOTE_FORM + key, 'key': key, 'analysis': text, 'count': 1,
                         'document_id': piece.get('document'), 'sentence_id': None})
        if self.tables_kept is None and tables:
            self.tables_kept = {str(r.get('form'))[len(TABLE_FORM):].rsplit(' ', 1)[0] for r in self.job.decisions()
                                if str(r.get('form') or '').startswith(TABLE_FORM)}
        # The job keeps JOB_TABLES_MAX tables, the report's own cap, and
        # counts the rest (REV-JG-15). A piece taken again keeps its own.
        kept = self.tables_kept if self.tables_kept is not None else set()
        room = max(0, JOB_TABLES_MAX - len(kept))
        keep = []
        for i, t in enumerate(list(tables)[:JOB_TABLES_PER_PIECE]):
            if f'{key} {i:02d}' in kept:
                keep.append((i, t))
            elif room:
                room -= 1
                keep.append((i, t))
        dropped = len(list(tables)[:JOB_TABLES_PER_PIECE]) - len(keep)
        if dropped:
            # Keyed by the piece, as its note and tables are: a piece taken
            # again keeps its first run's count (REV-JG3-7).
            text = canonical({'dropped': dropped})
            rows.append({'form': f'{TABLES_DROPPED_FORM} {key}', 'key': key, 'analysis': text,
                         'count': 1, 'document_id': None, 'sentence_id': None})
        for i, t in keep:
            for part_no, text in enumerate(table_rows_text(t)):
                tkey = analysis_key(f'{key}/{i}/{part_no}')
                rows.append({'form': f'{TABLE_FORM}{key} {i:02d} {part_no:03d}', 'key': tkey, 'analysis': text,
                             'count': 1, 'document_id': piece.get('document'), 'sentence_id': None})
        if rows:
            self.job.add_decisions(rows)
        kept.update(f'{key} {i:02d}' for i, _ in keep)

    def fallen_back(self) -> Dict[str, str]:
        """Document id (or ``selection``) -> why it was worked in smaller
        pieces than the plan's, as the job's decisions hold it."""
        if getattr(self, '_fallbacks', None) is None:
            # Kept only once read whole: a read core fails is read again.
            read = {}
            for r in self.rows_of(FALLBACK_FORM):
                v = r['value']
                if isinstance(v, dict):
                    read[str(v.get('document'))] = v.get('reason')
            self._fallbacks = read
        return self._fallbacks

    def fall_back(self, what: str, reason: str) -> None:
        """Record that ``what`` (a document, or ``selection``) is worked in
        smaller pieces than the plan's, and why. Kept here only once core
        holds it, so a call core fails is made again."""
        if what in self.fallen_back():
            return
        text = canonical({'document': what, 'reason': reason})
        self.job.add_decisions([{'form': FALLBACK_FORM + what, 'key': analysis_key(text), 'analysis': text,
                                 'count': 1, 'document_id': None if what == SELECTION else what,
                                 'sentence_id': None}])
        self._fallbacks[what] = reason

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
        layer = translation_layer(project)
        translated = {o.get('token_id'): o for o in ops if o.get('kind') == 'set_span' and o.get('layer_id') == layer}
        # What the write was for: a target it wrote that reads blank now was
        # cleared by a person under the lock, never left by the model
        # (REV-B4-2, as ``settle`` lists it, REV-FIX3-3).
        wrote = {st.word_of.get(t, t) for o in ops if o.get('kind') != 'create_entry'
                 for t in [o.get('analysis_word_id') or o.get('word_id') or o.get('token_id')]
                 if not (o.get('kind') == 'set_span' and t in st.translations)}
        # Taken off only once the record holding it is in core (below).
        extra = Counter(self.carry.get(document_id) or {})
        extra['changed'] += dropped.get('changed', 0)
        extra['proposed'] += dropped.get('proposed', 0)
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
                if translated_by(cur, project, job.id) and s.id in translated:
                    translation = 'refreshed' if translated[s.id].get('span_id') is not None else 'translations'
                else:
                    translation = 'left' if state == 'empty' and s.id not in translated else None
            records.append(self.sentence_record(document_id, cur, [w for w in words if not (
                w.id in wrote and word_target(w))], translation, made, vouched))
        if records:
            for k, n in extra.items():
                records[0]['counts'][k] = records[0]['counts'].get(k, 0) + n
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
        if records:
            self.carry.pop(document_id, None)
        elif any(extra.values()):
            self.carry[document_id] = extra

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
            elif job_wrote(w, self.job.id):
                # Confirmed by a person since it was written: counted, never
                # the job's to harmonize, nor a decision of its (REV-B4-5).
                counts['words'] += 1
                counts['links'] += sum(1 for m in word_analysis(w, made)['morphemes'] if m['entry'])
            elif word_target(w):
                counts['left'] += 1
                left.append({'ref': f's{s.index}.w{w.index}', 'begin': w.begin, 'form': w.surface})
        if translation:
            counts['left_translations' if translation == 'left' else translation] += 1
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
        job began to write in (its writing row) without recording it, which a
        crash, an error or a write put off between a write and its record
        leaves (SPEC 3.8). Such a sentence is recorded from the document as it
        is, as its stretch would have recorded it: the job's own words and
        translation, and the targets left blank. One with nothing of the job
        left in it is a target again when nobody wrote since the job's last
        write (its write never landed), else skipped as ``interrupted``: a
        person may have removed the job's work, which the job never writes
        again (REV-FIX3-1). Its words are vouched for only
        when ``own`` (:meth:`quiet`: the newest change of the document is the
        job's own glossing, or older than the job), so that nobody wrote
        since: otherwise a person's deletion would read as the job's work
        (REV-J-B3 B3-2)."""
        job = self.job
        if document_id not in self.recorded:
            ids = [s.id for s in doc.sentences]
            marks = self.marks_in_core(ids)
            self.writing[document_id] = self.intents(document_id)
            self.recorded[document_id] = marks
            row = job.rows.get(document_id) or {}
            if self.recorded[document_id]:
                try:
                    job.update_row(document_id, **self.tally(document_id, row.get('skipped')))
                except Exception:
                    # Read again, and the row written, when taken again.
                    self.recorded.pop(document_id, None)
                    raise
        marks = self.recorded[document_id]
        writing = self.writing[document_id]
        unsent = self.unsent.setdefault(document_id, set())
        skipped = {s.get('sentence_id') for s in (job.rows.get(document_id) or {}).get('skipped') or []}
        orphans = []
        for s in doc.sentences:
            # Only a sentence the job began to write in (a writing row,
            # REV-FIX3-1), and not recorded or skipped since.
            if s.id not in writing or s.id in marks or s.id in skipped or s.id in unsent:
                continue
            mine = [w for w in s.words if job_owned(w, job.id)]
            state = translation_state(s, project, job.id)
            ours = translated_by(s, project, job.id)
            # Did the job's write land here: a piece naming the job, a person
            # having confirmed it since or not (REV-B4-5).
            if not ours and not any(_job_of(p) == job.id for w in s.words for p in word_pieces(w)):
                # Nothing of the job is in it. When nobody wrote since the
                # job's last write, its write here never landed: a target
                # again. Otherwise a person may have removed what landed,
                # and the job leaves the sentence.
                if own:
                    unsent.add(s.id)
                else:
                    self.skip(document_id, doc, s.id, INTERRUPTED, None, cursor=False)
                continue
            # As its stretch would have recorded it (REV-J-B3 B3-7): the
            # job's words, the targets still blank that it was not writing
            # (left: a target it wrote that reads blank now was cleared by a
            # person, or its batch never landed, REV-FIX3-3), and the
            # translation, written (as its writing row says, filled or
            # replaced) or left blank.
            plan = writing[s.id]
            ids = {w.id for w in mine}
            words = [w for w in s.words if w.id in ids or job_wrote(w, job.id)
                     or (word_target(w) and word_tag(w.id) not in plan['words'])]
            if ours:
                translation = 'refreshed' if plan.get('translation') == 'refreshed' else 'translations'
            else:
                translation = 'left' if state == 'empty' and not plan.get('translation') else None
            orphans.append(self.sentence_record(document_id, s, words, translation,
                                                vouched=ids if own else frozenset()))
        if orphans:
            self.commit(document_id, orphans, {})

    # --- harmonize (SPEC 8) -------------------------------------------------------------

    def harmonize(self, job) -> Dict[str, Any]:
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
                # Through the gate, as every write of the job: what the job
                # wrote and did not record is recorded first, so harmonize
                # never takes a word it wrote for one it cannot vouch for, or
                # a word a person cleared for the job's.
                self.gate(project, d, client)
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
                    a = harmonized_part(full)
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
                a = harmonized_part(x['analysis'])
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
                    ws = JobWorkspace(client, project)
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

    def entries(self, job) -> Dict[str, Any]:
        """The entries this job created, read after its last write, and among
        them those nothing links (``unlinked``). A job deletes nothing (the
        lead's ruling on REV-JG2-1): an entry of the job with no links is
        left as it is, listed for a person to delete from the Entries
        screen's machine drafts or in a conversation about the job. Reads
        only, so a stopped job reports its entries the same way."""
        project = self.project()
        ws = Workspace(job.client(), project)
        created, unlinked = [], []
        for v in project.vocabs:
            if v.get('borrowed'):
                continue
            gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
            for it in ws.lexicon(v):
                md = it.get('metadata') or {}
                if _job_of(md) != job.id:
                    continue
                entry = {'id': it['id'], 'lexicon': v['id'], 'form': it.get('form'),
                         'gloss': md.get(gloss) if gloss else None}
                created.append(entry)
                if not self.linked(ws, it['id']):
                    unlinked.append(entry)
        return entries_part(created, unlinked)

    @staticmethod
    def linked(ws: Workspace, item_id: str) -> bool:
        """Whether anything links to entry ``item_id``: one query, asked of
        the job's entries alone, in place of a walk of every document of the
        project (REV-J-B S3-10)."""
        return bool(ws.corpus.entities([['vocab', '?v', {}], ['=', '?v.id', item_id], ['vocab-link', '?t', '?v']],
                                       ['?t'], 1))

    # --- the report (SPEC 9) --------------------------------------------------------------

    def document_reports(self, job) -> List[Dict[str, Any]]:
        out = []
        blank = self.left_blank(job)
        rows = [job.rows.get(d) or {} for d in job.order]
        # "Left blank" lists only what the job filled somewhere: a job that
        # wrote no translation does not list every translation it passed,
        # nor one that analysed no word every blank word (a dumb rule: the
        # job has no task types, its writes say what it did).
        filled_words = any((r.get('counts') or {}).get('words') for r in rows)
        filled_translations = any((r.get('counts') or {}).get('translations')
                                  or (r.get('counts') or {}).get('refreshed') for r in rows)
        for d, row in zip(job.order, rows):
            state = row.get('state')
            counts = row.get('counts') or empty_counts()
            # What the job could not decide, for people to (CONTRACT, added by
            # JB): every target of the document's recorded sentences it left
            # blank, cut as every report list is. A sentence whose record
            # could not hold its whole list counts the rest as more.
            listed = [e for e in blank.get(d) or [] if (filled_words if e.get('form') is not None
                                                        else filled_translations)]
            counted = ((counts.get('left') or 0) if filled_words else 0) + (
                (counts.get('left_translations') or 0) if filled_translations else 0)
            left, _ = core_job.cut(listed)
            out.append({'document_id': d, 'name': self.names.get(d) or row.get('name'),
                        'state': state if state in ('done', 'in-use', 'gone') else 'not-reached',
                        'sentences': row.get('sentences'), 'targets': row.get('targets'), 'done': row.get('done'),
                        'counts': counts, 'skipped': list(row.get('skipped') or []),
                        'gloss_group': row.get('gloss_group'), 'harmonize_group': row.get('harmonize_group'),
                        'left': left, 'left_more': max(len(listed), counted) - len(left)})
        return out

    def summarize(self, job, report: Dict[str, Any]) -> Optional[str]:
        """The report's prose, by the job's final model context: given the
        report's totals, each document's state and counts, each piece's note
        and the tables pieces' code made (bounded), and how many changes the
        job proposed, it writes a short summary for a person, with no tools.
        The report's own sections stay authoritative: the prose is told to
        state no count they do not hold."""
        from .prompt import build_summary_prompt
        project = self.project()
        job.set(message='Writing the report.')
        message = summary_message(report)
        while True:
            job.check()
            ws = JobWorkspace(job.client(), project, mode=JobWorkspace.PLAN)
            system = build_summary_prompt(project)
            kit = Toolkit(tools_for=lambda w: [], call_tool=lambda w, name, args: '', tracer=TRACER)
            self.trace(ws, system, kit, 'summary')
            try:
                result = self.turn(ws, kit, system, [{'role': 'user', 'content': message}])
                return _cut((result.text or '').strip(), JOB_SUMMARY_MAX_CHARS) or None
            except TurnCancelled:
                job.check()
                raise JobStopped('cancelled')
            except (StretchFailed, JobStopped):
                raise
            except Exception as e:  # noqa: BLE001 - a model that does not answer is waited for
                if core_job.core_fault(e) is None and not_answering(e):
                    job.wait_for_model()
                    continue
                raise

    def report_parts(self, job) -> Dict[str, Any]:
        """The report's parts the job keeps besides its writes (CONTRACT,
        added by JG): the plan, the changes it proposed with how many the cap
        dropped, each piece's note, and the tables pieces' code made, each
        list cut at JOB_REPORT_LIST_MAX. Read from the job's decisions, so a
        resumed job reports its earlier runs too. Empty parts when they
        cannot be read: the report is still written."""
        try:
            rows = core_job.through_core(job, job.decisions)
        except Exception as e:  # noqa: BLE001 - a report without these parts rather than none
            logger.warning('Job %s: its plan and proposed changes could not be read for the report: %s', job.id, e)
            rows = []
        plan, changes, notes, dropped, fallback, tables_dropped = None, [], [], 0, [], 0
        tables: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            form = str(r.get('form') or '')
            if form == DROPPED_FORM:
                dropped += r.get('count') or 0
                continue
            if form.startswith(TABLES_DROPPED_FORM + ' '):
                # One row per piece, its count in its analysis: a piece taken
                # again sends its row again, which core counts, and is
                # counted once here (REV-JG2-8).
                try:
                    tables_dropped += int(json.loads(r['analysis']).get('dropped') or 0)
                except (ValueError, TypeError, KeyError, AttributeError):
                    pass
                continue
            if not form.startswith(' '):
                continue
            try:
                value = json.loads(r['analysis'])
            except (ValueError, TypeError, KeyError):
                continue
            if form == PLAN_FORM:
                plan = self.plan_read(value) if isinstance(value, dict) else None
            elif form.startswith(FALLBACK_FORM):
                fallback.append({'document_id': None if value.get('document') == SELECTION
                                 else value.get('document'), 'reason': value.get('reason')})
            elif form.startswith(CHANGE_FORM):
                changes.append(value)
            elif form.startswith(NOTE_FORM):
                notes.append(value)
            elif form.startswith(TABLE_FORM):
                key = form[len(TABLE_FORM):].rsplit(' ', 1)[0]
                slot = tables.setdefault(key, {'title': value.get('title'), 'columns': value.get('columns'),
                                               'rows': [], 'more': value.get('more') or 0, 'parts': {}})
                slot['parts'][value.get('part') or 0] = value.get('rows') or []
        order = {d: i for i, d in enumerate(job.order)}
        changes.sort(key=lambda c: (order.get(c.get('document_id'), len(order)),
                                    [int(n) for n in re.findall(r'\d+', c.get('ref') or '')]))
        listed, more = core_job.cut(changes)
        shown_notes, notes_more = core_job.cut(notes)
        made = []
        for key in sorted(tables):
            t = tables[key]
            rows = [row for _, part in sorted(t['parts'].items()) for row in part]
            made.append({'title': t['title'], 'columns': t['columns'], 'rows': rows, 'more': t['more']})
        if plan is not None:
            # Each document the job holds that the plan left out, listed as
            # such on the job page and in read_job (the lead's ruling), but
            # one already final when the plan was made (gone at the checks:
            # its row says so, REV-JG2-7).
            named = set(plan.get('documents') or job.order)
            plan = {**plan, 'fallback': fallback,
                    'left_out': [{'document_id': d, 'name': self.names.get(d) or (job.rows.get(d) or {}).get('name')}
                                 for d in job.order
                                 if d not in named and (job.rows.get(d) or {}).get('state') not in ROW_FINAL]}
        return {'plan': plan,
                'proposed': listed, 'proposed_more': more + dropped, 'proposed_dropped': dropped,
                'notes': shown_notes, 'notes_more': notes_more, 'tables': made[:JOB_TABLES_MAX],
                'tables_more': max(0, len(made) - JOB_TABLES_MAX) + tables_dropped}

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
