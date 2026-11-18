"""An unattended job over interlinear text: the stretch runner.

The worker's loop, the heartbeat, the budgets and the halving are
``core.job``'s. What is here is what a job knows about interlinear text
(SPEC 3 and 5 to 9 of the jobs round, 2026-11-12):

* the checks before the first request (:meth:`IgtRunner.check`),
* what the job FILLS, its plan's targets, and what is empty of them
  (:mod:`.targets`, THE rule): what the walk, a piece's message, the
  evidence and Left blank all ask,
* what a stretch is handed (:meth:`IgtRunner.message`): the target sentences,
  two before them, how their forms were analysed by people and earlier in the
  job, the starter's note,
* the job's guards at staging (:class:`JobWorkspace`): no entry that exists
  already, no entry in a borrowed lexicon,
* the write under the document's lock, an op dropped where its sentence
  changed since the piece read it, the rest by the apply rule
  (:meth:`IgtRunner.write`, :mod:`plaid_agent.igt.jobapply`), each value
  stamped as the job's machine proposal, sent as tries of one request each
  with their writing rows first (:meth:`IgtRunner.send`), and what landed of
  a write whose answer was lost, or whose worker died, asked of core
  (:meth:`IgtRunner.settle`),
* the walk of a document, the skip and retry of one in use, the cursor,
* harmonize and the entries pass, and the app's parts of the report.
"""

import calendar
import dataclasses
import json
import logging
import os
import re
import unicodedata
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from plaid_client import DocumentLockLost, PlaidAPIError, read_ignored_tokens
from plaid_client.ids import uuid7
from plaid_client.provenance import PROV_CONFIRMED_KEY, PROV_DETAIL_KEY, project_role, prov_state, service_source
from plaid_client.service import locked_for_writes

from ..core import job as core_job
from ..core.agent import ModelConfig, Toolkit, TurnCancelled, TurnResult, run_turn, token_counter
from ..core import garble
from ..core.garble import seed
from ..core.trace import plural
from ..core.guidelines import manual_chars
from ..core.job import (BUDGET, OUTPUT, REFUSED, REPEATING, ROW_FINAL, SKIPPED_MORE, TOO_LONG_MORE, JobStopped, Pace, StretchFailed, canonical, analysis_key,
                        field_counts, fields_text,
                        BLANK_WHERE, blank_text, empty_counts, failure_kind, halve, harmonized, not_answering)
from ..core.limits import (JOB_ANALYSIS_MAX_CHARS, JOB_CHANGE_VALUE_CHARS, JOB_CHANGES_MAX, JOB_CONTEXT_SENTENCES,
                           JOB_DOCUMENT_PIECE_MAX_TOKENS, JOB_FINDINGS_MAX_CHARS, JOB_FINDINGS_MERGE_CHARS,
                           JOB_NOTE_MAX_CHARS, JOB_SUMMARY_MAX_CHARS,
                           JOB_SUMMARY_NOTES_CHARS, JOB_SUMMARY_TABLE_CHARS, JOB_TABLES_MAX, JOB_TABLES_PER_PIECE,
                           JOB_DECISIONS_PER_CALL, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S, JOB_GUIDELINES_MAX_CHARS,
                           JOB_LOCK_TRIES, JOB_LOCK_WAIT_S, JOB_PERSON_QUIET_S, JOB_PRECEDENT_CHARS,
                           JOB_EVIDENCE_CHARS, JOB_SENTENCE_MAX_CHARS, JOB_SENTENCE_MAX_WORDS,
                           JOB_PIECE_OUTPUT_TOKENS, JOB_SKIPPED_PER_DOCUMENT, JOB_STRETCH_SENTENCES)
from ..core.plan import JOB_DETAIL_KEY, ONE_REQUEST, PlanError, TooBig, held_changes, plan_changes
from ..core.prompt import (JOB_ANSWER_AGAIN, JOB_FINDINGS_ANSWER_AGAIN, JOB_FINDINGS_DECIDE_NOW,
                           JOB_FINDINGS_STEPS_USED_UP, JOB_LEAVE_IT, JOB_PLAN_WRITTEN_CALL_NEXT, JOB_TEXT_NOW, JOB_TEXT_THEN_FILL,
                           JOB_WRITTEN_CALL_NEXT)
from ..core.provenance import Requester
from ..core.tools import Refusal, ToolError
from ..core.version import agent_version
from . import evidence, jobapply, targets as tg, toolkit
from .plan import LEXICON_MAINTAINER, REPAIR_OF, PlanOutOfDate, check_entries, execute_plan
from .project import VIRTUAL_PREFIX, IgtProject, Sentence, Word, is_virtual, load_project, render_sentence
from .prompt import JOB_SYSTEM, build_job_prompt
from .tools import trim_ignored_edges
from .trace import TRACER
from .items import STAGED_TAIL
from .targets import Target, word_state  # noqa: F401 (word_state: tests)
from .fit import entry_gloss as _entry_gloss, fitting_entry, surface_key  # noqa: F401 (fitting_entry: tests)
from .vocab import ROLE_GLOSS, ROLE_STATUS
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
#: The form of a writing row: a try of the job's writes in a sentence (or,
#: with the document's id, changes of no sentence). Every row of a write is in
#: core before its first request, naming the try's key, so whether the job
#: wrote there is a fact core holds (``POST /jobs/{id}/landed``), never one
#: read back from the document (BRIEF RX, RX-FIX).
WRITING_FORM = ' writing '
#: Why the report lists a change as not written: a try of a write cut short
#: (a lost answer, a crash, a refusal) did not land, and its change is not
#: taken again (:meth:`IgtRunner.unwritten`).
INTERRUPTED = 'interrupted'
#: The job's plan, made once (``plan_work`` or the default), and where the
#: plan's pieces were cut smaller (a document too large for one piece, a
#: selection that failed): rows of the job's decisions, so a resumed job
#: never plans again (CONTRACT, added by JG).
PLAN_FORM = ' plan'
#: The plan's instructions for every piece, as written (not JSON): a row of
#: their own, so they may be as long as one row holds (BRIEF PF).
PLAN_INSTRUCTIONS_FORM = ' plan instructions'
FALLBACK_FORM = ' fallback '
#: A change a piece staged that the apply rule did not apply, a piece's
#: note, a table a piece's code made, and how many changes the cap dropped.
CHANGE_FORM = ' change '
NOTE_FORM = ' note '
#: The whole last reply of a piece of a job that fills nothing, its findings,
#: in rows of its own keyed by the piece and the part (RPF-A5).
FINDINGS_FORM = ' findings '
#: The words and sentences a job's text edits added, by id, read under the
#: document's lock before and after the write, in rows of their own: what a
#: job set up to fill only the words it adds may fill (RPF-A7).
ADDED_FORM = ' added '
#: The form of the rows of the words a write respelled and kept the analysis
#: of, whose morpheme forms still spell the old word (RPF3-B), one per word.
RESPELLED_FORM = ' respelled '
#: The refused code of a value staged on a word, a morpheme of it or a
#: sentence the job did not add, under such a setup.
NOT_ADDED = 'not-added'
#: What a refusal a job cannot follow is about (``ToolError.code``, given
#: where it is raised): ``text``, a change to words the same plan retypes,
#: splits, merges or deletes; ``shape``, a retype, split, merge or delete of
#: words the same plan also changes otherwise (an analysis, a value, a rule,
#: a comment); ``entry-new``, a change naming an entry the same plan creates;
#: ``entry-gone``, one naming an entry the same plan deletes or merges (or
#: an entry number that plan moves); ``expression``, a link inside a
#: multi-word expression the same plan makes; ``not-added``, a value on a
#: word or sentence the job did not add, under a setup that fills only the
#: words it adds (RPF-A7). The job page labels each by
#: what was not done (REV-DF-S-4, REV-DF3-5).
#: An analysis of a word in a sentence its own plan retypes (RPF3-B).
RETYPED = 'retyped'
#: The tools whose ``retyped`` refusal a piece after the text edit may take
#: up: they fill a word's analysis or values (REV-RPF3-1).
FILLING_TOOLS = frozenset({'set_analysis', 'analyze_sentence', 'set_field', 'set_morpheme'})
#: A reference such a tool names: a sentence ``s4``, a word ``s4.w3`` with
#: its form or not, a run ``s4.w3-w5``, a morpheme ``s4.w3.m1``.
FILL_REF = re.compile(r'^s(\d+)(?:\.w(\d+)(?:-w?(\d+))?(?:\.m\d+)?)?(?:\s+"([^"]*)")?$')
#: A value, an analysis or a link outside the piece's own sentences (RP3-2).
OUTSIDE = 'outside'
#: A change in a sentence the checks skipped as too long for a job (S8-1).
TOO_LONG = 'too-long'
LEFT_CODES = ('text', 'shape', 'entry-new', 'entry-gone', 'expression', 'not-added', RETYPED, OUTSIDE, TOO_LONG)
#: What a refusal the job could not follow left (``JobWorkspace.leave_it``).
REFUSED_FORM = ' refused '
TABLE_FORM = ' table '
#: The form of a piece's summary among the job's decisions (CONTRACT, added
#: by LV): core's ``piece-form``, the one form any reader of the job reads
#: (``GET /jobs/{id}/pieces``). One row for the plan and one for each piece
#: once what it wrote is known, keyed by a sequence number of
#: PIECE_SEQ_DIGITS digits, so newest first is the key's order.
PIECE_FORM = ' piece'
PIECE_SEQ_DIGITS = 6
DROPPED_FORM = ' dropped'
#: How many tables pieces handed the report past JOB_TABLES_MAX a job keeps.
TABLES_DROPPED_FORM = ' tables dropped'
#: How the plan cuts the work (``plan_work``'s ``pieces``).
SENTENCES, DOCUMENT, SELECTION = 'sentences', 'document', 'selection'
#: A document row's ``counts`` key, true for a document the whole-selection
#: piece covered and that ended with it: after that one step nothing more is
#: worked for want of reading or for what is empty (the lead's ruling after
#: RP4-5, replacing RPF3-A's walk where empty). Its row is ``done``.
ONE_STEP = 'one_step'
#: A row's count: its whole-document or selection piece ended without
#: finishing under a plan that fills nothing, and nothing was walked after it
#: (REV-RW-1): the report's top line says the rest was not done.
RAN_OUT = 'ran_out'
#: The most document ids a piece's summary lists of those its rest went to
#: stretches in (``rest_documents``), within the row's cap.
REST_LISTED = 50
#: A row's count, true for a document core never answered for through the
#: waits a person's document gets, or under a plan that fills nothing after
#: one wait, as a person's put-off ends there (``UNWORKED_HOW``): it ends
#: ``not-reached`` (put off for good, as that state's definition says) and the
#: report says why (REV-JR2-3, REV-JOIN18-7).
UNANSWERED = 'unanswered'
#: What happened in a document of a plan that fills nothing that the walk
#: ends instead of working it in stretches, by its fallback reason
#: (``counts.ran_out``, REV-RW-R3-1). A document whose write core never
#: answered for (``unreachable``) ends as REV-JR2-3's does: not reached,
#: ``counts.unanswered`` (:meth:`IgtRunner.end_unworked`).
UNWORKED_HOW = {'selection': 'failed', 'failed': 'part-failed', 'ran-out': 'written', 'again': 'written',
                'in-use': 'put-off', 'unreachable': UNANSWERED}
#: ... and true beside it when that step was not shown every sentence of the
#: document (it read part of it, or none, or wrote in it by reference).
NOT_ALL_READ = 'not_all_read'
PIECES = (SENTENCES, DOCUMENT, SELECTION)
#: The sentences a plan's search matched at planning (SF), one row each,
#: keyed by the sentence's id, its document the row's: what the walk of a
#: plan limited by a search takes, a resumed job's too. The plan row holds
#: the search itself (capped), never these.
SEARCH_FORM = ' search'
#: A document row's ``counts`` key under a plan limited by a search: how many
#: of the document's sentences the search matched at planning. 0 for one the
#: job ended with no model call (SF).
MATCHED = 'matched'


def _cut(text, limit: int):
    """``text`` at most ``limit`` characters, "…" where it was cut, None as
    None."""
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= limit else text[:limit - 1] + '…'


#: How a piece's note says it was cut (:func:`piece_note`).
NOTE_CUT = ' (The rest of this note is cut.)'


#: Markdown's marks a note is kept without (RPF-A4): emphasis and code
#: marks, a heading's or a quote's or a list item's lead, a rule's line.
_MD_RULE = re.compile(r'^\s*([-*_]\s*){3,}$')
_MD_LEAD = re.compile(r'^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)')
_MD_MARKS = re.compile(r'(\*\*|__|`+|~~)')


def plain(text) -> str:
    """``text`` as plain text, one paragraph: Markdown's marks dropped
    (emphasis, code, a heading's or a list item's lead, a rule, a table's
    bars), its lines joined with spaces. By the marks alone, never by what
    the words say."""
    lines = []
    for line in str(text or '').splitlines():
        if _MD_RULE.match(line) or re.fullmatch(r'\s*\|?[\s:|-]*\|[\s:|-]*', line):
            continue
        line = _MD_MARKS.sub('', _MD_LEAD.sub('', line))
        line = ' '.join(c.strip() for c in line.strip().strip('|').split('|')) if '|' in line else line
        if line.strip():
            lines.append(line.strip())
    return ' '.join(lines)


def piece_note(text) -> str:
    """A piece's note as the job keeps it, plain text (:func:`plain`, RPF-A4):
    whole when it is at most JOB_NOTE_MAX_CHARS, else cut after its last
    whole sentence that fits (after its last whole word when no sentence
    does) and saying so in words (:data:`NOTE_CUT`). Never cut inside a
    word, never an ellipsis: a reader takes a note's last words as written
    (pilot finding 4)."""
    text = plain(text).strip()
    if len(text) <= JOB_NOTE_MAX_CHARS:
        return text
    room = JOB_NOTE_MAX_CHARS - len(NOTE_CUT)
    ends = [i + 1 for i in range(room) if text[i] in '.!?' and text[i + 1].isspace()]
    if ends:
        head = text[:ends[-1]]
    else:
        spaces = [i for i in range(room + 1) if text[i].isspace()]
        head = text[:spaces[-1]] if spaces else text[:room]
    return head.rstrip() + NOTE_CUT


#: How the findings of a job that fills nothing say they were cut.
FINDINGS_CUT = '(The rest of this report is cut.)'
#: How a piece's findings on its summary row say they were cut to the row's
#: cap (REV-RPF2-4).
PIECE_FINDINGS_CUT = '(The rest of this part’s findings is cut.)'
#: The note of a piece of a job that fills nothing that kept findings: one
#: sentence, never its findings flattened and cut, shown a second time under
#: them (REV-RPF-P-10).
FINDINGS_NOTE = 'Its findings are in the report.'


def findings_text(text) -> str:
    """A piece's findings (or the job's one report) as the job keeps them:
    whole when at most JOB_FINDINGS_MAX_CHARS, else cut after its last line
    break or sentence end within the cap, saying so on a line of its own
    (:data:`FINDINGS_CUT`)."""
    text = str(text or '').strip()
    if len(text) <= JOB_FINDINGS_MAX_CHARS:
        return text
    room = JOB_FINDINGS_MAX_CHARS - len(FINDINGS_CUT) - 2
    head = text[:room]
    at = max(head.rfind('\n'), *(head.rfind(c + ' ') + 1 for c in '.!?'))
    return (head[:at] if at > 0 else head).rstrip() + '\n\n' + FINDINGS_CUT


def findings_rows(key: str, value: Dict[str, Any], text: str) -> List[Dict[str, Any]]:
    """A piece's findings as decision rows: ``value`` (its document, name and
    sentences) with ``text`` split over as many rows as JOB_ANALYSIS_MAX_CHARS
    needs, each saying which part of how many it is."""
    chunks, rest = [], text
    while rest:
        n = min(len(rest), JOB_ANALYSIS_MAX_CHARS)
        while n > 1 and len(canonical({**value, 'text': rest[:n], 'part': 999, 'of': 999})) > JOB_ANALYSIS_MAX_CHARS:
            n = max(1, n * 3 // 4)
        chunks.append(rest[:n])
        rest = rest[n:]
    out = []
    for i, chunk in enumerate(chunks):
        a = canonical({**value, 'text': chunk, 'part': i, 'of': len(chunks)})
        out.append({'form': f'{FINDINGS_FORM}{key} {i:03d}', 'key': analysis_key(f'{key}/findings/{i}'),
                    'analysis': a, 'count': 1, 'document_id': value.get('document'), 'sentence_id': None})
    return out


def summary_text(value: Dict[str, Any]) -> Optional[str]:
    """A piece's summary (or the plan's) as its decision row keeps it:
    canonical JSON, its keys kebab-cased as the clients send a report, so
    each client reads them in its own case (``GET /jobs/{id}/pieces``).
    Within JOB_ANALYSIS_MAX_CHARS: past it, the lists are cut from the end
    (the skipped sentences, the refusals, then the targets written outside
    the setup and the values by target, each ``<list>_more`` counting what
    was cut, and the plan's gone fields and names), then the note and the
    document's name are halved, and the row says it was cut (``cut``).
    None when even that is over the cap: no row (REV-LV-2)."""
    from plaid_client.transforms import transform_request
    value = json.loads(json.dumps(value))
    plan = value.get('plan') if isinstance(value.get('plan'), dict) else {}
    while True:
        text = canonical(transform_request(value))
        if len(text) <= JOB_ANALYSIS_MAX_CHARS:
            return text
        findings = value.get('findings')
        if isinstance(findings, str) and findings and not findings.endswith(PIECE_FINDINGS_CUT):
            # A piece's findings go first, cut at a line or a sentence end
            # within what the row leaves them, saying so (REV-RPF2-4).
            room = max(0, len(findings) - (len(text) - JOB_ANALYSIS_MAX_CHARS) - len(PIECE_FINDINGS_CUT) - 16)
            head = findings[:room]
            at = max(head.rfind('\n'), *(head.rfind(c + ' ') + 1 for c in '.!?'))
            value['findings'] = ((head[:at] if at > 0 else head).rstrip() + '\n\n' + PIECE_FINDINGS_CUT).lstrip()
            continue
        if isinstance(findings, str) and findings.endswith(PIECE_FINDINGS_CUT) and len(findings) > len(
                PIECE_FINDINGS_CUT) + 2:
            # Still over (escaped characters): shorter again.
            body = findings[:-len(PIECE_FINDINGS_CUT)].rstrip()
            value['findings'] = body[:len(body) * 3 // 4].rstrip() + '\n\n' + PIECE_FINDINGS_CUT
            continue
        value['cut'] = True
        where = next(((d, k) for d, k in [(value, 'skipped'), (value, 'refused'), (value, 'outside'),
                                          (value, 'fields'), (plan, 'gone'), (plan, 'fills_names')]
                      if isinstance(d.get(k), list) and d[k]), None)
        if where is not None:
            d, k = where
            d[k].pop()
            d[f'{k}_more'] = (d.get(f'{k}_more') or 0) + 1
            continue
        k = next((k for k in ('note', 'name') if isinstance(value.get(k), str) and len(value[k]) > 1), None)
        if k is None:
            return None
        value[k] = value[k][:len(value[k]) // 2]


def text_counts(ops: List[Dict[str, Any]]) -> Counter:
    """``words_added`` and ``tokens_changed`` of ``ops``
    (:func:`jobapply.text_effects`, RPF-A8)."""
    c: Counter = Counter()
    for o in ops:
        added, changed = jobapply.text_effects(o)
        c['words_added'] += added
        c['tokens_changed'] += changed
    return c


#: What a writing row's ``parts`` say the analyses hold (REV-RPF2-2): the
#: morphemes they write or take away, and the values they carry.
ANALYSES_MORPHEMES, ANALYSES_VALUES = 'analyses_morphemes', 'analyses_values'


def changes_parts(parts: Counter) -> List[Dict[str, Any]]:
    """Counts by change kind as the report holds them (RPF-A3): ``[{kind,
    n}]`` in ``core.job.CHANGE_KINDS`` order, a kind at 0 left out, the
    analyses' entry with ``morphemes`` and ``values`` where it holds any
    (REV-RPF2-2). A list, never a map, which the clients would re-case."""
    out = []
    for k in core_job.CHANGE_KINDS:
        if not parts.get(k):
            continue
        entry = {'kind': k, 'n': parts[k]}
        if k == 'analyses':
            entry.update({key: parts[src] for key, src in (('morphemes', ANALYSES_MORPHEMES),
                                                          ('values', ANALYSES_VALUES)) if parts.get(src)})
        out.append(entry)
    return out


def written_sums(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What writing ``rows`` wrote, as a document row's counts say it:
    each count summed, ``analyzed`` each sentence written in once, ``words``
    each word analysed once, ``fields`` and ``outside`` by target
    (:func:`core_job.field_counts`), ``changes_parts`` the changes by kind
    (:func:`changes_parts`). Only the non-zero counts."""
    counts: Counter = Counter()
    analyzed, words = set(), set()
    fields: List[Dict[str, Any]] = []
    outside: List[Dict[str, Any]] = []
    parts: Counter = Counter()
    for r in rows:
        words |= set(r.get('words') or ())
        fields += r.get('fields') or []
        outside += r.get('outside') or []
        parts.update(r.get('parts') or {})
        for k, n in (r.get('counts') or {}).items():
            if k == 'analyzed':
                analyzed.add(r['sentence'])
            else:
                counts[k] += n
    counts['analyzed'], counts['words'] = len(analyzed), len(words)
    out: Dict[str, Any] = {'counts': {k: n for k, n in counts.items() if n}}
    if +parts:
        out['changes_parts'] = changes_parts(parts)
    if fields:
        out['fields'] = field_counts(fields, {f['id'] for f in outside})
    if outside:
        out['outside'] = field_counts(outside)
    return out


#: The ``by`` of the plan kept when planning ended with no plan, and the
#: reason the job then ends failed with, writing nothing (REV-DF3-2).
NO_PLAN = 'none'
NO_PLAN_REASON = 'no-plan'
#: The reason of a job whose planning ended in a model fault, twice (REV-DF4-2).
PLANNING_FAILED_REASON = 'planning-failed'
#: The reason, and the plan row's ``why``, of a job set up to fill targets
#: the project no longer has at all: it ends before planning (REV-SU-B-3).
SETUP_GONE_REASON = 'setup-gone'
#: The reason, and the plan row's ``why``, of a job whose setup is not the
#: card's shape: it ends before planning (REV-SU-B-6).
SETUP_UNREAD_REASON = 'setup-unreadable'
#: The StretchFailed kinds that are the model's fault: a call that reached
#: the output cap or that the provider refused (``refused``, S1-2), and a
#: model repeating itself. A
#: budget spent or a context too long is the planning's own size, and a
#: model that does not answer is waited for, never a kind (REV-DF5-1).
MODEL_FAULTS = (OUTPUT, REPEATING, REFUSED)

#: Why a piece's sentences are skipped when its model answered nothing twice
#: (:func:`answered_nothing`).
NO_ANSWER = 'no-answer'


def answered_nothing(ws, text) -> bool:
    """Whether a piece's answer staged nothing (no op, no table) and wrote
    no text: by what the answer holds, never by its words (REV-DAY-S-16)."""
    return not ws.ops and not ws.tables and not piece_note(text)


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


def _n_text(n: int, word: str) -> str:
    return f'{n:,} {word}{"" if n == 1 else "s"}'


def mark_form(sentence_id: str) -> str:
    return RECORD_FORM + sentence_id


def writing_form(sentence_id: str) -> str:
    return WRITING_FORM + sentence_id


def writing_text(row: Dict[str, Any]) -> str:
    """A writing row's analysis (:meth:`IgtRunner.manifest`) as canonical
    JSON within JOB_ANALYSIS_MAX_CHARS: the try, the write, the piece and
    the counts are never cut. Past the limit the changes the row would
    list are cut first (``more`` says how many), then those proposed (a
    write that landed lists the proposed itself), then the tags of the
    sentence's other words, then of the words the try writes on (a sentence
    a person made longer since the checks: every tag of one of
    JOB_SENTENCE_MAX_WORDS words fits)."""
    row = {k: (list(v) if isinstance(v, list) else v) for k, v in row.items()}
    while True:
        text = canonical(row)
        if len(text) <= JOB_ANALYSIS_MAX_CHARS:
            return text
        cut = next((k for k in ('ops', 'proposed', 'others', 'words') if row.get(k)), None)
        if cut is None:
            return text
        row[cut].pop()
        if cut == 'ops':
            row['more'] = (row.get('more') or 0) + 1


def piece_tag(piece: Dict[str, Any]) -> str:
    """How a writing row names the piece whose write it was: the start of
    the key of the piece, ``{"document", "first"}`` for a stretch (its first
    sentence), ``{"document", "whole"}`` for a whole document and
    ``{"selection"}`` for the selection. The same piece run again after an
    interruption (a crash, a lost answer, a write put off) has the same
    tag."""
    return analysis_key(canonical(piece))[:PIECE_TAG_CHARS]


#: How many hex characters of a piece's key its tag keeps.
PIECE_TAG_CHARS = 16
#: The tag of the selection piece: one per job.
SELECTION_TAG = piece_tag({'selection': True})
#: The key holding a selection's change of no document's place among them,
#: on the copy of it each document's write carries (``IgtRunner.try_loose``).
LOOSE = '_loose'


def mark_text(document_id: str, words: Dict[str, str]) -> str:
    """A sentence record's analysis: its document and what the job wrote on
    each of its words it can vouch for (:func:`word_tag` to
    :func:`word_key`), as many as a decision's analysis holds
    (``JOB_ANALYSIS_MAX_CHARS``). A word not listed is one harmonize
    leaves."""
    pairs = list(words.items())
    while True:
        text = canonical({'document': document_id, 'words': dict(pairs)})
        if len(text) <= JOB_ANALYSIS_MAX_CHARS or not pairs:
            return text
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


def _nfc(text) -> str:
    return unicodedata.normalize('NFC', str(text or ''))


# --- what a target is ------------------------------------------------------------

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


def translation_target(s: Sentence, project: IgtProject, job_id: str) -> bool:
    """An empty translation, by THE rule (:func:`targets.empty`): what a
    write the job made and a person cleared is known by (``Written``)."""
    f = translation_field(project)
    return f is not None and tg.empty(Target(f.layer_id, f.name, 'Sentence', f), s=s)


class Written:
    """What any landed write of the job wrote, whoever's sentence it was in
    (:meth:`IgtRunner.written`): the tags of the words it analysed
    (:func:`word_tag`) and the sentences whose translation it wrote. The job
    never writes these again once they read blank: a person undid them
    (REV-JG-1, REV-LNW-1)."""

    def __init__(self, words=frozenset(), translations=frozenset()):
        self.words, self.translations = frozenset(words), frozenset(translations)

    def undone(self, op: Dict[str, Any], doc, project: IgtProject, job_id: str) -> bool:
        """Whether ``op`` writes again on a word or a translation the job
        wrote that reads blank in ``doc``: never written (counted as
        ``changed``, a person changed it during the job)."""
        from .jobapply import _found
        hit = _found(doc, op.get('analysis_word_id') or op.get('word_id') or op.get('token_id'))
        if hit is not None and hit[1] is not None:
            w = hit[1]
            return word_tag(w.id) in self.words and tg.empty(tg.SEGMENTED, w=w)
        if hit is not None and op.get('kind') == 'set_span' and op.get('layer_id') == translation_layer(project) \
                and hit[0] is not None and hit[0].id == op.get('token_id'):
            return hit[0].id in self.translations and translation_target(hit[0], project, job_id)
        return False


def sentence_targets(s: Sentence, project: IgtProject, job_id: str, known=frozenset(),
                     written: Optional[Written] = None,
                     targets: List[Target] = ()) -> Tuple[List[Word], List[Target]]:
    """What is empty in ``s`` of what the job fills (``targets``, by THE rule,
    :mod:`.targets`): the words empty for a word or morpheme level target,
    and the sentence level targets ``s`` is empty for. A plan in sentences
    with skip_filled_sentences walks the sentences that hold something.
    Nothing in a sentence that holds a word of a sentence a landed write of
    the job wrote in as one of its own (``known``,
    :meth:`IgtRunner.known_words`), and never a word or a translation any
    landed write of the job wrote (``written``): one that reads blank was
    cleared by a person."""
    if wrote_in(s, known):
        return [], []
    written = written or Written()
    layer = translation_layer(project)
    return ([w for w in s.words if tg.empty_in_word(w, targets) and word_tag(w.id) not in written.words],
            [t for t in tg.empty_in_sentence(s, targets) if not (t.id == layer and s.id in written.translations)])


def wrote_in(s: Sentence, known) -> bool:
    """Whether ``s`` holds a word of a sentence a landed write of the job
    wrote in: ``known`` holds the tags (:func:`word_tag`) of every word of
    such sentences, as their writing rows name them. A sentence split or merged
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


def in_place_of_job(w: Word, job_id: Optional[str]) -> bool:
    """Whether a morpheme of ``w`` that is not this job's holds a value or a
    link that is (``job_piece``): the job wrote in place on a morpheme
    someone else made (KM's rule, REV-KM-3, narrowed by REV-KM2-1). Word
    fields are not looked at."""
    if not job_id:
        return False
    for m in w.morphemes:
        if m.virtual or job_piece(m.metadata, job_id):
            continue
        if any(job_piece(sp.metadata, job_id) for sp in m.fields.values()) or (
                m.link is not None and job_piece(m.link.metadata, job_id)):
            return True
    return False


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
#: (CONTRACT, added by J-FIX-B and J-FIX-B2, the codes made true by RPF-A1),
#: and the word it never looks at. ``changed``: a word the job recorded it
#: wrote whole reads otherwise now (a person, or anyone, changed it after the
#: job wrote it). ``beside-others``: a word the job wrote on that held work
#: not the job's when it wrote (a person's, another producer's), which
#: harmonize never rewrites.
CHANGED, BESIDE_OTHERS, COMMENTED, IN_MWE, NOT_THE_JOBS = 'changed', 'beside-others', 'commented', 'in-mwe', \
    'not-the-jobs'
#: Why a form the job's own words hold two or more ways was left, as its
#: report lists it: the job's analyses differ, and people's analyses of the
#: form differ too, or none of the job's holds two thirds of its words. The
#: rule's own reasons (``core.job.harmonized``) by the report's codes.
JOB_DIFFERS_PEOPLE_DIFFER, JOB_DIFFERS_NO_MAJORITY = 'job-differs-people-differ', 'job-differs-no-majority'
LEFT_BY_RULE = {'people-differ': JOB_DIFFERS_PEOPLE_DIFFER, 'no-clear-majority': JOB_DIFFERS_NO_MAJORITY}
#: A word the job wrote and could not vouch for: its sentence's record holds
#: no key for it (REV-FIX3-2).
UNVOUCHED = 'unvouched'
#: A word the job wrote whole and recorded that reads as recorded, of which a
#: person has since verified a piece and changed nothing (the worker review's
#: W-9). Not an inconsistency for that alone: harmonize lists it only when it
#: finds it so under the lock, as a word it was to rewrite.
VERIFIED = 'verified'
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
    return analysis_key(canonical([surface_key(w.surface), word_analysis(w)]))[:WORD_KEY_CHARS]


def harmonize_bar(w: Word, job_id: str, recorded: Dict[str, str], commented: set) -> Optional[str]:
    """THE rule for what harmonize may rewrite (SPEC 6.5 and 8.1, the owner's
    rulings on REV-J-B2 S3-1 and REV-J-B3), in one place, asked when
    harmonize collects the job's words and again under the document's lock.
    None when the word is this job's to rewrite, else why it is left, each
    decided by provenance and the job's own record, so each is true
    (RPF-A1):

    * ``NOT_THE_JOBS``: nothing on it is this job's, so it is no business of
      harmonize's and is not listed,
    * ``changed``: the job recorded it wrote the word whole (``recorded``, a
      word id to the :func:`word_key` its sentence's record holds for it),
      and it now holds work that is not the job's or reads otherwise than
      recorded: someone changed it after the job wrote it. So a piece a
      person deleted or changed is never put back,
    * ``verified``: recorded, it reads as recorded, and a person only
      verified a piece of it since (:func:`only_verified`, W-9),
    * ``beside-others``: something on it is not this job's own unverified
      work (:func:`job_owned`), the job never recorded the word as wholly
      its own, and nothing says it was written after the job: it held a
      person's or another producer's work when the job wrote on it,
    * ``unvouched``: the job could not vouch for its own write on the word
      (its sentence's record holds no key for it, REV-J-B3 B3-2), so it
      cannot tell whether anyone changed it, and leaves it: a word wholly
      the job's, or one whose morphemes the job made that now carry a value
      or a link not the job's (:func:`changed_on_jobs_morphemes`, W-9),
    * ``commented``: a comment hangs on the word or a piece of it
      (``commented``, the ids the document's comments are anchored to),
    * ``in-mwe``: the word is a member of a multi-word expression, which a
      job never makes."""
    pieces = word_pieces(w)
    if not any(job_piece(p, job_id) for p in pieces):
        return NOT_THE_JOBS
    if not job_owned(w, job_id):
        if w.id in recorded:
            return VERIFIED if only_verified(w, job_id, recorded) else CHANGED
        return UNVOUCHED if changed_on_jobs_morphemes(w, job_id) else BESIDE_OTHERS
    if w.id not in recorded:
        return UNVOUCHED
    if recorded[w.id] != word_key(w):
        return CHANGED
    if word_ids(w) & commented:
        return COMMENTED
    if any(not job_piece(link.metadata, job_id) for link in w.mwes):
        return IN_MWE
    return None


def only_verified(w: Word, job_id: str, recorded: Dict[str, str]) -> bool:
    """Whether ``w`` reads as the job recorded it and every piece on it is
    the job's, some verified by a person since: a person verified what the
    job wrote and changed nothing (W-9)."""
    pieces = word_pieces(w)
    return (recorded.get(w.id) == word_key(w) and all(_job_of(p) == job_id for p in pieces)
            and all(prov_state(p) in ('machine', 'verified') for p in pieces))


def changed_on_jobs_morphemes(w: Word, job_id: str) -> bool:
    """Whether the job made every stored morpheme of ``w`` and a value or a
    link on one of them is not the job's own unverified work: written there
    after the job made the morpheme, which did not exist before (W-9). A
    word whose morphemes someone else made, or whose other work is a word
    field (which may have been there first), is not."""
    stored = [m for m in w.morphemes if not m.virtual]
    if not stored or not all(_job_of(m.metadata) == job_id for m in stored):
        return False
    return any(not job_piece(p, job_id) for m in stored
               for p in [sp.metadata for sp in m.fields.values()] + ([m.link.metadata] if m.link is not None else []))


def analysis_holds_jobs(w: Word, job_id: str) -> bool:
    """Whether the analysis harmonize compares (:func:`harmonized_part`: the
    morphemes, their values and links) holds anything the job wrote: a
    morpheme it made, a value or a link on a morpheme. A word the job wrote
    only word fields on (a Word class, a Case) holds people's analysis, and
    harmonize lists nothing of it: its differences are not the job's
    (RPF-A1)."""
    for m in w.morphemes:
        if not m.virtual and job_piece(m.metadata, job_id):
            return True
        if any(job_piece(sp.metadata, job_id) for sp in m.fields.values()):
            return True
        if m.link is not None and job_piece(m.link.metadata, job_id):
            return True
    return False


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


def people_analysis(w: Word, job_id: Optional[str]) -> Dict[str, Any]:
    """``word_analysis`` of a word as people wrote it: every value and link
    the job ``job_id`` wrote (``job_piece``) left out, per value."""
    a = word_analysis(w)
    for m, am in zip(w.morphemes, a['morphemes']):
        am['fields'] = {n: v for n, v in am['fields'].items() if not job_piece(m.fields[n].metadata, job_id)}
        if m.link is not None and job_piece(m.link.metadata, job_id):
            am['entry'] = None
    a['word'] = {n: v for n, v in a['word'].items() if not job_piece(w.fields[n].metadata, job_id)}
    return a


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


def holds_change(doc, project: IgtProject, change: Dict[str, Any]) -> bool:
    """Whether ``doc`` holds what a proposed ``change`` (as
    ``IgtRunner.describe`` keeps it) would write: the field's value at its
    reference, or the word's analysis rendered as the change renders it,
    each cut as the change's value is. By the values, never by words."""
    m = re.fullmatch(r's(\d+)(?:\.w(\d+))?(?:\.m(\d+))?', change.get('ref') or '')
    if m is None:
        return False
    si, wi, mi = (int(x) if x else None for x in m.groups())
    s = next((x for x in doc.sentences if x.index == si), None)
    w = next((x for x in s.words if x.index == wi), None) if s is not None and wi else None
    morph = None
    if w is not None:
        morph = next((x for x in w.morphemes if x.index == mi), None) if mi else (
            w.morphemes[0] if len(w.morphemes) == 1 else None)
    to = change.get('to')
    if change.get('kind') == 'set_span':
        f = project.fields.get(change.get('field')) if change.get('field') else None
        holder = None if f is None else morph if f.scope == 'Morpheme' else w if f.scope == 'Word' else s
        sp = holder.fields.get(f.name) if holder is not None else None
        return sp is not None and sp.value not in (None, '') and _cut(sp.value, JOB_CHANGE_VALUE_CHARS) == to
    if change.get('kind') == 'set_analysis' and w is not None and word_state(w) != 'unanalyzed':
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        return _cut(rendering(word_analysis(w), gloss), JOB_CHANGE_VALUE_CHARS) == to
    return False


def peoples(metadata, value=True) -> bool:
    """A piece people wrote: a person's, a contributor's or one confirmed
    (not a machine's), holding something (``value`` not blank)."""
    return prov_state(metadata) != 'machine' and value not in (None, '')


def peoples_in_morphemes(w: Word) -> int:
    """What people wrote in a word's morphemes, piece by piece as the Changes
    view counts "replaced a person's value" (REV-RPF2-1): each stored
    morpheme not a machine's (a person's segmentation, or the default one a
    person's tokenization made), each value on one, each link on one."""
    n = 0
    for m in w.morphemes:
        if m.virtual:
            continue
        n += peoples(m.metadata)
        n += sum(peoples(sp.metadata, sp.value) for sp in m.fields.values())
        n += m.link is not None and peoples(m.link.metadata)
    return n


def peoples_on_word(w: Word) -> int:
    """What people wrote on a word, piece by piece (REV-RPF2-1): its
    morphemes' (:func:`peoples_in_morphemes`), its word values and its own
    link."""
    return (peoples_in_morphemes(w) + sum(peoples(sp.metadata, sp.value) for sp in w.fields.values())
            + (w.link is not None and peoples(w.link.metadata)))


def replaces_people(op: Dict[str, Any], doc, project: IgtProject) -> int:
    """How many pieces people wrote ``op`` changes or takes away, by the
    provenance of what it replaces in ``doc`` (the document before the
    write), never by its words (REV-DAY-S-3), each counted as the Changes
    view counts "replaced a person's value" (REV-RPF2-1): a value whose span
    is not a machine's (a person's, a contributor's or confirmed) set to
    another value or cleared, one; an analysis replaced or discarded on a
    word holding any piece people wrote (``word_state`` protected), each
    morpheme, value and link of people's in its morphemes; a link people
    made replaced or taken away, one."""
    from .jobapply import _found, token_of
    kind = op.get('kind')
    if kind in ('link', 'link_phrase', 'unlink'):
        # The link it replaces or takes away, a word's, a morpheme's or an
        # expression's, by its own id (REV-DF-S-1): a word's link has no
        # morpheme to be found by.
        lid = op.get('existing_link_id') or op.get('link_id')
        found = doc.find(lid) if lid else None
        if found is None:
            return 0
        _s, w, m = found
        links = ([m.link] if m is not None and m.link is not None else []) + (
            [w.link] if w is not None and w.link is not None else []) + list(w.mwes if w is not None else [])
        link = next((x for x in links if x.id == lid), None)
        return int(link is not None and prov_state(link.metadata) != 'machine')
    hit = _found(doc, token_of(op))
    if hit is None:
        return False
    s, w, m = hit
    if kind == 'set_span':
        f = project.field_by_layer(op.get('layer_id'))
        holder = None if f is None else m if f.scope == 'Morpheme' else w if f.scope == 'Word' else s
        sp = holder.fields.get(f.name) if holder is not None else None
        return int(sp is not None and sp.value not in (None, '') and prov_state(sp.metadata) != 'machine'
                   and (op.get('value') or '') != sp.value)
    if kind in ('set_analysis', 'discard_analysis'):
        return peoples_in_morphemes(w) if w is not None and word_state(w) == 'protected' else 0
    return 0


def removes_people(op: Dict[str, Any], doc) -> int:
    """How much people wrote a text op takes away with the tokens it removes,
    by provenance in ``doc`` (the document read under the lock before the
    write), never by its words (REV-RPF-W-4), piece by piece as the Changes
    view counts "replaced a person's value" (REV-RPF2-1): each morpheme,
    value and link people wrote on a word it removes (:func:`peoples_on_word`),
    and each sentence-level value people wrote on a sentence it removes. A
    word a retype removes is one of the sentence's words that its planned
    words do not keep (typed over whole, or deleted in the retype). A
    respelled word keeps its token and what is on it. A split word keeps its
    token and its word values and link, and a merge of words keeps the first
    word's: each deletes the words' morpheme analyses, counted as
    :func:`peoples_in_morphemes` counts them (S7-2)."""
    kind = op.get('kind')
    sentences = {s.id: s for s in doc.sentences}
    words = {w.id: w for s in doc.sentences for w in s.words}
    gone_words, gone_sentences = [], []
    analysed = [op.get('word_id')] if kind in ('split_word', 'merge_words') else []
    if kind == 'delete_word':
        gone_words = [op.get('word_id')]
    elif kind == 'merge_words':
        gone_words = list(op.get('other_ids') or [])
    elif kind == 'delete_sentence':
        gone_sentences = [op.get('sentence_id')]
    elif kind == 'merge_sentences':
        gone_sentences = [op.get('other_id')]
    elif kind == 'edit_text' and op.get('sentence_id') in sentences and op.get('planned_words') is not None:
        kept = {p.get('word_id') for p in op['planned_words']}
        gone_words = [w.id for w in sentences[op['sentence_id']].words if w.id not in kept]
    n = 0
    for sid in gone_sentences:
        s = sentences.get(sid)
        if s is None:
            continue
        if kind == 'delete_sentence':
            gone_words += [w.id for w in s.words]
        n += sum(peoples(sp.metadata, sp.value) for sp in s.fields.values())
    n += sum(peoples_in_morphemes(words[wid]) for wid in analysed if wid in words)
    return n + sum(peoples_on_word(words[wid]) for wid in gone_words if wid in words)


def document_counts(report: Dict[str, Any]) -> Dict[str, int]:
    """The report's documents counted as the job page says them (REV-RPF3-4,
    plaid-igt jobText.js ``documentCounts``, pinned equal by
    test_document_counts_mirror): ``done`` leaves out those all of whose
    finished sentences were skipped (REV-RPF-P-9), never one the
    whole-selection step ended (RP4-4 finding 1: "Documents done 0" beside
    45 rows reading Done); ``changed`` counts the documents done that hold
    the job's changes; one not reached that finished a sentence or
    holds the job's changes is ``stopped_partway`` (RPF3-D2). One a plan
    limited by a search ended with no sentence of it matched
    (``counts.matched`` 0) is ``with_nothing_found_by_the_search``, apart from done
    (SF)."""
    docs = report.get('documents') or []
    totals = report.get('totals') or {}

    def counts(d):
        return d.get('counts') or {}

    changed = sum(1 for d in docs if d.get('state') == 'done' and (counts(d).get('changes') or 0) > 0)
    unmatched = sum(1 for d in docs if no_match(d))
    # A sentence too long for a job was never a target, and done does not
    # count it (D11).
    skipped = sum(1 for d in docs if d.get('state') == 'done' and (d.get('done') or 0) > 0
                  and len([s for s in d.get('skipped') or [] if s.get('reason') != 'too-long'])
                  + (counts(d).get('skipped_more') or 0) >= (d.get('done') or 0))
    # The documents the plan left out are no documents not reached (D22),
    # those cut from its list (``left_out_more``) counted too.
    plan = report.get('plan') if isinstance(report.get('plan'), dict) else {}
    left_ids = left_out_ids(report)
    left_more = plan.get('left_out_more') or 0
    # Those the server never answered for are counted apart (REV-JR2-3).
    unanswered = sum(1 for d in docs if d.get('state') == 'not-reached' and counts(d).get(UNANSWERED) is True)
    unfinished = [d for d in docs if d.get('state') == 'not-reached' and d.get('document_id') not in left_ids
                  and counts(d).get(UNANSWERED) is not True]
    partway = sum(1 for d in unfinished if (d.get('done') or 0) > 0 or (counts(d).get('changes') or 0) > 0)
    left = len(plan.get('left_out') or []) + left_more
    return {'done': max(0, (totals.get('documents_done') or 0) - skipped - unmatched),
            'changed': changed, 'with_nothing_found_by_the_search': unmatched,
            'skipped': skipped, 'stopped_partway': partway,
            'not_reached': max(0, len(unfinished) - partway - left_more) if 'documents' in report
            else max(0, (totals.get('documents_not_reached') or 0) - left - (totals.get('documents_unanswered') or 0)),
            'left_out': left, 'unanswered': unanswered if 'documents' in report
            else totals.get('documents_unanswered') or 0}


def left_out_ids(report: Dict[str, Any]) -> set:
    """The ids of the documents the report's plan lists as left out."""
    plan = report.get('plan') if isinstance(report.get('plan'), dict) else {}
    return {d.get('document_id') for d in plan.get('left_out') or [] if isinstance(d, dict)}


#: The most sentences a piece's summary lists (``sentences``), the rest
#: counted in ``sentences_more``, so a summary row stays under core's cap
#: (REV-JR2-2, as RW's REST_LISTED).
SENTENCES_LISTED = 50
#: The most sentences a line names one by one (REV-JR2-1): past it, the
#: count and the span, so a heartbeat line stays far under core's cap.
SENTENCES_NAMED = 8


def sentences_text(indexes: List[int]) -> str:
    """A part's sentences by their own numbers: "sentence 4", "sentences 3
    to 7" for a run, else each, "sentences 3, 11, 19" (D12: a part of
    scattered sentences is never said as a run), and past
    :data:`SENTENCES_NAMED` the count and the span, "12 sentences from 3 to
    40" (REV-JR2-1). Every line that names a part's sentences says them
    through it."""
    if len(indexes) == 1:
        return f'sentence {indexes[0]}'
    if is_run(indexes):
        return f'sentences {indexes[0]} to {indexes[-1]}'
    if len(indexes) > SENTENCES_NAMED:
        return f'{len(indexes)} sentences from {indexes[0]} to {indexes[-1]}'
    return 'sentences ' + ', '.join(str(i) for i in indexes)


def is_run(indexes: List[int]) -> bool:
    """Whether ``indexes`` follow each other with no gap."""
    return all(b == a + 1 for a, b in zip(indexes, indexes[1:]))


def word_ids_text(ids: List[str]) -> str:
    """A matched sentence's word ids as its search row keeps them: JSON, as
    many as fit under core's cap on a row (about 100 words of 36-character
    ids, REV-SF-1). A longer sentence keeps its first words' ids."""
    out = list(ids)
    while out and len(canonical(out)) > JOB_ANALYSIS_MAX_CHARS:
        out = out[:len(out) * 9 // 10]
    return canonical(out)


def no_match(d: Dict[str, Any]) -> bool:
    """Whether a report's document is one a plan limited by a search ended
    done with no sentence of it matched, and no model call (SF)."""
    return d.get('state') == 'done' and (d.get('counts') or {}).get(MATCHED) == 0


def state_text(d: Dict[str, Any], left_out: Iterable[str] = ()) -> str:
    """A document's state as the final context reads it: one the job did
    not finish is "stopped partway, 6 of 8 sentences done" once it finished a
    sentence, else "not reached" (REV-DAY-P-13), and one the plan left out
    (``left_out``, its ids) says so (D22)."""
    if d.get('state') == 'not-reached' and d.get('document_id') in set(left_out):
        return 'left out by the plan'
    if d.get('state') == 'not-reached' and (d.get('counts') or {}).get(UNANSWERED) is True:
        return 'not worked: the server did not answer'
    if d.get('state') == 'not-reached' and ((d.get('done') or 0) > 0
                                            or ((d.get('counts') or {}).get('changes') or 0) > 0):
        # One that holds the job's changes is never "not reached" (RPF3-D2).
        return f'stopped partway, {d.get("done"):,} of {d.get("targets") or 0:,} sentences done'
    if d.get('state') == 'done' and (d.get('counts') or {}).get(ONE_STEP) is True:
        # Ended in the whole-selection piece's one step, which may have read
        # none of it: its blanks are then no choice the step made (S2-3).
        if (d.get('counts') or {}).get(NOT_ALL_READ) is True:
            return 'done in the one step, which did not read all of it'
        return 'done in the one step'
    if no_match(d):
        return 'done, the plan\'s search found no sentence of it: not worked'
    return str(d.get('state'))


#: What a piece after a text edit is told, before its piece line (RPF3-B).
AFTER_TEXT_LINE = ('The text edit is written: these sentences are as it left them. Fill what is empty in them of '
                   'what this job fills. The text is not edited in this piece.')

#: What a piece of a job set up to fill only the words it adds is told
#: (RPF-A7): the piece after a text edit, and a piece that may edit the text
#: (RPF3-B), whose words it adds are filled in the piece after it.
ONLY_NEW_LINE = ('This job fills only the words it adds: fill the words your text edits add, and no other word or '
                 'sentence. A value, an analysis or a link on any other word or sentence is refused.')
ONLY_NEW_TEXT_LINE = ('This job fills only the words it adds. Stage the text edits now: the words they add are offered '
                      'for filling straight after, in a piece of their own. A value, an analysis or a link on any '
                      'other word or sentence is refused.')


#: What each change kind is called in the final context's message
#: (``core.job.CHANGE_KINDS``), one and many.
CHANGE_NOUNS = {'values': ('value set or cleared', 'values set or cleared'),
                'analyses': ('word analysis (segmentation) written or taken away',
                             'word analyses (segmentation) written or taken away'),
                'links': ('lexicon link made or taken away', 'lexicon links made or taken away'),
                'entries': ('lexicon entry made or changed', 'lexicon entries made or changed'),
                'text': ('text edit', 'text edits'), 'other': ('other change', 'other changes')}
#: The totals' keys the final context reads by another name: what each counts.
TOTAL_WORDS = {'changes': 'changes written', 'sentences': 'sentences written in', 'text_changes': 'text edits',
               'peoples_values_changed': 'values, morphemes and links people wrote, changed or removed', 'words': 'words segmented',
               'words_added': 'words added by text edits',
               'tokens_changed': 'existing words or punctuation marks changed or removed by text edits'}
#: How much of the plan's instructions for every piece the final context is handed.
JOB_SUMMARY_PLAN_CHARS = 2000


def summary_message(report: Dict[str, Any], setup: Optional[str] = None) -> str:
    """What the final context is handed: the report's sections as text, each
    bounded (JOB_SUMMARY_NOTES_CHARS for the notes, JOB_SUMMARY_TABLE_CHARS
    for the tables), saying what it left out."""
    totals = report.get('totals') or {}
    # What the job wrote, as the worker counted it, first: the model has no
    # room to assume (BRIEF PF).
    targets = sum(d.get('targets') or 0 for d in report.get('documents') or [])
    wrote = (f'This job wrote {_n_text(totals.get("changes") or 0, "change")} in {totals.get("sentences") or 0:,} '
             f'of {_n_text(targets, "sentence")}')
    lines = [wrote + (f': {fields_text(totals["fields"])}.' if totals.get('fields') else '.')]
    # Every count labelled with what it counts, never a bare number to
    # misread (RPF-A4, RP-6 read 179 values as values on existing words and
    # 14 text edits as 14 words inserted).
    parts = totals.get('changes_parts') or []
    if parts:
        said = []
        for p in parts:
            one, many = CHANGE_NOUNS.get(p['kind'], ('other change', 'other changes'))
            said.append(f'{p["n"]:,} {one if p["n"] == 1 else many}')
        lines.append(f'Its {_n_text(totals.get("changes") or 0, "change")}, by kind: ' + ', '.join(said) + '.')
    lines.append(f'Values, morphemes and links people wrote, changed or removed: '
                 f'{totals.get("peoples_values_changed") or 0:,}.')
    lines.append(f'Changes to the text: {totals.get("text_changes") or 0:,} text edits, '
                 f'{_n_text(totals.get("words_added") or 0, "word")} added, '
                 f'{totals.get("tokens_changed") or 0:,} existing words or punctuation marks changed or removed.')
    if report.get('notice'):
        lines.append(f'The report opens with the worker\'s own line: "{report["notice"]}"')
    spelled = report.get('respelled') or []
    if spelled:
        # RPF3-B: a respelled word keeps its morphemes, whose forms still
        # spell the old word. The report lists them for a person to check.
        lines.append('Words its text edits respelled, each keeping its analysis, whose morpheme forms still spell the '
                     'old word (listed in the report for a person to check): '
                     + '; '.join(f'"{r.get("name")}" {r.get("ref")} {r.get("old")} to {r.get("form")}' for r in spelled)
                     + (f' and {report["respelled_more"]:,} more' if report.get('respelled_more') else '') + '.')
    if totals.get('outside'):
        # Values in fields its setup does not name (REV-SU-B-4).
        lines.append(f'Of those, outside what it was set up to fill: {fields_text(totals["outside"])}.')
    if totals.get('blank'):
        # What is still blank of what it fills, beside what it wrote: never
        # a count of work done alone (REV-DAY-P-4, S-9).
        lines.append(f'Of what it fills: {blank_text(totals["blank"])}.')
    lines += ['', 'The job\'s instructions:', report.get('instructions') or '',
              # What the job was set up to fill (BRIEF-SU), :func:`targets.said_setup`.
              *([setup] if setup else []), '',
              'The report\'s totals (the worker counted these):',
              ', '.join([f'{TOTAL_WORDS.get(k, k.replace("_", " "))} {v:,}'
                         for k, v in sorted({**{k: v for k, v in totals.items()
                                               if k not in ('documents_done', 'documents_not_reached')},
                                             **{f'documents_{k}': v for k, v in document_counts(report).items()}}
                                            .items())
                         if v and isinstance(v, int) and not isinstance(v, bool)]
                        + ([fields_text(totals['fields'])] if totals.get('fields') else [])), '']
    plan = report.get('plan') or {}
    if plan:
        searched = plan.get('search') if isinstance(plan.get('search'), dict) else None
        lines += [f'How the work was cut: {plan.get("pieces")}'
                  + (f', only the sentences matching {searched.get("said")}: '
                     f'{_n_text(searched.get("sentences") or 0, "sentence")} in '
                     f'{_n_text(searched.get("documents") or 0, "document")}' if searched else '') + '.', '']
        told = str(plan.get('piece_instructions') or '').strip()
        if told:
            # The job's own decisions, which the summary does not ask the
            # person to settle again (RP-9, RPF-A10).
            lines += ['What the job decided, as every piece was told:', _cut(told, JOB_SUMMARY_PLAN_CHARS), '']
    lines.append('Documents:')
    left_ids = left_out_ids(report)
    for d in report.get('documents') or []:
        c = d.get('counts') or {}
        lines.append(f'- "{d.get("name")}": '
                     + ', '.join([state_text(d, left_ids)] + [f'{k} {v:,}' for k, v in sorted(c.items())
                                                    if v and isinstance(v, int) and not isinstance(v, bool)]
                                 + ([fields_text(c['fields'])] if c.get('fields') else [])
                                 + ([blank_text(c['blank'])] if c.get('blank') else []))
                     + ('. Left blank could not be read: what is blank there is not known.'
                        if d.get('left_unread') else ''))
    lines.append('In the documents, "left" counts the words and morphemes still blank at the end in sentences the '
                 'job wrote in (the report\'s Left blank), "untouched" those in sentences it worked and wrote nothing '
                 'in, which its instructions may have told it to leave (in a document the one step did not read all '
                 'of, also those in sentences it never read), "not_reached" those in sentences the job did '
                 'not reach, and "left blank" what is still blank of each thing the job fills.')
    proposed = len(report.get('proposed') or []) + (report.get('proposed_more') or 0)
    lines += ['', f'Changes listed for a person, not written (project setup and the like): {proposed:,}.', '',
              'Each piece\'s note:']
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
    """What is empty in one stretch of what the job fills (its plan's
    targets): its words empty for a word or morpheme level target, the
    sentence level targets empty in each sentence, and where every token of
    the document sits."""

    def __init__(self, doc, project: IgtProject, sentences: List[Sentence], job_id: str, known=frozenset(),
                 written: Optional['Written'] = None, targets: List[Target] = (),
                 only: Optional[Tuple[set, set]] = None):
        self.doc = doc
        self.project = project
        self.targets = list(targets)
        self.sentence_ids = {s.id for s in sentences}
        self.words: Dict[str, Word] = {}
        #: sentence id -> the sentence level targets empty in it
        self.fields: Dict[str, List[Target]] = {}
        self.where: Dict[str, Sentence] = {}
        for s in doc.sentences:
            self.where[s.id] = s
            for w in s.words:
                self.where[w.id] = s
                for m in w.morphemes:
                    self.where[m.id] = s
        self.word_of: Dict[str, str] = {}
        for s in sentences:
            words, fields = sentence_targets(s, project, job_id, known, written, self.targets)
            if only is not None:
                # A job that fills only the words it adds: nothing else is
                # empty of what it fills (RPF-A7).
                words = [w for w in words if w.id in only[0]]
                fields = fields if s.id in only[1] else []
            for w in words:
                self.words[w.id] = w
                for m in w.morphemes:
                    self.word_of[m.id] = w.id
            if fields:
                self.fields[s.id] = fields

    def sentence_of(self, token_id: Optional[str]) -> Optional[Sentence]:
        if is_virtual(token_id):
            token_id = token_id.split(':', 1)[1]
        return self.where.get(token_id)

    def empty(self) -> bool:
        return not self.words and not self.fields


#: The change kinds (:func:`jobapply.change_kind`) a job set up to fill only
#: the words it adds may write only on what it added: a value (a field, a
#: translation, an orthography), an analysis (segmentation, a morpheme's form
#: or type) and a link (REV-RPF-W-1).
ONLY_NEW_KINDS = frozenset({'values', 'analyses', 'links'})


def not_added(op: Dict[str, Any], only_new: Optional[Tuple[set, set]],
              docs: Iterable[Any]) -> Optional[Tuple[Optional[str]]]:
    """THE rule of a job set up to fill only the words it adds (RPF-A7, the
    owner's R3, REV-RPF-W-1), asked where an op is staged
    (``JobWorkspace.guard_op``, harmonize's staging included) and again where
    the job's ops are applied (``IgtRunner.recheck``): ``(the op's sentence
    id,)`` when ``op`` writes a value, an analysis or a link
    (:data:`ONLY_NEW_KINDS`), whatever field it is for, set up or not, on a
    word, a morpheme of it or a sentence the job did not add, else None. A
    word the job added is one its own text edits made, by id (``only_new``:
    ``(words, sentences)``), or one a retype of the same write makes (a
    planned word with no id yet), never by its form. A sentence counts as
    added only when the job made it (a new id): a retyped sentence keeps its
    id, so its own fields (a translation) are not the job's to write even
    when the retype gave it a new word. Every token an op names must be
    added (a multi-word expression's words each). Text edits and lexicon
    entries are not on a word, and pass. ``docs``: the documents the op's
    tokens are looked up in."""
    from . import jobapply
    if only_new is None or jobapply.change_kind(op) not in ONLY_NEW_KINDS:
        return None
    from .jobapply import _found, token_of
    from .retyped import PLANNED
    words, sentences = only_new
    planned = op.get(PLANNED)
    if planned is not None:
        if planned.get('word_id') is None:
            return None
        return None if planned.get('word_id') in words else (planned.get('sentence_id'),)
    tokens = [op.get('analysis_word_id') or op.get('word_id') or token_of(op)]
    tokens += [t for t in op.get('token_ids') or [] if t not in tokens]
    for token in tokens:
        hit = next((h for d in docs for h in [_found(d, token)] if h is not None), None)
        if hit is None:
            continue
        s, w, _m = hit
        sid = s.id if s is not None else None
        if not ((w.id in words) if w is not None else (sid in sentences)):
            return (sid,)
    return None


def outside_piece(op: Dict[str, Any], stretch: Optional['Stretch'], docs: Iterable[Any]) -> Optional[Tuple[str]]:
    """``(the sentence id,)`` when ``op`` writes a value, an analysis or a
    link (:data:`ONLY_NEW_KINDS`), or edits the text (REV-RPF3B-5: the model
    is told a piece writes only in its own), on a word, a morpheme or a
    sentence that is not one of the piece's own sentences (``stretch``: a stretch's, a whole
    document's, the sentences a piece after a text edit was given), else None
    (RP3-2: under onlynew a later piece linked a word an earlier piece
    added). onlynew narrows what a piece writes, never widens it. None for a
    piece with no stretch (a selection's, harmonize), whose writes go by the
    apply rule. A planned value on a retyped sentence's word is that
    sentence's."""
    from . import jobapply
    if stretch is None or jobapply.change_kind(op) not in ONLY_NEW_KINDS | {'text'}:
        return None
    from .jobapply import _found, token_of
    from .retyped import PLANNED
    own = stretch.sentence_ids
    planned = op.get(PLANNED)
    if planned is not None:
        sid = planned.get('sentence_id')
        return None if sid is None or sid in own else (sid,)
    tokens = [op.get('analysis_word_id') or op.get('word_id') or token_of(op)]
    tokens += [t for t in op.get('token_ids') or [] if t not in tokens]
    for token in tokens:
        hit = next((h for d in docs for h in [_found(d, token)] if h is not None), None)
        if hit is None or hit[0] is None:
            continue
        if hit[0].id not in own:
            return (hit[0].id,)
    return None


def outside_piece_text(op: Dict[str, Any]) -> str:
    """What a change refused by :func:`outside_piece` says, to the piece
    and in the report's refused list."""
    return f'{op.get("label") or op.get("kind")}: this sentence is not one of your piece\'s: a piece writes only in its own.'


def too_long_text(op: Dict[str, Any]) -> str:
    """What a change in a sentence too long for a job says, to the piece
    and in the report's refused list (S8-1)."""
    return (f'{op.get("label") or op.get("kind")}: this sentence is too long for a job (over '
            f'{JOB_SENTENCE_MAX_WORDS:,} words or {JOB_SENTENCE_MAX_CHARS:,} characters), and a job writes nothing in it.')


def in_too_long(op: Dict[str, Any], too_long: set, docs: Iterable[Any]) -> Optional[str]:
    """The id of the sentence among ``too_long`` that ``op`` writes in
    (:func:`jobapply.sentence_of` in any of ``docs``), else None."""
    if not too_long:
        return None
    from .jobapply import sentence_of
    for d in docs:
        s = sentence_of(op, d)
        if s is not None:
            return s.id if s.id in too_long else None
    return None


def not_added_text(op: Dict[str, Any]) -> str:
    """What a value refused by :func:`not_added` says, to the piece and in
    the report's refused list."""
    return f'{op.get("label") or op.get("kind")}: this job fills only the words it adds, and this is not one of them.'


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
    #: Nobody reads its answers but the job's model (tools.CONFIRM_HINT).
    UNATTENDED = True

    def __init__(self, client, project: IgtProject, stretch: Optional[Stretch] = None, mode: str = PIECE):
        super().__init__(client, project)
        self.stretch = stretch
        self.mode = mode
        self.decide_now = False
        #: the piece's closing call is under way: a budget ran out while it
        #: held staged work, and no tool is offered (BRIEF RW B2)
        self.closing = False
        #: a piece of a job that fills nothing, which ends with its findings (D26)
        self.findings = False
        #: the piece's message holds evidence (:meth:`IgtRunner.message`, D29)
        self.handed_evidence = False
        #: the piece ended without finishing, with work staged: the kind of
        #: what ended it (``budget``: its closing call, BRIEF RW B2), None
        #: when it ended by itself
        self.ended: Optional[str] = None
        #: the sentences of such a piece it did not get to (``unreached``)
        self.unreached: List[Sentence] = []
        #: a piece of the whole document
        self.whole = False
        #: a piece of a plan in sentences, offered the short list of tools
        self.in_sentences = False
        #: the job's plan says it may change the text (plan_work's
        #: ``edits_text``): else no op that does is staged (``guard_op``)
        self.edits_text = False
        self.tables: List[Dict[str, Any]] = []
        #: what the job's plan fills (:mod:`.targets`): a piece in
        #: sentences is offered the tools that fill it
        self.fills: List[Target] = []
        #: what a refusal the job cannot follow left (``leave_it``):
        #: ``{sentence_id, what}``, recorded with the piece
        self.left_by_refusal: List[Dict[str, Any]] = []
        #: the piece's model answered nothing twice (``IgtRunner.run_piece``)
        self.answered_nothing = False
        #: the planning context's plan_work, once valid
        self.plan_work: Optional[Dict[str, Any]] = None
        #: the piece's whole last reply (``IgtRunner.run_piece``)
        self.reply = ''
        #: a job set up to fill only the words it adds (RPF-A7): the ids of
        #: the words and sentences its text edits added, ``(words,
        #: sentences)``, and the setup's target ids; None for any other job
        self.only_new: Optional[Tuple[set, set]] = None
        #: the sentences the checks skipped as too long for a job, where
        #: nothing is staged (``refuse_too_long``, S8-1)
        self.too_long: set = set()

    def leave_it(self, fact: str, sentence_id: Optional[str] = None, code: Optional[str] = None) -> str:
        """A refusal whose chat advice a job cannot follow (a later turn,
        an approval, discard_plan), as a job's model reads it: what was
        refused, and the job's closing line, never the chat's step. What it
        left is kept, for the report (``core.tools.advised``), with its
        ``code``, one of :data:`LEFT_CODES` or None."""
        fact = fact.rstrip(' ;,')
        if code == RETYPED and self.edits_text and self.fills_what_follows(sentence_id):
            # It refused filling only what the piece after the text edit is
            # shown as empty and takes up (RPF3-B, REV-RPF3-1): nothing is
            # left by it. Left blank lists what that piece leaves empty.
            return f'{fact}{"" if fact.endswith((".", "!", "?")) else "."} {JOB_TEXT_THEN_FILL}'
        entry = {'sentence_id': sentence_id, 'what': fact, 'code': code}
        if entry not in self.left_by_refusal:
            self.left_by_refusal.append(entry)
        return f'{fact}{"" if fact.endswith((".", "!", "?")) else "."} {JOB_LEAVE_IT}'

    def fills_what_follows(self, sentence_id: Optional[str]) -> bool:
        """Whether the tool call being refused (``calling``, set as each call
        is made) only fills what the piece after this one's text edit will be
        shown as empty of the plan's fills, in ``sentence_id``, a sentence the
        plan retypes (REV-RPF3-1): an analysis or a value tool, naming only
        words the retype adds or words empty of every word-level target the
        plan fills (THE rule, :func:`targets.empty_in_word`), and under
        ``onlynew`` only words the retype adds. Decided from the workspace,
        never from the model's words. Anything else (a filled value, a link,
        a rule, a sentence's value) is listed as refused."""
        from .retyped import retype_of
        name, args = getattr(self, 'calling', None) or (None, None)
        if name not in FILLING_TOOLS or not isinstance(args, dict) or not sentence_id:
            return False
        level = tg.word_level(self.fills or ())
        if not level:
            return False
        refs = []
        if name == 'analyze_sentence':
            refs = [x.get('ref') for x in args.get('sentences') or [] if isinstance(x, dict)]
        elif name == 'set_field':
            refs = list(args.get('refs') or [])
        else:
            refs = [args.get('ref')]
        try:
            doc = self.doc(args.get('document'))
        except Exception:  # noqa: BLE001 - not known: listed
            return False
        edit = retype_of(self.ops, sentence_id)
        planned = (edit or {}).get('planned_words')
        s = next((x for x in doc.sentences if x.id == sentence_id), None)
        if not refs or s is None or not planned:
            return False
        words = {w.id: w for w in s.words}
        for ref in refs:
            m = FILL_REF.match(str(ref or '').strip())
            if m is None or int(m.group(1)) != s.index:
                return False
            first, last, form = m.group(2), m.group(3), m.group(4)
            if first is None:
                chosen = planned
            elif form is not None and last is None:
                chosen = [p for p in planned if p.get('surface') == form][:1]
            else:
                lo = int(first)
                hi = int(last) if last else lo
                chosen = planned[lo - 1:hi] if 1 <= lo <= hi <= len(planned) else []
            if not chosen:
                return False
            for p in chosen:
                if p.get('word_id') is None:
                    continue
                w = words.get(p['word_id'])
                if self.only_new is not None or w is None or \
                        {t.id for t in tg.empty_in_word(w, level)} != {t.id for t in level}:
                    return False
        return True

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        if self.mode == self.PLAN:
            raise ToolError('This context plans the job and stages no change: end with plan_work.',
                            kind='not-allowed')
        if not self.edits_text and jobapply.edits_text(op):
            # Whatever path staged it: a tool, a rule, code (the owner's
            # ruling of 2026-11-15). The tools are not offered either.
            raise ToolError('This job does not edit the text: its plan leaves the words and sentences as they are.',
                            kind='not-allowed')
        if op.get('kind') == 'create_entry':
            self.fit_guard(op)
        self.refuse_outside(op)
        self.refuse_not_added(op)
        self.refuse_too_long(op)
        super().guard_op(op, replacing=replacing)

    def refuse_too_long(self, op: Dict[str, Any]) -> None:
        """A change in a sentence the checks skipped as too long for a job
        is refused, whatever path staged it: its writing row could not name
        its words (REV-B4-1), and the report lists it skipped (S8-1)."""
        out = in_too_long(op, self.too_long, self._docs.values())
        if out is not None:
            raise ToolError(too_long_text(op), kind='not-allowed', code=TOO_LONG,
                            advice='Leave that sentence.', sentence_id=out)

    def refuse_outside(self, op: Dict[str, Any]) -> None:
        """Under a setup that fills only the words the job adds: a value, an
        analysis or a link on a sentence that is not one of the piece's own is
        refused, whatever path staged it (:func:`outside_piece`, RP3-2: a
        later piece linked a word an earlier piece added). Any other job's
        piece may write elsewhere in its document, as before (BRIEF NW)."""
        if self.only_new is None:
            return
        out = outside_piece(op, self.stretch, self._docs.values())
        if out is not None:
            raise ToolError(outside_piece_text(op), kind='not-allowed', code=OUTSIDE,
                            advice='Write only in your own sentences.', sentence_id=out[0])

    def refuse_not_added(self, op: Dict[str, Any]) -> None:
        """Under a setup that fills only the words the job adds (RPF-A7, the
        owner's R3): a value, an analysis or a link (:func:`not_added`) on a
        word, a morpheme of it or a sentence the job did not add is refused,
        whatever field it is for and whatever path staged it. A word the job
        added is one its own text edits made, by id (``only_new``), or one
        the retype staged in this piece makes (a planned word with no id
        yet), never by its form. Text edits are not values, and pass."""
        out = not_added(op, self.only_new, self._docs.values())
        if out is not None:
            raise ToolError(not_added_text(op), kind='not-allowed', code=NOT_ADDED,
                            advice='Fill only the words this job adds.', sentence_id=out[0])

    # What a staging tool says back, and the line every result ends with,
    # worded for a job: nothing waits for anyone, what is staged is applied
    # by the job's rule when the piece ends (REV-J-B S3-3). The chat's own
    # say a person approves a plan card and is told of it in a reply.

    tool_fault_next = 'Try another way of asking rather than the same call again.'
    @property
    def written_call_next(self) -> str:
        """After a call written as text (core.agent.written_call_note):
        nobody reads a job's reply (REV-DF4-2). A piece may end without the
        call, the planning context ends with plan_work (REV-DF5-2)."""
        return JOB_PLAN_WRITTEN_CALL_NEXT if self.mode == self.PLAN else JOB_WRITTEN_CALL_NEXT

    def staged_count(self) -> int:
        """The staged changes the job applies when the piece ends."""
        return held_changes(self) - self.proposed_count()

    def proposed_count(self) -> int:
        """The staged changes a job only lists in its report as proposed
        (``jobapply.PROPOSED_KINDS``: a rule over many documents, project
        setup), counted apart from those it applies (REV D8)."""
        return plan_changes([op for op in self.plan_view() if op.get('kind') in jobapply.PROPOSED_KINDS])

    def planned_note(self, n: int, what: Optional[str] = None) -> str:
        held, proposed = self.staged_count(), self.proposed_count()
        return (f'Staged {what or _n(n, "change")}.'
                + (f' {_n(proposed, "proposed change")} in all, listed in the report and never applied.'
                   if proposed else '')
                + (f' {_n(held, "change")}{STAGED_TAIL}' if held or not proposed else '')
                + self.superseded_note())

    def garbled(self, args):
        """The garble guard of a call (``core.garble``), less its
        ``items``: each item is asked on its own as it is staged, so one
        garbled item never refuses the rest (``items.stage_items``)."""
        if isinstance(args, dict) and 'items' in args:
            args = {k: v for k, v in args.items() if k != 'items'}
        # Worded for a piece: no run_code, file or user named (D25).
        return garble.refusal(args, self.seen, self._file_texts, job=True)

    def result_line(self) -> str:
        held, proposed = self.staged_count(), self.proposed_count()
        if proposed:
            return f'[Staged: {_n(held, "change")} to apply, {_n(proposed, "proposed change")} only listed in the report.]'
        return f'[Staged: {_n(held, "change")}.]' if held else '[Staged: nothing yet.]'

    def exclusive_message(self, staging_it: bool) -> str:
        """A restore stands alone in a piece too, with no approval or
        later turn to name (REV-JR2-5)."""
        if staging_it:
            return 'A restore cannot be staged beside other changes, and this piece already holds some.'
        return 'This piece holds a restore, and no other change can be staged beside it.'

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


# --- the runner --------------------------------------------------------------------

class Deferred(Exception):
    """The document is in use: put it off and come back later (SPEC 5.3).
    ``error``: core's passing trouble that outlasted the tries, when that put
    it off and no person did (:meth:`IgtRunner.off_on_trouble`, REV D14)."""

    def __init__(self, document_id: str, error: Optional[BaseException] = None):
        super().__init__(document_id)
        self.error = error


class Gone(Exception):
    """The document is gone."""


class ProjectChanged(Exception):
    """A layer the job read the document by is gone from the project (a
    field deleted while a piece was in flight, S5-1): the document is walked
    again at once with the project read afresh, what the piece staged not
    written."""


def refused_for_links(e: BaseException, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The entry deletions of a try that core refused because the entry has
    links the job's token cannot read (core's 409 that counts ``links``,
    another project's), nothing of the try written: those of ``ops``, else
    none (S9-2)."""
    err = core_job.plaid_error(e)
    if err is None or err.status != 409 or not isinstance(err.response_data, dict) \
            or 'links' not in err.response_data:
        return []
    if isinstance(e, PlanError) and (e.applied or e.unknown):
        return []
    return [o for o in ops if o.get('kind') == 'delete_entry']


def first_request(e: BaseException) -> bool:
    """Whether a write that met core's passing trouble may be made again
    from its gate (D21): the trouble came before its first request went out
    (``wrote_any`` is set on what a send raises), and it was not put off
    (:class:`Deferred`, a lock lost included) or found gone."""
    return not isinstance(e, (Deferred, Gone)) and not hasattr(e, 'wrote_any')


def _lock_lost(e: Optional[BaseException]) -> bool:
    """Whether ``e`` is, or was caused by, the document's lock lost
    (``DocumentLockLost``): the write is put off, whatever the renewal met
    (REV-JR1-R2-2)."""
    while e is not None:
        if isinstance(e, DocumentLockLost):
            return True
        e = e.__cause__ or e.__context__
    return False


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


#: What the follow-up of a text edit does (``igt.plan._write_text_edit``), as
#: the report lists it when it was not written: the edit's second request,
#: none when the edit called for nothing.
FOLLOW_UP_LABEL = 'Sentence breaks and morpheme forms after the text edit, if it called for any'


class Write:
    """One write of a piece in one document under its lock: the ops the
    apply rule kept, cut into TRIES in the executor's own order (:meth:`cut`),
    each sent as one request, and its MANIFEST (:meth:`rows`, :meth:`own_rows`):
    a writing row for each sentence of each try, naming the try's key and what
    it does there, in core before the write's first request (BRIEF RX-FIX).
    A text edit's try is the one exception, two requests at most: the edit
    (``<seed>.0``) and the follow-up it calls for (``<seed>.1``), each with
    rows of its own. ``own`` are the piece's own sentences the write is for
    (its part, less those that changed since the read), ``counts`` what the
    write dropped, proposed or left out, ``proposed`` the changes the rule
    proposed, ``describe(op, in_a_sentence)`` an op as the report
    lists a change."""

    def __init__(self, document_id: str, piece: str, st: Stretch, own: List[str], ops: List[Dict[str, Any]],
                 counts: Counter, fresh=None, proposed=(), describe=None, within=None):
        #: the write's tag in its rows: the start of a UUIDv7, which sorts by time
        self.id = uuid7().replace('-', '')[:PIECE_TAG_CHARS]
        self.document_id, self.piece, self.st, self.ops, self.counts = document_id, piece, st, ops, counts
        self.proposed = list(proposed)
        self.own = list(own)
        self.fresh = fresh
        self.describe = describe or (lambda op, here: {'kind': op.get('kind'), 'label': op.get('label')})
        self.layer = translation_layer(st.project)
        #: the target ids the job's setup names (``Setup.ids``), or None for
        #: a job with no setup: a value written in any other is counted
        #: outside it (:meth:`outside_of`)
        self.within = within
        #: each target's id to the name the job's setup line shows it by
        #: (``targets.shown_names``), what a row of :meth:`named` says
        self.names = None
        #: the seeds of the tries that landed (seen to)
        self.done: set = set()
        #: the creates a try holds that an earlier try of the write makes
        #: (by id): made again only when the earlier did not land, so never
        #: counted or listed twice
        self.again: set = set()

    def sentence_of(self, op: Dict[str, Any]) -> Optional[Sentence]:
        from .jobapply import sentence_of
        return sentence_of(op, self.st.doc) if op.get('kind') != 'create_entry' else None

    def word_of(self, op: Dict[str, Any]) -> Optional[str]:
        """The word an op writes on, or None."""
        from .jobapply import _found
        hit = _found(self.st.doc, op.get('analysis_word_id') or op.get('word_id') or op.get('token_id'))
        return hit[1].id if hit is not None and hit[1] is not None else None

    def translation(self, op: Dict[str, Any]) -> Optional[str]:
        """``translations`` or ``refreshed`` for a write of the translation
        field (by its layer, never another sentence field, REV-JG-11) that
        fills one where there was none or replaces one, else None."""
        if op.get('kind') == 'set_span' and op.get('layer_id') == self.layer and op.get('value') \
                and op.get('token_id') in self.st.where and self.st.where[op['token_id']].id == op['token_id']:
            return 'refreshed' if op.get('span_id') is not None else 'translations'
        return None

    def cut(self) -> List[List[Dict[str, Any]]]:
        """The write's tries, in the order the executor writes, each what it
        sends as one request (``igt.plan._execute``): the values and links
        on a word or sentence a merge of the write joins, staged before the
        merge (``written_before_merge``, ``merge_tokens``: the executor
        writes them in a batch before the merge), the rest of the batched
        changes, each text edit (the highest first), the respellings of each
        text, each sentence deletion, and the lexicon's renames, merges and
        deletions with the repairs they carry (``lexicon_last``: only valid
        together, so one request)."""
        from .plan import lexicon_last, merge_tokens, written_before_merge
        from .retyped import PLANNED
        batch, edits, respells, deletions, lexicon = [], [], {}, [], []
        # A value on a word of a retyped sentence is written in its text
        # edit's follow-up, so it is that edit's try.
        after: Dict[str, List[Dict[str, Any]]] = {}
        for o in self.ops:
            k = o.get('kind')
            if o.get(PLANNED) is not None:
                after.setdefault(o[PLANNED].get('sentence_id'), []).append(o)
            elif k == 'edit_text':
                edits.append(o)
            elif k == 'respell':
                respells.setdefault(o.get('text_id'), []).append(o)
            elif k == 'delete_sentence':
                deletions.append(o)
            elif lexicon_last(o):
                lexicon.append(o)
            else:
                batch.append(o)
        early, seen = set(), []
        for o in batch:
            joined = merge_tokens(o)
            early |= {id(p) for p in seen if joined and written_before_merge(p) in joined}
            seen.append(o)
        parts = self.split([[o for o in batch if id(o) in early], [o for o in batch if id(o) not in early]])
        return (parts + [[o] + (after.get(o.get('sentence_id')) or [] if o.get('sentence_id') else [])
                         for o in sorted(edits, key=lambda o: -(o.get('begin') or 0))]
                + list(respells.values()) + [[o] for o in deletions] + ([lexicon] if lexicon else []))

    def split(self, groups: List[List[Dict[str, Any]]]) -> List[List[Dict[str, Any]]]:
        """``groups`` of ops as tries, in order, the empty ones left out: an
        entry a group creates goes with every group that links it (one an
        earlier group makes too is in :attr:`again`: the later links the
        entry the earlier made, ``IgtRunner.entries_that_fit``), and one
        nothing links with the first."""
        creates = [o for g in groups for o in g if o.get('kind') == 'create_entry']
        groups = [[o for o in g if o.get('kind') != 'create_entry'] for g in groups]

        def links(c, g):
            return any(o.get('new_entry_key') == c.get('key') for o in g)
        out = []
        for i, g in enumerate(groups):
            mine = []
            for c in creates:
                if links(c, g) or (i == 0 and not any(links(c, h) for h in groups)):
                    if any(links(c, h) for h in groups[:i]):
                        c = dict(c)
                        self.again.add(id(c))
                    mine.append(c)
            out.append(mine + g)
        return [g for g in out if g]

    def halve(self, ops: List[Dict[str, Any]]) -> Optional[List[List[Dict[str, Any]]]]:
        """A try that does not fit one request cut in two: at a sentence
        boundary when it writes in two or more sentences (in document
        order), else in the middle of its ops, the changes of no sentence
        with the first and its creates as :meth:`split` puts them. None for
        one change."""
        rest = [o for o in ops if o.get('kind') != 'create_entry']
        if len(ops) < 2:
            return None
        order = {s.id: i for i, s in enumerate(self.st.doc.sentences)}
        sid = {id(o): getattr(self.sentence_of(o), 'id', None) for o in rest}
        sids = sorted({x for x in sid.values() if x is not None}, key=lambda x: order.get(x, 0))
        if len(sids) >= 2:
            first = set(sids[:len(sids) // 2])
            halves = [[o for o in rest if sid[id(o)] in first or sid[id(o)] is None],
                      [o for o in rest if sid[id(o)] is not None and sid[id(o)] not in first]]
        else:
            # In the middle, a word's analysis and the ops that name its
            # planned morphemes (a link, ``analysis_word_id``) kept as one
            # unit: alone, the executor drops such a link (D15).
            analysed = {o.get('word_id') for o in rest if o.get('kind') == 'set_analysis'}
            units: Dict[Any, List[Dict[str, Any]]] = {}
            for o in rest:
                # So is an op on the word's derived morpheme
                # (``virtual:<word>``): the analysis replaces it (REV-SJ2-4).
                virtual = o.get('token_id')[len(VIRTUAL_PREFIX):] if is_virtual(o.get('token_id')) else None
                key = (o.get('word_id') if o.get('kind') == 'set_analysis'
                       else o.get('analysis_word_id') if o.get('analysis_word_id') in analysed
                       else virtual if virtual in analysed else id(o))
                units.setdefault(key, []).append(o)
            groups = list(units.values())
            halves = [[o for g in groups[:len(groups) // 2] for o in g],
                      [o for g in groups[len(groups) // 2:] for o in g]]
        out = self.split([[o for o in ops if o.get('kind') == 'create_entry'] + halves[0], halves[1]])
        return out if len(out) > 1 else None

    def counts_of(self, ops: List[Dict[str, Any]]) -> Counter:
        """What a try writes in one sentence, as the record counts it: the
        changes, those that take something away, the links made, the
        translation written, and the sentence as one written in. The words
        it analyses are its row's ``words`` (:meth:`words_of`)."""
        from .jobapply import deletes
        c = Counter()
        if not ops:
            return c
        c['changes'] = len(ops)
        c['deletions'] = sum(1 for o in ops if deletes(o))
        c['links'] = sum(1 for o in ops if o.get('kind') in ('link', 'link_phrase'))
        c.update(self.of_people_and_text(ops))
        c.update(text_counts(ops))
        for o in ops:
            t = self.translation(o)
            if t:
                c[t] = 1
        c['analyzed'] = 1
        return c

    @staticmethod
    def parts_of(ops: List[Dict[str, Any]]) -> Dict[str, int]:
        """What ``ops`` are, as the report splits its changes
        (:func:`jobapply.change_kind`): ``{kind: n}``, the n summing to the
        changes ``ops`` count (RPF-A3), and what the analyses hold in the
        Changes view's nouns (REV-RPF2-2): ``analyses_morphemes``, the
        morphemes an analysis writes (each of a set_analysis, one a set
        morpheme form or type), or takes away (a discard), and
        ``analyses_values``, the values a set_analysis carries. Those two are
        not changes of their own and never sum into the changes."""
        out = Counter(jobapply.change_kind(o) for o in ops)
        for o in ops:
            kind = o.get('kind')
            if kind == 'set_analysis':
                ms = o.get('morphemes') or []
                out[ANALYSES_MORPHEMES] += len(ms)
                out[ANALYSES_VALUES] += sum(1 for m in ms for fv in m.get('fields') or []
                                            if fv.get('value') not in (None, ''))
            elif kind in ('set_morpheme_form', 'set_morph_type'):
                out[ANALYSES_MORPHEMES] += 1
            elif kind == 'discard_analysis':
                out[ANALYSES_MORPHEMES] += len(o.get('morpheme_ids') or [])
        return {k: n for k, n in out.items() if n}

    def of_people_and_text(self, ops: List[Dict[str, Any]]) -> Counter:
        """``peoples_values_changed``: the changes of ``ops`` that change or
        take away something people wrote, by its provenance in the document
        as it was before the write (:func:`replaces_people`), and what people
        wrote on the words and sentences a text edit removes
        (:func:`removes_people`, REV-RPF-W-4).
        ``text_changes``: those that change the text or its words and
        sentences (``jobapply.TEXT_KINDS``). From the worker's own ops,
        never from words (REV-DAY-S-3)."""
        doc = self.fresh if self.fresh is not None else self.st.doc
        return Counter({'peoples_values_changed': sum(replaces_people(o, doc, self.st.project) for o in ops)
                        + sum(removes_people(o, doc) for o in ops if o.get('kind') in jobapply.TEXT_KINDS),
                        'text_changes': sum(1 for o in ops if o.get('kind') in jobapply.TEXT_KINDS)})

    def words_of(self, ops: List[Dict[str, Any]]) -> List[str]:
        """The tags of the words whose segmentation ``ops`` write
        (:func:`word_tag`): a set_analysis. A value an analysis that keeps
        the word's morphemes sets (``tools.ANALYSIS_OF``) is a value of its
        field (:meth:`fields_of`), as set_field's is: one change counts one
        way whichever tool staged it (REV-DAY-P-6). A word analysed by two
        writes is one word analysed."""
        return list(dict.fromkeys(word_tag(w) for w in (self.word_of(o) for o in ops
                                                        if o.get('kind') == 'set_analysis')
                                  if w is not None))

    def fields_of(self, ops: List[Dict[str, Any]]) -> Dict[str, int]:
        """The values ``ops`` write, by the field's id (its layer): each
        ``set_span`` that writes a value (not one that clears it), on a word,
        a morpheme or a sentence alike, whichever tool staged it, and each
        value a ``set_analysis`` carries (REV-RPF-W-5: a job that glossed 8
        morphemes reads 8, 7 of them in analyses, :meth:`carried_of`). The
        changes count an analysis once, its values part of it
        (``changes_parts``), so this per-field count is never summed into
        them. A translation is counted as one (``translations``,
        ``refreshed``), never again here (REV-DAY-P-7)."""
        out: Counter = Counter()
        for o in ops:
            if o.get('kind') == 'set_span' and o.get('value') not in (None, '') and o.get('layer_id') != self.layer:
                if self.st.project.field_by_layer(o.get('layer_id')) is not None:
                    out[o['layer_id']] += 1
        out.update(self.carried_of(ops))
        return dict(out)

    def carried_of(self, ops: List[Dict[str, Any]]) -> Dict[str, int]:
        """The values the ``set_analysis`` ops of ``ops`` carry, by the
        field's id: each a morpheme of the analysis is given that is not
        blank (REV-RPF-W-5)."""
        out: Counter = Counter()
        for o in ops:
            if o.get('kind') != 'set_analysis':
                continue
            for m in o.get('morphemes') or []:
                for fv in m.get('fields') or []:
                    if fv.get('value') not in (None, '') and \
                            self.st.project.field_by_layer(fv.get('layer_id')) is not None:
                        out[fv['layer_id']] += 1
        return dict(out)

    def outside_of(self, ops: List[Dict[str, Any]]) -> Dict[str, int]:
        """What ``ops`` write on a target the job's setup does not name, by
        the target's id, decided by the id of what is written, never by a
        name (REV-SU-B-4, REV-SUFIX-1): each value a ``set_span`` writes
        (the translation's too) under its field's layer, each value a
        ``set_orthography`` writes under ``orthography:<name>``, and under
        ``segmentation`` one for each word a ``set_analysis`` segments or
        reshapes and each morpheme whose form or type is set, with each
        value the analysis carries under its field's layer. A value cleared
        counts nothing. Links and entries are not targets, so they are not
        counted. Nothing for a job with no setup. Nothing is refused: the
        setup binds the plan, and the report shows what was written past
        it."""
        from plaid_client.workflows.igt.config import is_orthography_key, orthography_name
        if self.within is None:
            return {}
        out: Counter = Counter()
        segmented = set()

        def value(layer_id, v):
            if v not in (None, '') and layer_id not in self.within \
                    and self.st.project.field_by_layer(layer_id) is not None:
                out[layer_id] += 1
        for o in ops:
            k = o.get('kind')
            if k == 'set_span':
                value(o.get('layer_id'), o.get('value'))
            elif k == 'set_orthography' and is_orthography_key(o.get('key')) and o.get('value') not in (None, ''):
                target = f'{tg.ORTHOGRAPHY}:{orthography_name(o["key"])}'
                if target not in self.within:
                    out[target] += 1
            elif k == 'set_analysis':
                segmented.add(('word', o.get('word_id')))
                for m in o.get('morphemes') or []:
                    for fv in m.get('fields') or []:
                        value(fv.get('layer_id'), fv.get('value'))
            elif k in ('set_morpheme_form', 'set_morph_type'):
                segmented.add(('morpheme', o.get('morpheme_id')))
        if segmented and tg.SEGMENTATION not in self.within:
            out[tg.SEGMENTATION] += len(segmented)
        return dict(out)

    def named(self, by_id: Dict[str, int], carried: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
        """Counts by target id as a writing row keeps them, ``[{field, id,
        values, in_analyses?}]``: ``field`` the name the job's setup line
        shows the target by (``targets.shown_names``, REV-SUFIX-2), its id
        when the project has no such target, ``in_analyses`` how many of the
        values analyses carried (``carried``), when any did."""
        if self.names is None:
            every = tg.fillable(self.st.project)
            self.names = dict(zip((t.id for t in every), tg.shown_names(self.st.project, every)))
        carried = carried or {}
        return [{'field': self.names.get(i) or i, 'id': i, 'values': n,
                 **({'in_analyses': carried[i]} if carried.get(i) else {})} for i, n in by_id.items()]

    def _others(self, sid: str, words: List[str]) -> List[str]:
        now = {s.id: s for s in (self.fresh.sentences if self.fresh is not None else [])}
        s = now.get(sid) or self.st.where.get(sid)
        return [word_tag(x.id) for x in (s.words if s is not None else []) if word_tag(x.id) not in words]

    def _sentence_row(self, sid: str, seed: str, ops: List[Dict[str, Any]], replaces: Optional[str]):
        counts = self.counts_of(ops)
        row = {'write': self.id, 'try': seed, 'piece': self.piece, 'own': sid in self.own}
        words = self.words_of(ops)
        row.update({'words': words, 'others': self._others(sid, words),
                    'counts': {k: n for k, n in counts.items() if n}, 'parts': self.parts_of(ops),
                    'ops': [self.describe(o, True) for o in ops]})
        fields = self.fields_of(ops)
        if fields:
            row['fields'] = self.named(fields, self.carried_of(ops))
        outside = self.outside_of(ops)
        if outside:
            row['outside'] = self.named(outside)
        return row

    def rows(self, seed: str, ops: List[Dict[str, Any]], replaces: Optional[str] = None,
             drops: Optional[Counter] = None) -> List[Tuple[str, Dict[str, Any]]]:
        """A try's writing rows, ``(sentence or document id, row)``: one for
        each sentence its ops write in, naming the try (``seed``), the write,
        the piece, whether the sentence is one of the write's own, every word
        of the sentence (REV-B4-1), and what the try writes there as counts
        and as the changes the report would list (``ops``). The changes of
        no sentence have a row of the document. A text edit's try has a row
        of its follow-up (``req`` 1). ``replaces``:
        the seed of the try these replace (one cut in two, or one written
        again without the links gone since), whose rows then count for
        nothing (``of``). ``drops``: what was dropped from the try it
        replaces."""
        from .jobapply import IGNORED_KINDS, deletes
        from .retyped import PLANNED
        by: Dict[Optional[str], List[Dict[str, Any]]] = {}
        after: Dict[str, List[Dict[str, Any]]] = {}
        for o in ops:
            if id(o) in self.again:
                continue
            s = self.sentence_of(o)
            if o.get(PLANNED) is not None and s is not None:
                # Written by the edit's follow-up, its second request.
                after.setdefault(s.id, []).append(o)
                continue
            by.setdefault(s.id if s is not None else None, []).append(o)
        loose = by.pop(None, [])
        out = [(sid, self._sentence_row(sid, seed, sops, replaces)) for sid, sops in by.items()]
        for sid, sops in after.items():
            row = {**self._sentence_row(sid, seed, sops, replaces), 'req': 1}
            # The sentence is counted as written in by the edit's own row.
            row['counts'] = {k: n for k, n in row['counts'].items() if k != 'analyzed'}
            out.append((sid, row))
        for o in ops:
            if o.get('kind') == 'edit_text':
                out.append(self.follow_up(seed, o))
        counts = Counter(drops or {}) + Counter({
            'changes': len(loose), 'deletions': sum(1 for o in loose if deletes(o)),
            'entries': sum(1 for o in loose if o.get('kind') == 'create_entry')}) + self.of_people_and_text(loose) \
            + text_counts(loose)
        if loose or +counts:
            out.append((self.document_id, {
                'write': self.id, 'try': seed, 'piece': self.piece, 'loose': True,
                'counts': {k: n for k, n in counts.items() if n}, 'parts': self.parts_of(loose),
                # A selection's change of no document is handed on to its
                # next write when this one does not land (``LOOSE``): never
                # listed here.
                'ops': [self.describe(o, False) for o in loose if o.get('kind') not in IGNORED_KINDS
                        and o.get(LOOSE) is None]}))
        if replaces:
            for _, row in out:
                row['of'] = replaces
        return out

    def follow_up(self, seed: str, op: Dict[str, Any], none: bool = False) -> Tuple[str, Dict[str, Any]]:
        """The row of a text edit's follow-up (``req`` 1): what it would do,
        or, ``none``, that the edit landed and called for none."""
        s = self.sentence_of(op)
        row = {'write': self.id, 'try': seed, 'req': 1, 'piece': self.piece, 'counts': {}}
        if none:
            row['none'] = True
        else:
            row['ops'] = [{**self.describe(op, s is not None), 'label': FOLLOW_UP_LABEL}]
        if s is None:
            return self.document_id, {**row, 'loose': True}
        return s.id, {**row, 'own': s.id in self.own, 'words': [], 'others': self._others(s.id, [])}

    def own_rows(self, tries: List[List[Dict[str, Any]]]) -> List[Tuple[str, Dict[str, Any]]]:
        """The write's own rows (no try of their own, ``try`` empty), which
        count only once every try of it landed: each of the piece's own
        sentences the write writes nothing in, and the write's own counts
        and proposed changes."""
        written = {s.id for ops in tries for o in ops for s in [self.sentence_of(o)] if s is not None}
        out = []
        for sid in self.own:
            if sid in written:
                continue
            out.append((sid, {'write': self.id, 'try': '', 'piece': self.piece, 'own': True, 'words': [],
                              'others': self._others(sid, []), 'counts': {}}))
        if +Counter(self.counts) or self.proposed:
            out.append((self.document_id, {'write': self.id, 'try': '', 'piece': self.piece, 'loose': True,
                                           'counts': {k: n for k, n in Counter(self.counts).items() if n},
                                           'proposed': self.proposed}))
        return out

    def marker(self, seed: str) -> Tuple[str, Dict[str, Any]]:
        """The row of a try that is not sent at all (one change that alone
        needs more than one request, listed as a proposed change): its rows
        count for nothing."""
        return (self.document_id, {'write': self.id, 'try': '', 'piece': self.piece, 'loose': True, 'counts': {},
                                   'of': seed})



def core_ns(text: Optional[str]) -> Optional[int]:
    """Core's ISO time as whole nanoseconds since the epoch, exactly: core
    stamps operations strictly increasing by one nanosecond, which a float of
    seconds cannot tell apart (REV-HFA-R2-2). None when it cannot be read."""
    if not text:
        return None
    m = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?', str(text).strip())
    if not m:
        return None
    try:
        whole = datetime.fromisoformat(m.group(1) + (m.group(3) or 'Z').replace('Z', '+00:00'))
    except ValueError:
        return None
    if whole.tzinfo is None:
        whole = whole.replace(tzinfo=timezone.utc)
    seconds = calendar.timegm(whole.utctimetuple())
    return seconds * 1_000_000_000 + int(((m.group(2) or '') + '000000000')[:9])


def seconds_ns(t: float) -> int:
    """A worker's time in seconds as nanoseconds, for the quiet window."""
    return int(round(t * 1_000_000_000))

class IgtRunner:
    """One job over interlinear text, run by ``core.job.run_job``."""

    #: What its count of people's work names (``core.job.notice``): each
    #: value, morpheme and link, as the Changes view counts them (REV-RPF2-1).
    PEOPLE_NOUNS = ('value, morpheme or link', 'values, morphemes or links')

    WORK_PHASE = WORK_PHASE
    #: The entries part of a job that never reached its entries.
    NO_ENTRIES = entries_part([], [])

    def __init__(self, job, cfg: ModelConfig, trace_dir: Optional[str] = None, count=None,
                 write_summary: bool = True, piece_output_tokens: Optional[int] = JOB_PIECE_OUTPUT_TOKENS):
        self.job = job
        #: a ceiling below the model's cap on what one call of a piece may
        #: write (the worker's --piece-output-tokens), 0 or None for none
        self.piece_output_tokens = piece_output_tokens
        #: whether the report's prose is written (the worker always does)
        self.write_summary = write_summary
        self.cfg = cfg
        self.trace_dir = trace_dir
        #: the tokens a value costs the model: the counter given (tests, a
        #: scripted model), else the model's own, the one ``Pace`` budgets
        #: with (REV-JR1-1: the worker gives none for a real model)
        self.count = count or token_counter(cfg.model)
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
        self.precedent_people: Dict[str, Any] = {}
        #: the field values index (:meth:`values_of`), read with ``people``
        self.values: Dict[Tuple[str, str], Dict[str, Dict[str, int]]] = {}
        self.people_read: Dict[str, Tuple[Any, Dict[str, Any], Dict[Tuple[str, str], Any], Dict[str, Any]]] = {}
        #: what harmonize has written so far, for the report of a job stopped in it
        self.harmonize_done: Optional[Dict[str, Any]] = None
        #: document id -> the job's writing rows of it (:meth:`writing_rows`),
        #: None before they are read
        self.rows: Optional[Dict[str, List[Dict[str, Any]]]] = None
        #: the keys of the requests of the job's tries known to have
        #: landed, and the seeds of the tries whose fate is known: a key of
        #: one of them not landed did not land (:meth:`look_up`)
        self.landed: set = set()
        self.looked: set = set()
        #: whether the report's last look at what landed was made
        #: (:meth:`known_at_end`)
        self.ended = False
        #: the documents this worker has settled once (:meth:`settle`)
        self.settled: set = set()
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
        #: documents the job has waited for once at least: their defers count
        self.waited: set = set()
        #: document id -> core's error, for a document put off last because
        #: core did not answer, and how many times core put each off in this
        #: run (:meth:`defer`, REV D14)
        self.server_off: Dict[str, BaseException] = {}
        self.unanswered: Counter = Counter()
        #: document id -> the MARK, core's own stamp of the newest History
        #: unit there at the look before a piece read the document: the
        #: piece's write is put off when anyone else wrote after it
        #: (:meth:`someone_since_mark`, REV-HFA-1, -2, -6)
        self.seen_marks: Dict[str, int] = {}
        #: documents a worker before this one was working in when it stopped:
        #: their first look marks the job's making (REV-HFA-6, fail safe)
        self.in_flight: set = set()
        #: document id -> sentences skipped past the cap of the row's list:
        #: failed or changed, and too long for a stretch
        self.unlisted: Dict[str, set] = {}
        self.too_long: Dict[str, set] = {}
        #: a try's seed -> the places among the selection's changes of no
        #: document (their ``LOOSE``) its ops held: a document put off or
        #: gone hands on to the next write only those no landed try wrote
        self.try_loose: Dict[str, set] = {}
        #: piece key -> the summary of a piece not yet kept (:meth:`begin_summary`)
        self.unsummed: Dict[str, Dict[str, Any]] = {}
        #: the keys of the pieces whose summary core held before this worker
        #: started, and the highest sequence number among them, read once per
        #: worker (:meth:`summaries_known`)
        self.summarized: Optional[set] = None
        self.piece_seq = 0
        #: the steps (tool calls, as the chat counts them) of the planning or
        #: of the piece in hand, and the heartbeat's line as it was before
        #: they were counted on it and as counted (:meth:`counting`)
        self.steps_now = 0
        self.counted: Optional[Tuple[str, str]] = None
        #: the plan's summary row, made with the plan and kept in its call
        self.plan_summary: Optional[Dict[str, Any]] = None
        #: the ids of the words and sentences the job's text edits added
        #: (:meth:`added`), read once per worker, for a setup that fills only
        #: those (RPF-A7)
        self.added_ids: Optional[Tuple[set, set]] = None
        #: the documents the whole-selection piece covered and ended, each
        #: with whether that step was not shown all of it (:meth:`one_step`)
        self.one_stepped: Dict[str, bool] = {}
        #: document id -> sentences whose staged change a person's edit
        #: dropped at the write (:meth:`recheck`): taken again after the one
        #: step (:meth:`one_step`)
        self.retake: Dict[str, set] = {}
        #: document id -> the sentences a piece's landed write changed the
        #: text of, waiting for their piece after the text edit, and whether
        #: such a piece is the one in hand (:meth:`after_text`, RPF3-B)
        self.text_edited: Dict[str, set] = {}
        self.following = False
        #: the documents whose piece after a text edit was put off once: it
        #: goes back to be taken at the start of the walk once (REV-RPF3-5)
        self.after_text_put_off: set = set()
        #: documents a piece of the whole document or of the selection has
        #: covered in this run: what remains of them is worked in stretches,
        #: never as the whole document again (BRIEF RW B1)
        self.whole_taken: set = set()
        #: document id -> what happened there when its whole-document or
        #: selection piece did not finish and nothing is walked after it
        #: (REV-RW-1, REV-RW-R2-2, REV-RW-R3-2): ``written`` (what it staged
        #: there was written, the rest not done), ``unchanged`` (an unfinished
        #: step read part of it and changed nothing), ``not-read`` (it read
        #: none of it) or ``failed`` (the step failed): the report's top line
        #: says each, ``part-failed`` (its own whole-document part failed),
        #: ``put-off`` (its changes were to be written while a person edited)
        self.ran_out: Dict[str, str] = {}
        #: document id -> the first sentence a write must leave the cursor
        #: before (:meth:`go_on`, :meth:`record`)
        self.hold_cursor: Dict[str, str] = {}

    # --- reading ---------------------------------------------------------------

    def project(self) -> IgtProject:
        return load_project(self.job.client(), self.job.project_id)

    @staticmethod
    def ignored_now(client, project: IgtProject) -> IgtProject:
        """``project`` with the ignored-token rule as its word layer holds it
        now: one read of the project's layers (no guideline, nothing parsed
        again but that rule, S5-4, REV-SJ2-5)."""
        p = client.projects.get(project.id) or {}
        layer = next((kl for tl in p.get('text_layers') or [] for kl in tl.get('token_layers') or []
                      if kl.get('id') == project.word_layer_id), {})
        cfg = read_ignored_tokens(layer.get('config'))
        return project if cfg == project.ignored_cfg else dataclasses.replace(project, ignored_cfg=cfg)

    def read(self, project: IgtProject, document_id: str, client=None):
        """The document as it is now, read afresh, or :class:`Gone`."""
        ws = Workspace(client or self.job.client(), project)
        try:
            doc = ws.load_doc(document_id)
        except PlaidAPIError as e:
            # A read core refuses 400 while the project no longer has every
            # layer the job read it by: the project changed (S5-1).
            if e.status == 400 and set(project.read_layer_ids()) - set(self.project().read_layer_ids()):
                raise ProjectChanged(document_id) from e
            raise self.refused(e, document_id) from e
        self.names[document_id] = doc.name
        return doc

    def refused(self, e: PlaidAPIError, document_id: str) -> Exception:
        """What a refusal of a document's read, lock or write means: the
        document is :class:`Gone` when core no longer finds it (404, or 403
        naming nothing, ``unresolved``), the job's right to write is gone
        on any other 403 that a heartbeat says is so (``Job.access_lost``:
        the job fails ``starter-access``, and no document is called gone for
        it), and anything else is the refusal itself: a 401 included, whose
        token ``core_job.through_core`` renews (D5), and a 403 of what the
        starter, still a writer, may not do (S9-1)."""
        fault = core_job.core_fault(e)
        if fault == 'mine':
            return self.job.ended()
        if fault == 'access' and e.status != 401:
            return self.job.access_lost() or e
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
            # Every sentence, as the walk takes them unless the plan, made
            # after the checks, says only those with something empty (the
            # walk then counts its targets again, :meth:`walk`).
            targets = 0
            for s in doc.sentences:
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
                # Never a target, and not counted done: apart from the
                # skipped sentences done counts (D11).
                counts[TOO_LONG_MORE] = len(self.too_long[d])
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
        self.in_flight = {d for d in job.order if (job.rows.get(d) or {}).get('state') == 'working'}
        plan = self.plan_made or self.plan(job)
        order = self.planned_order(job, plan)

        def left_out():
            for d in job.order:
                if d not in order and (job.rows.get(d) or {}).get('state') not in ROW_FINAL + ('not-reached',):
                    job.update_row(d, state='not-reached')
        core_job.through_core(job, left_out)
        searched = self.searched()
        if searched is not None:
            # A document the plan's search matched no sentence of ends now,
            # with no read and no model call, its row saying so (SF).
            def unmatched():
                for d in order:
                    row = job.rows.get(d) or {}
                    if row.get('state') in ROW_FINAL:
                        continue
                    if d not in searched:
                        job.update_row(d, state='done', targets=0, **self.tally(d, row.get('skipped')))
                    elif (row.get('counts') or {}).get(MATCHED) is None:
                        # A matched document reads by its matched sentences
                        # before the walk reaches it (REV-SF-7).
                        job.update_row(d, targets=len(searched[d]),
                                       counts={**(row.get('counts') or {}), MATCHED: len(searched[d])})
            core_job.through_core(job, unmatched)
        if plan['pieces'] == SELECTION and not core_job.through_core(job, self.selection_ran):
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
                    self.end_if_unanswered(d)
                    if (job.rows.get(d) or {}).get('state') not in ('in-use', 'not-reached'):
                        still.append(d)
            deferred = still
        core_job.through_core(job, self.end_summaries)

    # --- the plan (the owner's ruling 14) -----------------------------------------

    def plan(self, job) -> Dict[str, Any]:
        """The job's plan: read back when the job has one (a resumed job
        never plans again), else made by the planning context and kept. The
        planning context is given the instructions and the documents (names,
        sentences, words, how much is blank) with the assistant's reads and
        code, writes nothing, and ends with ``plan_work``. When it ends
        without a valid one after its budget and one decide-now round, the
        plan kept names nothing to work (``by`` :data:`NO_PLAN`, ``why``),
        and the job ends without writing (:meth:`plan_failure`). A planning
        that ends in a model fault (:data:`MODEL_FAULTS`) is planned once
        more, in a fresh context, and ``why`` is then the fault's kind when
        the second ends in one. One that spends its budget or meets a context
        too long ends with no plan, planned once (REV-DF5-1)."""
        if self.plan_made is not None:
            return self.plan_made
        stored = self.plan_stored(self.job.decisions())
        if stored is not None:
            self.plan_made = stored
            return self.plan_made
        if self.plan_pending is None:
            project = self.project()
            facts = self.document_facts(project, job)
            plan = None
            setup = self.job_setup(project)
            # A job set up to fill targets the project no longer has at all
            # ends with no plan, never planning freely (BRIEF-SU), and says
            # so by a why of its own (REV-SU-B-3).
            tries = 0 if setup is not None and (setup.all_gone or setup.unread) else 2
            why = None if tries else SETUP_UNREAD_REASON if setup.unread else SETUP_GONE_REASON
            # A planning that ends in a model fault (a StretchFailed of kind
            # output or repeating) is planned once more in a fresh context
            # (REV-DF4-2). A budget spent or a context too long is no plan,
            # planned once: a second planning would end the same (REV-DF5-1).
            self.steps_now = 0
            for _ in range(tries):
                try:
                    plan = self.planning(project, facts)
                    why = None if plan else NO_PLAN_REASON
                    break
                except StretchFailed as e:
                    if e.kind not in MODEL_FAULTS:
                        why = NO_PLAN_REASON
                        break
                    why = e.kind
            # No plan is never a plan made up for the job: one that filled the
            # app's default filled glosses and translations on a job asked
            # only to check (REV-DF3-2). Made once: a passing error on its row
            # below sends the same plan again, never plans again (REV-JG-8).
            self.plan_pending = {**plan, 'by': 'model', 'why': None} if plan else {'by': NO_PLAN, 'why': why}
            if setup is not None and setup.gone:
                # The setup's targets the project no longer has, by the
                # names the person saw, for the page and read_job.
                self.plan_pending['gone'] = list(setup.gone)
            # What the job page shows first of what the job did: the plan,
            # as the page words it (CONTRACT, added by LV).
            self.plan_summary = self.summary_row(0, {
                'plan': {**{k: self.plan_pending.get(k) for k in ('by', 'why', 'pieces', 'only_empty', 'edits_text',
                                                                  'gone', 'search')
                            if self.plan_pending.get(k) is not None},
                         **self.fills_named(job, self.plan_pending), **self.documents_named(job, self.plan_pending)},
                'steps': self.steps_now, 'ended_at': self.now_iso()})
        text = canonical(self.plan_kept(self.plan_pending))
        rows = [{'form': PLAN_FORM, 'key': analysis_key(text), 'analysis': text, 'count': 1,
                 'document_id': None, 'sentence_id': None}]
        if self.plan_summary is not None:
            rows.append(self.plan_summary)
        told = self.plan_pending.get('piece_instructions') or ''
        if told:
            # In the same call as the plan, so core holds both or neither.
            rows.append({'form': PLAN_INSTRUCTIONS_FORM, 'key': analysis_key(told), 'analysis': told, 'count': 1,
                         'document_id': None, 'sentence_id': None})
        # The sentences its search matched, a row each, sent first in the
        # same call (JOB_PLAN_SEARCH_MAX_SENTENCES keeps them in one), so
        # core holds them all with the plan or none of them (SF).
        # Each row holds its sentence's word ids (REV-SF-1), as many as fit.
        words = self.plan_pending.get('matched_words') or {}
        rows = [{'form': SEARCH_FORM, 'key': sid, 'analysis': word_ids_text(words.get(sid) or []), 'count': 1,
                 'document_id': d, 'sentence_id': sid}
                for d, ids in (self.plan_pending.get('matched') or {}).items() for sid in ids] + rows
        job.add_decisions(rows)
        # The job works by its plan only once core holds it.
        self.plan_made = self.plan_pending
        return self.plan_made

    def plan_failure(self, job) -> Optional[str]:
        """The reason the job ends before its work, or None, by the plan
        row's ``why``: ``no-plan`` when planning ended with no plan the model
        could keep (REV-DF3-2) or its budget or context ran out (REV-DF5-1),
        ``planning-failed`` when it ended in a model fault, twice
        (REV-DF4-2). Every document still to work is then not reached, and
        nothing is written."""
        made = self.plan_made or {}
        if made.get('by') != NO_PLAN:
            return None
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') not in ROW_FINAL + ('not-reached',):
                job.update_row(d, state='not-reached')
        why = made.get('why')
        return why if why in (NO_PLAN_REASON, SETUP_GONE_REASON, SETUP_UNREAD_REASON) else PLANNING_FAILED_REASON

    def plan_kept(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """The plan as its decision row holds it: the documents it names
        as their places in the job's order, so the plan of a job of the most
        documents, named in any order, fits one row (REV-JG-3), and its
        instructions in a row of their own (``PLAN_INSTRUCTIONS_FORM``)."""
        plan = {k: v for k, v in plan.items() if k not in ('piece_instructions', 'matched', 'matched_words')}
        named = plan.get('documents')
        if not named:
            return plan
        place = {d: i for i, d in enumerate(self.job.order)}
        return {**plan, 'documents': [place[d] for d in named if d in place]}

    def plan_stored(self, rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """The plan among the job's decision ``rows``, or None when it has
        none: its row as :meth:`plan_kept` holds it, with its documents named
        by id again and its instructions read from their row."""
        value, told, matched, words = None, '', {}, {}
        for r in rows:
            if r.get('form') == PLAN_FORM:
                try:
                    value = json.loads(r['analysis'])
                except (ValueError, TypeError, KeyError):
                    continue
            elif r.get('form') == PLAN_INSTRUCTIONS_FORM:
                told = r.get('analysis') or ''
            elif r.get('form') == SEARCH_FORM and r.get('first_document'):
                matched.setdefault(r['first_document'], []).append(r.get('key'))
                try:
                    held = json.loads(r.get('analysis') or '[]')
                except ValueError:
                    held = []
                words[r.get('key')] = [w for w in held if isinstance(w, str)] if isinstance(held, list) else []
        if not isinstance(value, dict):
            return None
        value = {**value, 'piece_instructions': told,
                 **({'matched': matched, 'matched_words': words} if value.get('search') else {})}
        places = value.get('documents')
        if not places:
            return value
        order = list(self.job.order)
        return {**value, 'documents': [order[i] for i in places if isinstance(i, int) and 0 <= i < len(order)]}

    def document_facts(self, project: IgtProject, job) -> List[Dict[str, Any]]:
        """What the planning context is told of each document still to work:
        its name, its sentences and words, and how many units are empty for
        each thing a job can fill (``empty``, target id -> count, THE rule of
        :mod:`.targets`)."""
        out = []
        for d in job.order:
            if (job.rows.get(d) or {}).get('state') in ROW_FINAL:
                continue
            try:
                doc = self.read(project, d)
            except Gone:
                job.update_row(d, state='gone')
                continue
            # Its size as whole_document measures it, for the plan's size (D23).
            out.append({**tg.document_fact(doc, project), 'id': d, 'tokens': self.document_tokens(doc, project)})
        return out

    def planning(self, project: IgtProject, facts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """The planning context: its plan_work, or None. A model that does
        not answer is asked again later, as a piece's is (SPEC 3.7)."""
        from .prompt import JOB_PLAN_NOW, build_plan_prompt
        job = self.job
        while True:
            job.check()
            ws = JobWorkspace(job.client(), project, mode=JobWorkspace.PLAN)
            # plan_work refuses, by id, what the job was not set up to do.
            ws.job_setup = self.job_setup(project)
            # Its counts tell plan_work a plan that would work no sentence.
            ws.job_documents = [{'id': f['id'], 'name': f['name'], 'sentences': f['sentences'],
                                 'empty': f['empty'], 'tokens': f.get('tokens')} for f in facts]
            system = build_plan_prompt(project)
            transcript = [{'role': 'user', 'content': self.plan_message(facts, project)}]
            seed(ws.seen, system, transcript, lambda tool, args: True)
            # The line says how many of the job's documents a read has
            # printed to it so far, from its own workspace (RPF3-E, RP2-1).
            ids = {f['id'] for f in facts}

            def read(w):
                n = sum(1 for d, shown in w.shown.items() if d in ids and shown)
                return f' {n:,} of {_n(len(ids), "document")} read.' if n else ''
            kit = Toolkit(tools_for=lambda w: toolkit.job_plan_tools(w, plan_only=w.decide_now),
                          call_tool=self.counting(toolkit.job_plan_call, '', read=read), tracer=TRACER)
            self.trace(ws, system, kit, 'plan')

            def decided():
                ws.decide_now = True
            try:
                # Its budget's decide-now line is JOB_PLAN_NOW, never a piece's.
                result = self.turn(ws, kit, system, transcript,
                                   pace=self.pace(decided, line=JOB_PLAN_NOW))
                if ws.plan_work is None:
                    # One decide-now round, plan_work alone offered, whatever
                    # the turn ended on (REV-DF4-2: a planner told by its
                    # budget had none). Under budgets of its own, so it
                    # always reaches the model.
                    ws.decide_now = True
                    more = transcript + list(result.messages or []) + [{'role': 'user', 'content': JOB_PLAN_NOW}]
                    self.turn(ws, kit, system, more, pace=self.pace(decided, line=JOB_PLAN_NOW))
                return ws.plan_work
            except StretchFailed:
                # A model fault after plan_work kept a plan loses nothing:
                # the plan is the planning's substance (REV-DF4-2).
                if ws.plan_work is not None:
                    return ws.plan_work
                raise
            except JobStopped:
                raise
            except TurnCancelled:
                job.check()
                raise JobStopped('cancelled')
            except Exception as e:  # noqa: BLE001 - sorted as a piece's are
                if core_job.core_fault(e) is not None:
                    raise
                if ws.plan_work is not None and (not_answering(e) or failure_kind(e) is not None):
                    return ws.plan_work
                if not_answering(e):
                    job.wait_for_model()
                    continue
                kind = failure_kind(e)
                if kind is None:
                    raise
                raise StretchFailed(kind, str(e)) from e

    def plan_message(self, facts: List[Dict[str, Any]], project: Optional[IgtProject] = None) -> str:
        """What the planning context is handed: the instructions, what a job
        can fill (:func:`targets.fillable`, for plan_work's ``fills``) and the
        documents, one line each with how much is empty of each, at most
        JOB_PLAN_DOCUMENT_LINES."""
        project = project or self.project()
        setup = self.job_setup(project)
        # A job set up to fill some targets is shown only those it still
        # has, with the line that says so (BRIEF-SU).
        fill = list(setup.targets) if setup is not None else tg.fillable(project)
        lines = [f'Instructions from {self.job.starter_name}:', self.job.instructions or '', '',
                 *tg.fill_lines(fill, facts, 'plan_work', 'The job\'s documents, in its order',
                                setup=setup.line if setup is not None else None),
                 '', 'Plan the job and end with plan_work.']
        return '\n'.join(lines)

    def job_setup(self, project: IgtProject) -> Optional[tg.Setup]:
        """What the job was set up to fill and whether it may edit the text
        (its ``setup``, the card the person started), on ``project`` as it is
        now, or None for a job with no setup: no limit (BRIEF-SU)."""
        return tg.setup_of(project, getattr(self.job, 'setup', None))

    def planned_order(self, job, plan: Dict[str, Any]) -> List[str]:
        """The documents the job works, in the plan's order: the plan's
        subset when it names one, else the job's own order."""
        named = plan.get('documents')
        if not named:
            return list(job.order)
        return [d for d in named if d in job.rows]

    # --- a selection: one piece for the whole job --------------------------------------

    def selection_ran(self) -> bool:
        """Whether core holds a row the selection's one ask wrote: its
        summary, or a fallback row (``selection``, or a document's, which only
        the selection's ask writes before the walk). A restarted worker then
        never asks it again (REV-RW-R2-3): its writes are in core, and asked
        again they would turn into proposals."""
        if self.fallen_back():
            return True
        self.summaries_known()
        return analysis_key(canonical({'document': None, 'first': None, 'whole': True})) in self.summarized

    def selection(self, job, order: List[str]) -> bool:
        """The whole selection as one piece: one model context reads the
        documents with its tools, and what it staged is written document by
        document, each through THE write (:meth:`write`: the gate, the lock,
        the apply rule, the record). The walk then finishes every document
        (:meth:`work`). True when the piece ran, False when it failed (the
        documents are then worked in stretches of sentences, never as a
        whole again, and the report says so: BRIEF RW).

        Every call to core in it goes through ``core_job.through_core``, as
        the walk's do (REV-JG2-3): its start, the piece (taken again from
        its start, as a stretch is, when core fails one of its reads or its
        note), and each document's write and what follows it. When core's
        trouble outlasts the piece's tries, the selection is left to the
        walk, which puts off what core does not take."""
        def begin():
            project_ = self.project()
            # Not a document the selection put off to stretches: a resumed
            # worker never asks it whole again (D18).
            off = self.fallen_back()
            live_ = [d for d in order if (job.rows.get(d) or {}).get('state') not in ROW_FINAL and d not in off]
            for d in live_:
                if (job.rows.get(d) or {}).get('state') != 'working':
                    job.update_row(d, state='working')
                # The piece reads them as it goes: its write in each is put
                # off when anyone else wrote there since (REV-HFA-1).
                try:
                    self.mark(job.client(), d)
                except Gone:
                    pass  # its write finds it gone
            return project_, live_
        project, live = core_job.through_core(job, begin)
        if not live:
            return True
        # A job that fills nothing walks nothing after its planned piece
        # (RPF-A5): a document the piece did not show is done, never worked
        # again in stretches that would each do the whole work once more.
        nothing = self.fills_nothing()
        job.set(current_document=None, message=f'Working on {_n(len(live), "document")} as one part.')
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
            except StretchFailed as e:
                return self.selection_failed(project, live, e.kind)
            except Exception as e:  # noqa: BLE001 - sorted as a piece's are
                if core_job.core_fault(e) is not None:
                    raise
                if not_answering(e):
                    job.wait_for_model()
                    continue
                kind = failure_kind(e)
                if kind is None:
                    raise
                return self.selection_failed(project, live, kind)
        ws, note = staged
        if ws.answered_nothing:
            # Asked twice, it staged nothing and said nothing: a piece that
            # failed, so the documents are worked in stretches, as after
            # any failure of the piece (DF1 item 1). Not a rule of reading.
            # Its row says so (REV-RW-6).
            return self.selection_failed(project, live, NO_ANSWER)
        key = analysis_key(canonical({'document': None, 'first': None, 'whole': True}))
        self.begin_summary(key, None, None, [], True, note, self.refused_of(ws, None), ended=ws.ended)
        # The piece's note and tables, tried again on their own: a passing
        # error on their row never runs the model context again (REV-JG3-9).
        core_job.through_core(job, lambda: self.record_piece(
            project, {'document': None, 'first': None, 'whole': True}, note, ws.tables,
            findings=ws.reply if nothing else None))
        core_job.through_core(job, lambda: self.record_refusals(ws, None))
        by_doc = self.ops_by_document(ws, live)
        # Changes no document holds (a lexicon change, a guideline) go with
        # the first document's write that lands: the rule applies the
        # lexicon's and proposes project setup. A document put off or gone
        # hands them to the next (REV-JH-2).
        loose = [{**op, LOOSE: i} for i, op in enumerate(by_doc.pop(None, []))]
        self.try_loose = {}
        # Whether the job's own changes of no document have landed: the
        # documents written after are then compared with what they read
        # now, so the links its own lexicon change moved there are not a
        # change during the job (S2-1).
        moved = False
        read = [d for d in live if d in ws._docs]
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
        # Each document is ended in the one step once the pieces after its
        # text edits have run (REV-RPF3-3), whether the piece read it or not:
        # nothing more is worked for want of reading or for what is empty
        # (the lead's ruling after RP4-5). The value: whether the step was
        # not shown all of it.
        ending: Dict[str, bool] = {}
        left_of = self.selection_unreached(project, ws, live, nothing) if ws.ended is not None else {}
        if left_of:
            # Its row says how many documents the rest went to stretches in.
            self.unsummed[key]['rest'] = [d for d in live if d in left_of]
        for d in live:
            job.check()
            # What a piece that ended without finishing did not get to here is
            # not written as worked: the walk takes it in stretches (REV-RW-1).
            shown = (ws.shown.get(d) or set()) - {s.id for s in left_of.get(d, ())}
            carried = loose if d in ws._docs else []
            if d not in ws._docs or not (shown or by_doc.get(d) or carried):
                # The piece never read it and wrote nothing there.
                ending[d] = True
                continue
            job.set(current_document=d)
            self.unsummed[key]['parts'][d] = set(shown)
            if d in left_of:
                # The fallback row and the held cursor before the write.
                self.go_on(d, ws._docs[d], left_of[d])
            try:
                if self.write_piece(project, d, ws, ws._docs[d], by_doc.get(d, []) + carried, note, shown, key,
                                    reread=moved):
                    moved = moved or bool(loose)
                    loose = []
            except Deferred as e:
                # Its writes were dropped: it is worked again in stretches
                # (its fallback row, ``whole_document``), put off by a person
                # or by core not answering (REV D14).
                error = e.error
                core_job.through_core(job, lambda: (self.fall_back(d, 'in-use' if error is None else 'unreachable'),
                                                    self.put_off(d, error)))
                # What a landed try of it wrote is never sent again nor
                # listed: the rest goes with the next write.
                done = core_job.through_core(job, self.loose_landed)
                moved = moved or any(op[LOOSE] in done for op in loose)
                loose = [op for op in loose if op[LOOSE] not in done]
                continue
            except Gone:
                core_job.through_core(job, lambda: job.update_row(d, state='gone'))
                done = core_job.through_core(job, self.loose_landed)
                moved = moved or any(op[LOOSE] in done for op in loose)
                loose = [op for op in loose if op[LOOSE] not in done]
                continue
            finally:
                self.hold_cursor.pop(d, None)
            # What a read printed to the model is what it read, never what a
            # tool loaded (REV-JG3-1): the step was not shown all of the
            # document when one of its sentences was never printed to it.
            out = self.excluded(d)
            ending[d] = any(s.id not in shown and s.id not in out for s in ws._docs[d].sentences)
        if loose and read:
            # No write landed to carry them: listed for a person.
            from .jobapply import IGNORED_KINDS
            left = [self.describe_loose(op) for op in loose if op.get('kind') not in IGNORED_KINDS]
            core_job.through_core(job, lambda: self.record_changes(left, note))
        core_job.through_core(job, lambda: self.end_summary(key))
        # The sentences whose text it changed, once more, a piece of each
        # document (RPF3-B). One put off goes back to be taken at the start of
        # its walk (:meth:`walk`, REV-RPF3-5).
        for d in [d for d in live if d in self.text_edited]:
            try:
                self.after_text(project, d)
            except (Deferred, Gone):
                continue
        # What the walk then takes of them is worked in stretches (BRIEF RW).
        self.whole_taken.update(live)
        if ws.ended is not None:
            # An unfinished step: a document it was not shown all of and
            # sends to no stretch is not walked (RPF3), and the report says
            # what happened there (REV-RW-R2-2, REV-RW-R3-2): what it staged
            # there was written and the rest not done, it read part of it and
            # changed nothing, or it read none of it.
            for d, unread in ending.items():
                if unread and d not in left_of:
                    self.ran_out[d] = ('written' if by_doc.get(d) else 'unchanged' if ws.shown.get(d)
                                       else 'not-read')
        for d, unread in ending.items():
            job.check()
            core_job.through_core(job, lambda: self.one_step(project, d, unread, left_of.get(d, ())))
        return True

    def selection_failed(self, project: IgtProject, live: List[str], kind: Optional[str]) -> bool:
        """The selection's piece failed (``kind``, ``no-answer`` included):
        its fallback row and its failed row. Under a plan that fills
        something its documents are then worked in stretches (the row's
        ``rest``). Under one that fills nothing nothing is walked after it
        (RPF-A5): each document ends, counted ``failed`` (REV-RW-R2-2).
        False: the piece did not run."""
        job = self.job
        core_job.through_core(job, lambda: self.fall_back(SELECTION, 'failed'), gave_up=lambda: None)
        nothing = self.fills_nothing()
        core_job.through_core(job, lambda: self.failed_whole(None, None, [], kind,
                                                              rest=[] if nothing else list(live)))
        if nothing:
            for d in live:
                job.check()
                core_job.through_core(job, lambda: self.end_unworked(project, d, 'failed'))
        return False

    def end_unworked(self, project: IgtProject, document_id: str, how: str) -> None:
        """End a document no piece will work, under a plan that fills nothing
        whose big piece failed (REV-RW-R2-2): every sentence not finished yet
        recorded as the big piece's, the row done, and ``counts.ran_out`` saying
        what happened there (``how``). A document core never answered for
        (``how`` :data:`UNANSWERED`) ends as :meth:`end_if_unanswered` ends
        one: not reached, its row's ``counts.unanswered`` true (REV-JR2-3,
        REV-JR2-7)."""
        row = self.job.rows.get(document_id) or {}
        if row.get('state') in ROW_FINAL:
            return
        if how == 'written' and not self.wrote_here(document_id):
            # Said written only once core holds a request of the job's write
            # there: a lost answer that did not land is core not answering
            # (REV-SJ2-2).
            how = UNANSWERED
        if how == UNANSWERED:
            # Nothing of the job's own write there was written: no
            # ``ran_out`` its unfinished piece left before it (JOIN18, REV-JOIN18-3).
            self.ran_out.pop(document_id, None)
            counts = {k: v for k, v in (row.get('counts') or {}).items() if k != RAN_OUT}
            self.job.update_row(document_id, state='not-reached', counts={**counts, UNANSWERED: True})
            return
        try:
            doc = self.read(project, document_id)
        except Gone:
            self.job.update_row(document_id, state='gone')
            return
        out = self.excluded(document_id)
        part = [s for s in doc.sentences if s.id not in out]
        if part:
            st = Stretch(doc, project, part, self.job.id, targets=[])
            self.manifest(Write(document_id, piece_tag({'document': document_id, 'whole': True}), st,
                                [s.id for s in part], [], Counter(), doc))
        self.ran_out[document_id] = how
        self.job.update_row(document_id, state='done',
                            **self.tally(document_id, (self.job.rows.get(document_id) or {}).get('skipped')))

    def selection_unreached(self, project: IgtProject, ws: JobWorkspace, live: List[str],
                            nothing: bool) -> Dict[str, List[Sentence]]:
        """After a selection's piece that ended without finishing: per
        document, what it did not get to (:meth:`unreached`, the whole
        document's rule over every sentence not finished yet). Under a plan
        that fills nothing, none: its documents end in the one step, and
        :meth:`selection` says in each what was not done."""
        if nothing:
            return {}
        out: Dict[str, List[Sentence]] = {}
        for d in live:
            try:
                doc = ws._docs.get(d) or core_job.through_core(self.job, lambda: self.read(project, d))
            except Gone:
                continue
            done = self.excluded(d)
            part = [s for s in doc.sentences if s.id not in done]
            st = Stretch(doc, project, part, self.job.id, self.known_words(d), self.written(d),
                         self.targets(project), only=self.only_new(project))
            left = self.unreached(ws, doc, part, st, True, selection=True)
            if left:
                out[d] = left
        return out

    def one_step(self, project: IgtProject, document_id: str, unread: bool, leave=()) -> None:
        """A document the whole-selection piece covered, ended with it: every
        sentence of it not finished yet is recorded as the piece's own, as a
        write that sends nothing records its sentences, so it is finished
        for good, a resumed job's too, and its counts are those of what the
        piece wrote there (``counts`` :data:`ONE_STEP`, and
        :data:`NOT_ALL_READ` when ``unread``). What stays to work is what the
        rules not about reading leave: a sentence a person changed during the
        piece is taken again by the walk (:meth:`record`), and so is a piece
        after a text edit that was put off (:attr:`text_edited`), and the
        document then ends with it. ``leave``: what a piece that ended without
        finishing did not get to there (:meth:`go_on`), left to the walk in
        stretches, the document not ended. One put off, deferred or gone is
        not here."""
        state = (self.job.rows.get(document_id) or {}).get('state')
        if state in ROW_FINAL or state == 'deferred':
            return
        try:
            doc = self.read(project, document_id)
        except Gone:
            self.job.update_row(document_id, state='gone')
            return
        out = self.excluded(document_id)
        again = {sid for sid, n in self.changed.items() if n == 1} | self.retake.get(document_id, set())
        left = {s.id for s in leave}
        part = [s for s in doc.sentences if s.id not in out and s.id not in again and s.id not in left]
        if part:
            st = Stretch(doc, project, part, self.job.id, targets=[])
            self.manifest(Write(document_id, SELECTION_TAG, st, [s.id for s in part], [], Counter(), doc))
        if left:
            self.go_on(document_id, doc, [s for s in doc.sentences if s.id in left])
            self.hold_cursor.pop(document_id, None)
            self.job.update_row(document_id, **self.tally(document_id, (self.job.rows.get(document_id) or {}).get(
                'skipped')))
            return
        self.one_stepped[document_id] = unread
        if any(s.id in again for s in doc.sentences) or document_id in self.text_edited:
            # Taken again by the walk, which then ends the document: a
            # sentence a person changed during the piece, or a piece after a
            # text edit that was put off, taken first by the walk (D19). The
            # cursor goes back before the first sentence taken again, which
            # may stand before those the piece read (D27).
            self.rewind(document_id, doc, [s for s in doc.sentences if s.id in again])
            self.job.update_row(document_id, **self.tally(document_id, (self.job.rows.get(document_id) or {}).get(
                'skipped')))
            return
        self.job.update_row(document_id, state='done',
                            **self.tally(document_id, (self.job.rows.get(document_id) or {}).get('skipped')))

    def write_piece(self, project: IgtProject, document_id: str, ws: JobWorkspace, doc,
                    ops: List[Dict[str, Any]], note: str, shown=frozenset(), summary: Optional[str] = None,
                    reread: bool = False) -> bool:
        """A selection's write in one of the documents its piece read: THE
        write (:meth:`write`), its piece the sentences of the document a read
        printed to the model (``shown``, sentence ids, REV-JG3-1: the gate
        takes out those the job finished), and every sentence's print, so a
        sentence anyone changed since the read is taken again by the walk.
        What it staged in a sentence it was not shown goes to the apply rule
        as any op of the document. Tried again from the gate after core's
        passing trouble, and put off (:class:`Deferred`) when the trouble
        outlasts the tries, as a stretch's document is (REV-JG-4). Whether
        the write landed (:meth:`write`). With ``reread``, after the
        selection's own changes of no document landed (a lexicon change that
        moved links here), the prints are of the document as it is now: the
        look inside the write still puts it off when anyone else wrote there
        since the piece's mark (REV-HFA-2, S2-1)."""
        def step():
            part = [s for s in doc.sentences if s.id in shown]
            now = self.read(project, document_id) if reread else doc
            prints = {s.id: ws.sentence_print(now, s) for s in now.sentences}
            return self.write(project, document_id, ws, doc, part, prints, ops, note, SELECTION_TAG, selection=True,
                              summary=summary)
        return self.off_on_trouble(document_id, step)

    def off_on_trouble(self, document_id: str, step: Callable[[], Any],
                       retry: Optional[Callable[[BaseException], bool]] = None) -> Any:
        """``step`` through core (:func:`core_job.through_core`), the
        document put off (:class:`Deferred`) when core's passing trouble
        outlasts the tries: by a person for a lock (423), else by core not
        answering, with its error (REV D14). ``retry`` goes to
        :func:`core_job.through_core` (a write's :func:`first_request`,
        REV-JR1-7)."""
        met: List[BaseException] = []

        def tried():
            try:
                return step()
            except Exception as e:
                met[:] = [e]
                raise

        def gave_up():
            raise Deferred(document_id, None if _status(met[0]) == 423 else met[0])
        return core_job.through_core(self.job, tried, gave_up=gave_up, retry=retry)

    def entries_that_fit(self, project: IgtProject, ops: List[Dict[str, Any]],
                         selection: bool = False) -> List[Dict[str, Any]]:
        """``ops`` as the lexicon is at a selection's write in a document: a
        create that an entry now fits (``fitting_entry``, the rule
        ``fit_guard`` holds at staging) is left out, and every link naming it
        names that entry. So the entry a selection links in several
        documents is created with the first document written and linked by
        the others, even when that write landed and the job was then taken
        up again (REV-JG2-2), and an entry someone made after the piece
        staged the create is linked rather than made twice. A stretch's and
        a document piece's creates were staged against the lexicon as it was
        after the job's last write (``fit_guard``), which is not read
        again."""
        creates = [o for o in ops if o.get('kind') == 'create_entry'] if selection else []
        if not creates:
            return ops
        vocab = {x['id']: x for x in project.vocabs if not x.get('borrowed')}
        ws = Workspace(self.job.client(), project)
        found: Dict[str, str] = {}
        for o in creates:
            v = vocab.get(o.get('vocab_id'))
            item = fitting_entry(v, ws.lexicon(v), o) if v is not None else None
            if item is not None:
                found[o.get('key')] = item['id']
        if not found:
            return ops
        out = []
        for o in ops:
            if o.get('kind') == 'create_entry' and o.get('key') in found:
                continue
            if o.get('kind') in ('link', 'link_phrase') and o.get('new_entry_key') in found:
                o = {**o, 'item_id': found[o['new_entry_key']], 'new_entry_key': None}
            out.append(o)
        return out

    def selection_work(self, project: IgtProject, documents: List[str]):
        job = self.job
        job.check()
        ws = JobWorkspace(job.client(), project)
        ws.too_long = set().union(*(self.too_long_ids(d) for d in documents))
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
        """A piece's ops by the document each writes in (the document it
        names, else by the token it names, among the documents the piece
        read), None for an op of no
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
            # The document it names first, as the apply rule places it
            # (``jobapply.place``): a respell names its own by ``doc`` (D1).
            d = op.get('document_id') or op.get('doc') or where.get(token)
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
        return {'kind': op.get('kind'), 'document_id': None, 'document': None, 'ref': None, 'field': None,
                'from': None, 'to': _cut(after, JOB_CHANGE_VALUE_CHARS),
                'label': _cut(what, JOB_CHANGE_VALUE_CHARS)}

    def wait_for_people(self, documents: List[str]) -> None:
        """Wait :data:`JOB_DEFER_WAIT_S` before taking ``documents`` again,
        saying so: what for, and how long, never a clock time (whose clock is
        the worker's, not the reader's)."""
        job = self.job
        minutes = round(JOB_DEFER_WAIT_S / 60)
        # Those core put off are no person's: said apart, and not counted as
        # a wait for people's edits (REV D14).
        people = [d for d in documents if d not in self.server_off]
        if people:
            name = self.names.get(people[0]) or (job.rows.get(people[0]) or {}).get('name')
            where = (f'"{name}"' if name else 'a document') if len(people) == 1 else f'{len(people)} documents'
            message = f'Waiting for people to finish in {where}. Trying again in {minutes} minutes.'
        else:
            message = f'The server did not answer. Trying again in {minutes} minutes.'
        said = job.line
        job.set(current_document=None, message=message)
        began = job.now()
        try:
            job.sleep(JOB_DEFER_WAIT_S)
        finally:
            # Counted apart from taking turns on the model (RPF3-D1).
            if people:
                job.paused['edits'] += job.now() - began
            if not job.lost:
                job.set(message=said)

    def put_off(self, document_id: str, error: Optional[BaseException]) -> str:
        """Put a document off: for a person (:meth:`defer`), or because core
        did not answer (``error``, REV D14), which counts no defer and never
        ends it ``in-use`` (:meth:`end_if_unanswered` bounds it)."""
        if error is None:
            return self.defer(document_id)
        self.seen_marks.pop(document_id, None)
        self.server_off[document_id] = error
        # Counted as a person's defer is, only once the job has waited for
        # it: the same waits whatever put it off first (REV-JR2-4).
        self.unanswered[document_id] += 1 if document_id in self.waited else 0
        self.job.update_row(document_id, state='deferred')
        return 'deferred'

    def defer(self, document_id: str) -> str:
        """Put a document off. A defer counts only after the job has waited
        for it (:meth:`wait_for_people`): a document in use is waited for
        JOB_DEFER_ROUNDS times before it ends ``in-use`` (SPEC 5.3), never
        counted twice within a second by passes with no wait between."""
        # Taken up again later, it is looked at afresh.
        self.seen_marks.pop(document_id, None)
        self.server_off.pop(document_id, None)
        row = self.job.rows.get(document_id) or {}
        defers = (row.get('defers') or 0) + (1 if document_id in self.waited else 0)
        self.job.update_row(document_id, defers=defers,
                            state='in-use' if defers >= JOB_DEFER_ROUNDS else 'deferred')
        return 'deferred'

    def end_if_unanswered(self, document_id: str) -> None:
        """A document core put off after JOB_DEFER_ROUNDS waits, as a
        person's would end ``in-use``, ends ``not-reached``: the
        job did not finish it, and goes on (REV-JG-4's job that ends done,
        never in use for it, REV D14)."""
        if document_id in self.server_off and self.unanswered[document_id] >= JOB_DEFER_ROUNDS:
            # Never also "written as staged" (REV-JOIN18-3).
            self.ran_out.pop(document_id, None)
            row = self.job.rows.get(document_id) or {}
            core_job.through_core(self.job, lambda: self.job.update_row(
                document_id, state='not-reached', counts={**(row.get('counts') or {}), UNANSWERED: True}))

    @property
    def own_ref(self) -> str:
        """The ref prefix of the job's own passes in a document. A person's
        Undo or Redo of the job's entry (``job:<id>/undo``) is not the
        job's: it is someone in the document (REV-HFA-3)."""
        return f'job:{self.job.id}/doc:'

    def created(self) -> int:
        when = core_ns(self.job.job.get('created_at'))
        return when if when is not None else 0

    def someone_after(self, client, document_id: str, since: int):
        """``(unit, top)``: the newest unit of the document's History not the
        job's own that ended after ``since`` (or has no end time, which
        counts, REV-HFA-4), or None, and the end time of the newest unit of
        anyone, the job's included (None for an empty History). The job's
        own units are read past, so a person who wrote while a piece was in
        flight is still seen once the piece's write lands on top (H14-1).
        Core places a unit by its newest operation, at its ``end_time``
        (REV-B4-4), stamped strictly increasing, so the read stops at the
        first unit that ended at or before ``since``. One operation of each
        unit is read (``ops_limit``): core takes ``end_time`` from all of
        them (REV-HFA-5)."""
        mine = self.own_ref
        top = None
        first = True
        cursor = None
        while True:
            try:
                page = client.documents.audit_page(document_id, order='desc', limit=20, cursor=cursor,
                                                   ops_limit=1) or {}
            except PlaidAPIError as e:
                raise self.refused(e, document_id) from e
            entries = page.get('entries') if isinstance(page, dict) else page
            for unit in entries or []:
                when = core_ns(unit.get('end_time'))
                if first:
                    top, first = when, False
                theirs = not str(unit.get('ref') or '').startswith(mine)
                if when is None:
                    if theirs:
                        return unit, top
                    continue
                if when <= since:
                    return None, top
                if theirs:
                    return unit, top
            cursor = page.get('next_cursor') if isinstance(page, dict) else None
            if not cursor:
                return None, top

    def newest_change(self, client, document_id: str, keep: bool = False) -> Optional[Dict[str, Any]]:
        """The look before a piece (SPEC 5.2): the newest unit of the
        document's History by anyone else that ended after the job was made
        and within the quiet window, or None. It also sets the document's
        mark (:attr:`seen_marks`) for the piece that follows: the newest unit's
        end time, core's own stamp, or the job's making for a document a
        stopped worker was working in. ``keep``: an older mark stays (the
        piece after a text edit, inside a stretch whose later halves write
        against the stretch's mark, REV-HFA-R2-1)."""
        created = self.created()
        since = max(created, seconds_ns(self.job.now() - JOB_PERSON_QUIET_S))
        unit, top = self.someone_after(client, document_id, since)
        if document_id in self.in_flight:
            self.in_flight.discard(document_id)
            self.seen_marks[document_id] = created
        else:
            now = top if top is not None else created
            old = self.seen_marks.get(document_id) if keep else None
            self.seen_marks[document_id] = now if old is None else min(old, now)
        return unit

    def mark(self, client, document_id: str) -> None:
        """Set the document's mark with no look, as a whole-selection piece
        does for each of its documents as it begins."""
        if document_id in self.in_flight:
            self.in_flight.discard(document_id)
            self.seen_marks[document_id] = self.created()
            return
        _unit, top = self.someone_after(client, document_id, 1 << 80)
        self.seen_marks[document_id] = top if top is not None else self.created()

    def someone_since_mark(self, client, document_id: str) -> bool:
        """Whether anyone else wrote in the document after its mark: asked
        inside THE write, under the lock, just before it is sent. No worker
        clock: both times are core's. No mark (none was set): the job's
        making, so in doubt the document is put off, never written."""
        unit, _top = self.someone_after(client, document_id, self.seen_marks.get(document_id, self.created()))
        return unit is not None

    def in_use(self, last: Optional[Dict[str, Any]], job_ref: str) -> bool:
        """Someone else is in the document: a person, a service run, another
        job (SPEC 5.2), whether or not the job wrote after them. ``last`` is
        the document's :meth:`newest_change`, which holds the rule: what was
        written after the job was made (the edit its starter made just before
        pressing Start is not a person in the document, REV-J-B S3-5) and
        within the quiet window."""
        return bool(last) and not str(last.get('ref') or '').startswith(job_ref)

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

        def walk():
            try:
                return self.walk(document_id)
            except ProjectChanged:
                # Walked again once, with the project as it now is (S5-1).
                logger.warning('Job %s: the project changed under document %s: walked again', job.id, document_id)
                return self.walk(document_id)

        def step():
            try:
                return walk()
            except Deferred as e:
                # By a person, or by core not answering for a write inside
                # the walk (REV-JR1-7). A lock lost whose renewal met core's
                # trouble still comes with no error and counts as a person's
                # (REV-JOIN18-8).
                return self.put_off(document_id, e.error)
            except Gone:
                job.update_row(document_id, state='gone')
                return 'gone'
        try:
            try:
                return self.off_on_trouble(document_id, step)
            except Deferred as e:
                error = e.error
            return core_job.through_core(job, lambda: self.put_off(document_id, error))
        except Exception as e:  # noqa: BLE001 - core's refusals sorted, the rest goes up
            fault = core_job.core_fault(e)
            if fault == 'mine':
                raise job.ended() from e
            if fault == 'access':
                # A refusal of what a writer may not do, the starter still
                # writing (S9-1), goes up as itself.
                stop = job.access_lost()
                if stop is not None:
                    raise stop from e
            raise

    def walk(self, document_id: str) -> str:
        job = self.job
        project = self.project()
        self.read_people(project)
        if (job.rows.get(document_id) or {}).get('state') != 'working':
            job.update_row(document_id, state='working')
        turns = 0
        while True:
            job.check()
            client = job.client()
            if turns:
                # The ignored-token rule as it is now, as each write reads it:
                # a word it hides since is not offered again (S5-4,
                # REV-SJ2-5). The first turn has just loaded the project.
                project = self.ignored_now(client, project)
            turns += 1
            doc = self.read(project, document_id, client)
            if self.in_use(self.newest_change(client, document_id), self.own_ref):
                return self.defer(document_id)
            if document_id in self.text_edited:
                # A piece after a text edit put off earlier, taken first
                # (REV-RPF3-5).
                self.after_text(project, document_id)
                continue
            self.settle(project, document_id, doc)
            pending = self.pending(doc, project, document_id,
                                   every=self.every_sentence())
            if not pending:
                # The row's counts whole: a record whose row update core
                # failed is in core, and its counts reach the row here.
                fields = self.tally(document_id, (job.rows.get(document_id) or {}).get('skipped'))
                if self.searched() is not None:
                    # What the walk took is all it finished: the checks
                    # counted every sentence (SF).
                    fields['targets'] = fields['done']
                job.update_row(document_id, state='done', **fields)
                return 'done'
            row = job.rows.get(document_id) or {}
            total, done = row.get('targets') or 0, row.get('done') or 0
            if total != done + len(pending):
                # What the walk takes, as the plan says (the checks counted
                # every sentence before there was a plan).
                total = done + len(pending)
                job.update_row(document_id, targets=total)
            # Decided once something is pending, so a document ended by its
            # whole piece records no fallback.
            whole = self.whole_document(project, doc)
            if not whole and self.fills_nothing() and (self.plan_made or {}).get('pieces') in (DOCUMENT, SELECTION):
                # A plan that fills nothing never works a document in
                # stretches (RPF-A5), whatever fallback row it carries but
                # too-long: put off for a person, or left live by a worker that
                # died ending a failed selection's documents. It is ended and
                # the top line says what happened there (REV-RW-R3-1).
                fallen = self.fallen_back()
                reason = fallen.get(doc.id) or (SELECTION if SELECTION in fallen else None)
                if reason and reason != 'too-long':
                    self.end_unworked(project, document_id, UNWORKED_HOW.get(reason, 'failed'))
                    return 'done'
            part = pending if whole else pending[:JOB_STRETCH_SENTENCES]
            job.set(message=self.matching_line(doc, part) if self.searched() is not None else
                    self.progress_line(doc.name, whole, [s.index for s in part], len(doc.sentences)))
            if whole:
                # The whole document is asked once. A failure is never halved
                # into the same whole document again (its halves would each be
                # the whole document, BRIEF RW): the document falls back to
                # stretches of sentences, kept in core so a resumed job does too.
                # Whatever follows the ask (a failure, a write put off for a
                # person, a passing core error, a sentence a person changed
                # meanwhile), what remains is worked in stretches: never the
                # whole document a second time in this run (REV-RW-3).
                try:
                    self.attempt(project, document_id, [s.id for s in part])
                except StretchFailed as e:
                    if self.fills_nothing():
                        # A check walks nothing after its big piece (RPF-A5),
                        # however it ended: the document ends, counted failed
                        # (REV-RW-R2-2).
                        self.failed_whole(document_id, doc.name, part, e.kind)
                        self.end_unworked(project, document_id, 'part-failed')
                        return 'done'
                    core_job.through_core(job, lambda: self.fall_back(document_id, 'failed'))
                    # A row of its own in the work list, saying it failed and
                    # what follows (B5).
                    self.failed_whole(document_id, doc.name, part, e.kind, rest=[document_id])
                except Deferred as e:
                    # Its write put off: what it would have written remains, so
                    # the fallback row is kept now, in core, and a worker that
                    # restarts during the wait works it in stretches too
                    # (REV-RW-4). Its reason is a put-off's (``in-use``), which
                    # a plan that fills nothing says so (REV-RW-R3-1), or
                    # ``unreachable`` when core did not answer, as a
                    # selection's is (REV D14, REV-JR2-7).
                    reason = 'in-use' if e.error is None else 'unreachable'
                    core_job.through_core(job, lambda: self.fall_back(document_id, reason))
                    raise
                except Exception as e:  # noqa: BLE001 - only a check's unwritten write is sorted here
                    # A check's write that met core's passing trouble once its
                    # request went out, nothing of it landed before: put off as
                    # core not answering, as before its first request. It walks
                    # nothing after its big piece, so taken again (REV-L2B) it
                    # would end as written (JOIN18).
                    if not (self.fills_nothing() and getattr(e, 'wrote_any', True) is False
                            and core_job.core_fault(e) == 'passing'):
                        raise
                    core_job.through_core(job, lambda: self.fall_back(document_id, 'unreachable'))
                    raise Deferred(document_id, e) from e
                finally:
                    self.whole_taken.add(document_id)
                continue
            halve([s.id for s in part], lambda ids: self.attempt(project, document_id, ids),
                  lambda sid, kind: self.failed_piece(document_id, doc, sid, kind))

    def progress_line(self, name: str, whole: bool, indexes: List[int], total: int) -> str:
        """The heartbeat's line for a piece of one document (RPF-A6): which
        sentences, or the whole document as one piece, after the document's
        name when the job has more than one, so the line never seems to go
        back when the next document starts. ``indexes`` are the sentences'
        own numbers and ``total`` the document's sentences, as the work list
        names a piece "s3 to s7" (RP4-5 F4: one numbering), each named when
        they are not a run (D12)."""
        said = 'the whole document as one part' if whole else f'{sentences_text(indexes)} of {total}'
        return f'{name}: {said}.' if len(self.job.order) > 1 else said[0].upper() + said[1:] + '.'

    def matching_line(self, doc, part: List[Sentence]) -> str:
        """The heartbeat's line for a stretch of a plan limited by a search
        (SF): where its sentences stand among all the search matched, in the
        plan's order of documents, "Story B: sentences 4 to 6 of 33
        matching.", now "Story B: matching sentences 4 to 6 of 33." and
        "Matching sentence 3 of 33." for a job of one document (REV-SF-9: by
        its count among the matched, said as such)."""
        searched = self.searched() or {}
        order = [d for d in self.planned_order(self.job, self.plan_made or {}) if d in searched]
        before = sum(len(searched[d]) for d in order[:order.index(doc.id)]) if doc.id in order else 0
        takes = self.search_takes(doc.id)
        mine = [s.id for s in doc.sentences if takes is not None and takes(s)]
        at = [before + mine.index(s.id) + 1 for s in part if s.id in mine] or [before + 1]
        # Counted as the positions are: this document's by what the walk takes
        # now (a split takes more), the others' as matched (REV-SF2-3).
        total = sum(len(v) for d, v in searched.items() if d != doc.id) + len(mine)
        said = f'matching sentence {at[0]:,}' if at[0] == at[-1] else f'matching sentences {at[0]:,} to {at[-1]:,}'
        line = f'{said} of {total:,}'
        return f'{doc.name}: {line}.' if len(self.job.order) > 1 else line[0].upper() + line[1:] + '.'

    def searched(self) -> Optional[Dict[str, set]]:
        """The sentences the plan's search matched at planning, by document
        (SF), or None for a plan with no search. Fixed for the job: the walk
        never searches again, so a sentence a person changes afterwards is
        taken by the walk's own rules, matching or not, and a sentence a
        split or a merge gives a new id is not taken."""
        plan = self.plan_made or {}
        if not plan.get('search'):
            return None
        return {d: set(ids) for d, ids in (plan.get('matched') or {}).items()}

    def search_takes(self, document_id: str) -> Optional[Callable[[Sentence], bool]]:
        """Whether a sentence of ``document_id`` is one the plan's search
        matched at planning: its id was matched, or it holds a word of a
        matched sentence (REV-SF-1: a split or a merge gives a sentence a new
        id and keeps its words' ids). None for a plan with no search."""
        searched = self.searched()
        if searched is None:
            return None
        ids = searched.get(document_id, set())
        words = {w for sid in ids for w in ((self.plan_made or {}).get('matched_words') or {}).get(sid) or ()}
        return lambda s: s.id in ids or any(w.id in words for w in s.words)

    def whole_document(self, project: IgtProject, doc) -> bool:
        """Whether this document is worked as one piece: the plan says
        ``document``, and the document as the piece's message renders it
        fits JOB_DOCUMENT_PIECE_MAX_TOKENS (:meth:`document_tokens`). A
        document larger than that is
        worked in stretches of sentences, which the report says (a fallback
        row among the job's decisions). So is a document with a fallback
        row of any reason (its whole-document piece failed, its write after
        the selection's piece was put off), and every document once the
        selection's piece failed (BRIEF RW: a failed piece larger than a
        stretch is followed by stretches, never by the same work as a
        whole)."""
        plan = self.plan_made or {}
        if plan.get('pieces') not in (DOCUMENT, SELECTION):
            return False
        if doc.id in self.fallen_back() or SELECTION in self.fallen_back():
            return False
        if doc.id in self.whole_taken:
            # A whole piece over it has run in this run, and something is
            # still to work there: in stretches, which the report counts.
            self.fall_back(doc.id, 'again')
            return False
        if self.document_tokens(doc, project) <= JOB_DOCUMENT_PIECE_MAX_TOKENS:
            return True
        self.fall_back(doc.id, 'too-long')
        return False

    def document_tokens(self, doc, project: IgtProject) -> int:
        """The document as a piece's message renders it, in the tokens the
        piece's budget counts (``count``, D23)."""
        return self.count('\n'.join(render_sentence(s, project) for s in doc.sentences))

    def every_sentence(self) -> bool:
        """Whether the walk takes every sentence of a document, empty or
        not: always, but under a plan in sentences with ``only_empty``
        (plan_work's ``skip_filled_sentences``, for instructions that only
        fill what is empty of what the job fills), which walks only
        sentences that hold something empty (BRIEF EW: a job filling a new
        field, or checking glosses, on texts already analysed has every
        sentence to do). A document of a plan by documents or selection that is worked
        in stretches (too long for one piece, or put off from the selection)
        is still worked whole: the fallback changes the size of the pieces,
        never what is worked (REV-JG-7)."""
        plan = self.plan_made or {}
        if self.only_new() is not None:
            # Nothing is empty of what it fills until its own edits add
            # words: every sentence (RPF-A7).
            return True
        return not (plan.get('pieces', SENTENCES) == SENTENCES and plan.get('only_empty') is True)

    def pending(self, doc, project: IgtProject, document_id: str, every: bool = False) -> List[Sentence]:
        """The sentences after the cursor the job works, in document order,
        less those skipped and those a landed write of their own piece wrote
        in (:meth:`finished`: a writing row, or a word of such a sentence,
        which a split or a merge may have moved into a sentence of another
        id: :meth:`excluded`). In stretches,
        only sentences that hold something empty (:func:`sentence_targets`).
        With ``every`` (:meth:`every_sentence`) every such sentence, empty or
        not: what the piece does is its instructions'. A cursor
        whose sentence is gone starts from the top (SPEC 3.8)."""
        row = self.job.rows.get(document_id) or {}
        skipped = self.excluded(document_id)
        known = self.known_words(document_id)
        written = self.written(document_id)
        ids = [s.id for s in doc.sentences]
        start = ids.index(row['last_sentence']) + 1 if row.get('last_sentence') in ids else 0
        # Under a plan limited by a search, only the sentences it matched
        # (SF), and with skip_filled_sentences only those of them with
        # something empty: the two rules by AND.
        takes = self.search_takes(document_id)
        out = []
        for s in doc.sentences[start:]:
            if s.id in skipped or (takes is not None and not takes(s)):
                continue
            if every:
                if not wrote_in(s, known):
                    out.append(s)
                continue
            words, fields = sentence_targets(s, project, self.job.id, known, written, self.targets(project))
            if words or fields:
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
            *staged, key = staged
            # What a piece that ended without finishing did not get to is
            # settled BEFORE its write, so a worker that dies between the two
            # passes no sentence uncounted (REV-SP-10, REV-RW-2). Tried again
            # on its own: a passing error never asks the model again
            # (REV-JR1-12).
            core_job.through_core(self.job, lambda: self.unfinished(document_id, staged[0], staged[1]))
            # Tried again from the gate after core's passing trouble met
            # before its first request, and put off when it outlasts the
            # tries: such an error never runs the model context again (D21).
            # Once a request of it went out (``wrote_any`` set, whatever its
            # value), the piece is taken again over what is left, as before
            # (REV-L2B): its own tries that may have landed would read as
            # changes since the piece read the document. Put off by a person
            # or by core not answering, with its error (REV-JR1-7).
            try:
                self.off_on_trouble(document_id, lambda: self.write(project, document_id, *staged, summary=key),
                                    retry=first_request)
            finally:
                self.hold_cursor.pop(document_id, None)
            core_job.through_core(self.job, lambda: self.end_summary(key))
            self.after_text(project, document_id)

    def unreached(self, ws: JobWorkspace, doc, part: List[Sentence], st: Stretch, whole: bool,
                  selection: bool = False) -> List[Sentence]:
        """The sentences of a piece that ended without finishing that it did
        not get to (THE rule after such a piece, CONTRACT "Added by RW"):
        among the sentences it staged nothing in, those the ordinary walk
        would take for this plan. In a stretch, all of them. In a whole
        document, all of them when the plan takes every sentence
        (:meth:`every_sentence`: a job that revises filled sentences), else
        those holding something the plan fills that is empty (``st``, the
        empty rule of igt/targets.py), and none under a plan that fills
        nothing, which walks nothing after its big piece. In a document of a
        selection (``selection``), RPF3's rule after a selection: those holding
        something empty."""
        from .jobapply import sentence_of
        staged = {getattr(sentence_of(op, doc), 'id', None) for op in ws.ops}
        unstaged = [s for s in part if s.id not in staged]
        if not whole:
            return unstaged
        if self.fills_nothing():
            return []
        if not selection and self.every_sentence():
            return unstaged
        empty = {st.where[w].id for w in st.words if w in st.where} | set(st.fields)
        return [s for s in unstaged if s.id in empty]

    def unfinished(self, document_id: str, ws: JobWorkspace, doc) -> None:
        """Before the write of a piece that ended without finishing: in a
        stretch, each sentence it did not get to is skipped as failed with
        what ended it (the cursor not moved), so it is counted, never passed
        as worked (REV-RW-2). In a whole document, :meth:`go_on`."""
        if ws.ended is None:
            return
        if not ws.whole:
            for s in ws.unreached:
                self.skip(document_id, doc, s.id, 'failed', ws.ended, cursor=False)
            return
        self.go_on(document_id, doc, ws.unreached)

    def go_on(self, document_id: str, doc, unreached: List[Sentence]) -> None:
        """A document whose whole-document or selection piece ended without
        finishing, once what it staged is written: what it did not get to
        (``unreached``) is worked in stretches, with a fallback row
        ``ran-out``, the cursor put back before the first of it, so no
        sentence is passed. With none, under a plan that fills nothing, the
        document ends as it is, and the report says the rest of the work
        was not done (``counts.ran_out``). With none otherwise: nothing is
        left."""
        if not unreached:
            if self.fills_nothing():
                self.ran_out[document_id] = 'written'
            return
        # The fallback row first, then the write holds the cursor before
        # the first of them (``hold_cursor``, read by :meth:`record`), so
        # neither a crash nor a resume passes one.
        core_job.through_core(self.job, lambda: self.fall_back(document_id, 'ran-out'))
        self.hold_cursor[document_id] = min(unreached, key=lambda s: s.index).id
        self.rewind(document_id, doc, unreached)

    def rewind(self, document_id: str, doc, sentences: List[Sentence]) -> None:
        """Put the document's cursor back before the first of ``sentences``
        when it stands at or past it (as ``record`` does for a sentence taken
        again): the walk then takes them, and passes every sentence a write
        finished."""
        ids = [s.id for s in doc.sentences]
        at = [ids.index(s.id) for s in sentences if s.id in ids]
        if not at:
            return
        before = ids[min(at) - 1] if min(at) > 0 else None
        row = self.job.rows.get(document_id) or {}
        if row.get('last_sentence') == before:
            return
        if before is None or not self._after_cursor(row, doc, before):
            self.job.update_row(document_id, last_sentence=before)

    def after_text(self, project: IgtProject, document_id: str) -> None:
        """The piece after a text edit (RPF3-B): the sentences whose text the
        piece's landed write changed (:attr:`text_edited`) taken ONCE more,
        as they are now, with what is empty of what the job fills there
        (under ``onlynew`` only on the words the job added), the text tools
        not offered. A word a piece adds can be analysed in one job, which
        its own plan could not do: an analysis of a word the plan retypes is
        refused. Never a loop: a piece after a text edit is followed by none.
        No model call when nothing is empty there. A failure of its model is
        recorded as a stretch's is: its sentences skipped ``failed``, on a row
        of its own. Like a stretch, it is not run while someone else edits
        the document, and a write of it put off by a person's edit is not
        summed up: either way its sentences go back to be taken at the start
        of the document's walk, once (REV-RPF3-5, -8). A second put-off
        leaves them, and Left blank lists what is empty there."""
        ids = self.text_edited.pop(document_id, None)
        if not ids:
            return
        job = self.job
        job.check()
        client = job.client()

        def put_off(error: Optional[BaseException] = None):
            if document_id not in self.after_text_put_off:
                self.after_text_put_off.add(document_id)
                self.text_edited[document_id] = set(ids)
            raise Deferred(document_id, error)
        if self.in_use(self.newest_change(client, document_id, keep=True), self.own_ref):
            put_off()
        ws = JobWorkspace(client, project)
        try:
            doc = self.read(project, document_id, client)
        except Gone:
            return
        ws._docs[document_id] = doc
        doc = ws.doc(document_id)
        part = [s for s in doc.sentences if s.id in ids]
        st = Stretch(doc, project, part, job.id, frozenset(), self.written(document_id), self.targets(project),
                     only=self.only_new(project))
        if not part or st.empty():
            return
        ws.stretch = st
        ws.in_sentences = self.in_sentences()
        prints = {s.id: ws.sentence_print(doc, s) for s in doc.sentences}
        lines = self.message(ws, project, doc, part, st).splitlines()
        lines.insert(len(lines) - 1, AFTER_TEXT_LINE)
        piece = {'document': document_id, 'first': part[0].id, 'whole': False, 'after_text': True}
        key = analysis_key(canonical(piece))
        job.set(current_document=document_id, message=self.after_text_line(doc.name, [s.index for s in part]))
        self.following = True
        try:
            while True:
                try:
                    note = self.run_piece(ws, project, '\n'.join(lines), document_id, sentences=ws.in_sentences,
                                          text=False)
                    break
                except (JobStopped, Deferred, Gone):
                    raise
                except TurnCancelled:
                    job.check()
                    raise JobStopped('cancelled')
                except StretchFailed as e:
                    self.after_text_failed(document_id, doc, part, piece, e.kind)
                    return
                except Exception as e:  # noqa: BLE001 - sorted as a piece's are
                    if core_job.core_fault(e) is not None:
                        raise
                    if not_answering(e):
                        job.wait_for_model()
                        continue
                    kind = failure_kind(e)
                    if kind is None:
                        raise
                    self.after_text_failed(document_id, doc, part, piece, kind)
                    return
            self.begin_summary(key, document_id, doc.name, part, False, note, self.refused_of(ws, document_id),
                               ended=ws.ended,
                               after_text='added' if self.only_new() is not None else 'edited')
            if ws.answered_nothing:
                # Asked twice, it staged nothing and said nothing: its
                # sentences are skipped with that reason, as any piece's are
                # (REV-DAY-S-16, complexity-5).
                for s in part:
                    self.skip(document_id, doc, s.id, NO_ANSWER, None, cursor=False)
                core_job.through_core(job, lambda: self.end_summary(key))
                return
            # Each step after the model tried again on its own: a passing
            # error never runs the model context again (D21).
            core_job.through_core(job, lambda: self.record_piece(project, piece, note, ws.tables, doc, part))
            core_job.through_core(job, lambda: self.record_refusals(ws, document_id))
            if ws.ops:
                try:
                    self.off_on_trouble(document_id, lambda: self.write(project, document_id, ws, doc, part, prints,
                                                                        list(ws.ops), note, piece_tag(piece),
                                                                        summary=key),
                                        retry=first_request)
                except Deferred as e:
                    # Its note is never shown beside no changes: the piece is
                    # taken again, once, at the start of the walk. Put off by
                    # a person or by core not answering (REV-JR1-7).
                    self.unsummed.pop(key, None)
                    put_off(e.error)
            core_job.through_core(job, lambda: self.end_summary(key))
        finally:
            self.following = False

    def after_text_failed(self, document_id: str, doc, part: List[Sentence], piece: Dict[str, Any],
                          kind: Optional[str]) -> None:
        """A piece after a text edit whose model failed: its sentences
        skipped ``failed`` with the failure's kind, and a row of its own,
        as a stretch's failure is (REV-RPF3-5)."""
        for s in part:
            self.skip(document_id, doc, s.id, 'failed', kind, cursor=False)
        key = analysis_key(canonical(piece))
        self.begin_summary(key, document_id, doc.name, part, False, '', [],
                           after_text='added' if self.only_new() is not None else 'edited')
        self.end_summary(key)

    def after_text_line(self, name: str, indexes: List[int]) -> str:
        """The heartbeat's line for a piece after a text edit, its sentences
        said by :func:`sentences_text` (REV-JR2-1)."""
        return f'{name}: {sentences_text(indexes)}, {self.after_text_label()}.'

    def after_text_label(self) -> str:
        """How the work list names a piece after a text edit: the words the
        job added, for a job that fills only those, else the sentences after
        the edit (RPF3-B)."""
        return 'the words added' if self.only_new() is not None else 'after the text edit'

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
        st = Stretch(doc, project, part, job.id, self.known_words(document_id), self.written(document_id),
                     self.targets(project), only=self.only_new(project))
        whole = self.whole_document(project, doc)
        # People's work as it is when the piece starts (REV-DAY-S-10): one
        # listing of the documents, and a read of those whose version moved
        # (the job's own last write, a person's), never the whole project.
        self.read_people(project)
        if st.empty() and not self.every_sentence():
            # Nothing to do: rows that say so, as a write that sends nothing.
            self.manifest(Write(document_id, '', st, [s.id for s in part], [], Counter(), doc))
            self.record(project, document_id, doc, part, st)
            return None
        ws.stretch = st
        # A piece of a plan in sentences is offered the short list of tools
        # (toolkit.sentences_piece_tools).
        ws.in_sentences = self.in_sentences() and not whole
        ws.whole = whole
        ws.too_long = self.too_long_ids(document_id)
        # Every sentence's print, not only the piece's: an op the model
        # stages anywhere in the document is checked against the sentence
        # as the model read it.
        prints = {s.id: ws.sentence_print(doc, s) for s in doc.sentences}
        message = self.message(ws, project, doc, part, st, whole)
        note = self.run_piece(ws, project, message, document_id, sentences=self.in_sentences() and not whole)
        if whole and ws.answered_nothing:
            # A whole document asked twice that staged and said nothing fails
            # as any whole piece does: its document goes to stretches (REV-RW-6).
            raise StretchFailed(NO_ANSWER, 'no answer')
        piece = {'document': document_id, 'first': part[0].id if part else None, 'whole': whole}
        key = analysis_key(canonical(piece))
        self.begin_summary(key, document_id, doc.name, part, whole, note, self.refused_of(ws, document_id),
                           ended=ws.ended)
        if ws.answered_nothing:
            # Asked twice, it staged nothing and said nothing: its sentences
            # are skipped with a reason of their own, never counted worked.
            for s in part:
                self.skip(document_id, doc, s.id, NO_ANSWER, None)
            self.end_summary(key)
            return None
        # The piece's note and refusals, tried again on their own: a passing
        # error on their row never runs the model context again (D21).
        core_job.through_core(job, lambda: self.record_piece(project, piece, note, ws.tables, doc, part,
                                                             findings=ws.reply if self.fills_nothing() else None))
        core_job.through_core(job, lambda: self.record_refusals(ws, document_id))
        if ws.ended is not None:
            # A piece that ended without finishing writes what it staged; what
            # it did not get to is left out of its write, for the piece's
            # kind to handle after it (:meth:`unfinished`).
            ws.unreached = self.unreached(ws, doc, part, st, whole)
            if whole and ws.unreached:
                # Its row says the rest went to stretches (REV-RW-7).
                self.unsummed[key]['rest'] = [document_id]
            gone = {s.id for s in ws.unreached}
            part = [s for s in part if s.id not in gone]
        # The piece as its writing rows name it: a whole document's is the
        # same whatever sentence it starts from, so the piece run again
        # after an interruption is known as the same.
        tag = piece_tag({'document': document_id, 'whole': True} if whole else
                        {'document': document_id, 'first': piece['first']})
        # What the piece staged outside its document goes with its write and
        # is proposed there, never written: it is not under this document's
        # lock (the rule's ``place``).
        return ws, doc, part, prints, list(ws.ops), note, tag, key

    def run_piece(self, ws: JobWorkspace, project: IgtProject, message: str, folder: str,
                  sentences: bool = False, text: bool = True) -> str:
        """One piece's model context: the job's prompt, the interactive
        assistant's tools (:func:`toolkit.job_piece_tools`), the piece's
        message, the stretch budgets (:class:`Pace`), its rounds to the trace
        folder. Its reply is the piece's note. Raises the model's failures
        for the caller to sort.

        An answer that staged nothing and said nothing (:func:`answered_nothing`,
        by what it holds, never by its words: reasoning only, or empty) is
        asked again once with :data:`JOB_ANSWER_AGAIN`, under the same
        budgets. When the second answer is the same, ``ws.answered_nothing``
        is set, and the caller lists the piece's sentences as skipped
        (``no-answer``, REV-DAY-S-16)."""
        job = self.job
        # A piece after a text edit is offered no text tool (``text``, RPF3-B).
        ws.edits_text = self.edits_text() and text
        ws.fills = self.targets(project)
        # A setup that fills only the words the job adds (RPF-A7).
        ws.only_new = self.only_new(project)
        # A plan that fills nothing ends each piece with its findings (RPF-A5).
        system = build_job_prompt(project, sentences=sentences, edits_text=ws.edits_text, targets=ws.fills,
                                  findings=self.fills_nothing(), evidence=ws.handed_evidence)
        transcript = [{'role': 'user', 'content': message}]
        seed(ws.seen, system, transcript, lambda tool, args: True)
        ws.findings = self.fills_nothing()
        self.steps_now = 0
        kit = Toolkit(tools_for=lambda w: toolkit.job_piece_tools(w, plan_only=w.decide_now),
                      call_tool=self.counting(toolkit.job_piece_call, ' in this part'), tracer=TRACER)
        self.trace(ws, system, kit, folder)

        def decided():
            ws.decide_now = True

        def closing():
            ws.closing = True
        # A budget spent while the piece holds staged work closes it with one
        # call, and what it staged is written (BRIEF RW B2).
        pace = self.pace(decided, piece=True, holds=lambda: bool(ws.ops or ws.tables), closing=closing)
        result = self.repeat_stopped(ws, self.turn(ws, kit, system, transcript, pace=pace))
        job.check()
        if answered_nothing(ws, result.text):
            again = JOB_FINDINGS_ANSWER_AGAIN if ws.findings else JOB_ANSWER_AGAIN
            more = transcript + list(result.messages or []) + [{'role': 'user', 'content': again}]
            result = self.repeat_stopped(ws, self.turn(ws, kit, system, more, pace=pace))
            job.check()
            ws.answered_nothing = answered_nothing(ws, result.text)
        # The whole reply, the findings of a job that fills nothing (RPF-A5),
        # whose note then only says where they are (REV-RPF-P-10).
        ws.reply = str(result.text or '')
        if self.fills_nothing() and findings_text(ws.reply):
            return FINDINGS_NOTE
        return piece_note(result.text)

    @staticmethod
    def repeat_stopped(ws: JobWorkspace, result: TurnResult) -> TurnResult:
        """A piece's turn stopped because the same tool call failed or was
        repeated three times (``TurnResult.repeat_stopped``) is a model
        fault, never finished work (D3): with nothing staged it fails
        ``repeating`` as any model fault does, and with work staged it ends
        without finishing (``ws.ended``), by THE rule after such a piece
        (CONTRACT, "Added by RW"). Its text is the stop's line, never a note."""
        if not result.repeat_stopped:
            return result
        if not (ws.ops or ws.tables):
            raise StretchFailed(REPEATING, 'the same step failed three times')
        ws.ended = REPEATING
        return dataclasses.replace(result, text='')

    def pace(self, decided=lambda: None, line: Optional[str] = None, piece: bool = False,
             holds=lambda: False, closing=lambda: None) -> Pace:
        """The budgets of one stretch, asked only while nobody waits for the
        model (``yield_to_people``). ``line``: its decide-now line, a
        piece's unless given. ``piece``: a piece's, whose first call at its
        output limit is asked again (``Pace.cut``) and whose calls write at
        most ``piece_output_tokens`` each when an operator set it.
        ``holds`` and ``closing``: a piece's closing call (``Pace.close``)."""
        job = self.job

        def before_call():
            job.check()
            job.yield_to_people()
        # A piece of a job that fills nothing ends with its findings (D26).
        findings = piece and self.fills_nothing()
        line = line or (JOB_FINDINGS_DECIDE_NOW if findings else None)
        return Pace(self.cfg.model, before_call=before_call, count=self.count, decided=decided,
                    output_tokens=self.piece_output_tokens if piece else None, asks_again=piece,
                    holds=holds, closing=closing, **({'line': line} if line else {}),
                    **({'used_up': JOB_FINDINGS_STEPS_USED_UP} if findings else {}))

    def counting(self, call_tool, where: str, read=None):
        """``call_tool`` that counts each step (each tool call, as the chat
        counts a turn's steps, ``core.trace.plural``) in ``steps_now``, and
        puts the count on the heartbeat's line after its own words:
        "Sentences 26 to 30 of 41. 3 steps in this part.", "Planning the
        work. 2 steps." Set with :meth:`Job.say`, so the next heartbeat
        carries it and none is sent for it (BRIEF LV, REV-LV-4)."""
        job = self.job
        said = job.line or ''
        if self.counted is not None and said == self.counted[1]:
            said = self.counted[0]

        def call(w, name, args):
            self.steps_now += 1
            # The call being made, which a refusal is weighed by
            # (JobWorkspace.fills_what_follows, REV-RPF3-1).
            w.calling = (name, args)
            if said:
                # ``read``: what the workspace has read so far, said after
                # the line's own words (the planning's, RPF3-E).
                self.counted = (said, f'{said}{read(w) if read else ""} {plural(self.steps_now, "step")}{where}.')
                job.say(self.counted[1])
            # Core's passing trouble is tried again at the call (D21).
            return core_job.tool_through_core(job, w, lambda: call_tool(w, name, args))
        return call

    def turn(self, ws, kit, system: str, transcript, decided=lambda: None, pace: Optional[Pace] = None):
        """One model context of the job, under the stretch's budgets
        (``pace``, a new one unless given: a piece asked again goes on under
        its first answer's)."""
        job = self.job
        pace = pace or self.pace(decided)
        try:
            result = run_turn(self.cfg, kit, ws, system, transcript, cancelled=job.cancelled, pace=pace)
        except StretchFailed:
            if not pace.closed:
                raise
            # The closing call answered with a tool call, and no call may
            # follow it: the piece ends with what it staged (BRIEF RW B2).
            ws.ended = BUDGET
            return TurnResult('', [], [])
        if pace.closed:
            # Whatever the closing call answered, or however it failed, the
            # piece ends with what it staged. Its note is the answer's text,
            # none when the call failed.
            ws.ended = BUDGET
            return dataclasses.replace(result, text='', failure=None) if result.failure is not None else result
        if result.failure is not None and getattr(result.failure, 'cut_at', None) and pace.asks_again \
                and (ws.ops or getattr(ws, 'tables', None)):
            # A piece's second call at its output limit, with work staged:
            # it ends without finishing as a piece whose steps are used up
            # does, and what it staged is written (REV-RW-6).
            ws.ended = OUTPUT
            return dataclasses.replace(result, text='', failure=None)
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
        as read_sentences renders them (the two before each sentence of the
        piece for context, those of a run being the two before it, REV-SF-4:
        a search's matched sentences are no run, or the whole document), what
        is empty in them, how their blank forms were analysed before, the
        job's instructions and the plan's."""
        if whole:
            # Never a sentence too long for a job: nothing is written there (S8-1).
            context, shown = [], [s.index for s in doc.sentences if s.id not in ws.too_long]
        else:
            mine = {s.index for s in part}
            near = {i for s in part for i in range(s.index - JOB_CONTEXT_SENTENCES, s.index)}
            context = [s for s in doc.sentences if s.index in near and s.index not in mine]
            shown = sorted(s.index for s in context + part)
        # Every sentence of the piece, past a read's cap of sentences: a
        # whole document is within JOB_DOCUMENT_PIECE_MAX_TOKENS.
        rendered = ws.render(doc, indexes=shown, max_sentences=len(shown))
        lines = [f'Document "{doc.name}".', '', rendered, '']
        full = []
        # What is empty of what the job fills, by its plan's targets
        # (:mod:`.targets`, THE rule). A plan that fills nothing (a check, a
        # summary) is told nothing is empty and handed no evidence.
        for s in part:
            line = tg.empty_line(s, st.targets, set(st.words), st.fields.get(s.id, ()))
            if line:
                lines.append(line)
            else:
                full.append(f's{s.index}')
        if full and st.targets:
            # A sentence the walk takes with nothing empty (every sentence
            # is walked unless the plan skips filled ones) says so (BRIEF EW).
            lines.append(f'Nothing empty in {", ".join(full)} of what this job fills.')
        hidden = [f's{s.index}' for s in doc.sentences if whole and s.id in ws.too_long]
        if hidden:
            lines.append(f'Too long for a job, not shown, and nothing is written there: {", ".join(hidden)}.')
        if self.only_new(project) is not None:
            lines.append(ONLY_NEW_TEXT_LINE if self.edits_text() and not self.following else ONLY_NEW_LINE)
        # A piece of a plan in sentences is handed the evidence its model
        # would otherwise look up (igt/evidence.py), a document's or a
        # selection's the precedent alone.
        if self.in_sentences() and not whole:
            precedent = self.evidence(ws, project, st)
        else:
            precedent = self.precedent(ws, project, st)
        if precedent:
            lines += ['', precedent]
        # The prompt says the message holds evidence only when it does (D29).
        ws.handed_evidence = bool(precedent)
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
        """The evidence's people's index: form -> {key: {analysis, count}}
        over every word people analysed in the project (``protected``), each
        analysis per value (``people_of(per_value=True)``), as
        :meth:`read_people` last read it, read now when it never was.
        Harmonize decides by ``self.people``, which leaves out a whole word
        the job wrote in place on (REV-KM-3)."""
        if self.people is None:
            self.read_people(project)
        return self.precedent_people

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
            self.people_read[d['id']] = (d.get('version'), self.people_of(doc, self.job.id),
                                         self.values_of(doc, self.job.id),
                                         self.people_of(doc, self.job.id, per_value=True))
        listed_ids = {d['id'] for d in listed}
        index: Dict[str, Dict[str, Any]] = {}
        shown: Dict[str, Dict[str, Any]] = {}
        values: Dict[Tuple[str, str], Dict[str, Dict[str, int]]] = {}
        for did, (_, part, vals, by_value) in self.people_read.items():
            if did not in listed_ids:
                continue
            for into, of in ((index, part), (shown, by_value)):
                for form, keys in of.items():
                    for key, x in keys.items():
                        slot = into.setdefault(form, {}).setdefault(key, {'analysis': x['analysis'], 'count': 0})
                        slot['count'] += x['count']
            for where, forms in vals.items():
                into = values.setdefault(where, {})
                for form, counts in forms.items():
                    for v, n in counts.items():
                        into.setdefault(form, {})
                        into[form][v] = into[form].get(v, 0) + n
        self.people = index
        self.precedent_people = shown
        self.values = values

    @staticmethod
    def people_of(doc, job_id: Optional[str] = None, per_value: bool = False) -> Dict[str, Dict[str, Any]]:
        """One document's part of the index: form -> {key: {analysis,
        count}} over its words people analysed (``protected``), but a word on
        whose morphemes someone else made the job ``job_id`` wrote a value or
        a link in place (``in_place_of_job``, REV-KM-3, REV-KM2-1): harmonize
        never takes the job's proposal for people's. ``per_value`` (the
        evidence's): such a word counts too, its analysis as people wrote it,
        the values and links the job wrote left out (:func:`people_analysis`),
        so a value the job adds never takes people's form and gloss out of
        their precedent (REV-DAY-S-13)."""
        part: Dict[str, Dict[str, Any]] = {}
        for s in doc.sentences:
            for w in s.words:
                if word_state(w) != 'protected' or (not per_value and in_place_of_job(w, job_id)):
                    continue
                a = people_analysis(w, job_id) if per_value else word_analysis(w)
                slot = part.setdefault(surface_key(w.surface), {}).setdefault(analysis_key(canonical(a)),
                                                                           {'analysis': a, 'count': 0})
                slot['count'] += 1
        return part

    @staticmethod
    def values_of(doc, job_id: Optional[str] = None) -> Dict[Tuple[str, str], Dict[str, Dict[str, int]]]:
        """One document's part of the field values index: ``(field name,
        'people' or 'job') -> form -> {value: count}``, every word and
        morpheme field value by its own provenance (per value): a person's or
        a confirmed one is people's, an unverified one this job wrote is the
        job's, another producer's is neither. A word value is keyed by the
        word's surface, a morpheme value by the morpheme's form, each by
        ``fit.surface_key``."""
        out: Dict[Tuple[str, str], Dict[str, Dict[str, int]]] = {}

        def add(name, sp, form):
            if sp.value in (None, ''):
                return
            who = 'job' if job_piece(sp.metadata, job_id) else 'people' if prov_state(sp.metadata) != 'machine' \
                else None
            if who is None:
                return
            counts = out.setdefault((name, who), {}).setdefault(surface_key(form), {})
            counts[_nfc(sp.value)] = counts.get(_nfc(sp.value), 0) + 1
        for s in doc.sentences:
            for w in s.words:
                for name, sp in w.fields.items():
                    add(name, sp, w.surface)
                for m in w.morphemes:
                    for name, sp in m.fields.items():
                        add(name, sp, w.surface if m.virtual else m.form)
        return out

    def entry_forms(self, ws: Workspace, project: IgtProject) -> Dict[str, str]:
        """Entry id to the address a tool names it by (``gam#2``, a sense
        ``kwatha#1.2``), as the evidence block's entry lines name it, so a
        linked analysis and the entries beside it agree (REV-DAY-P-19)."""
        out = {}
        for v in project.vocabs:
            try:
                view = ws.view(v)
                for it in view.items:
                    if it.get('id'):
                        out[it['id']] = view.address(it['id']) or it['id']
            except PlaidAPIError:
                continue
        return out

    def in_sentences(self) -> bool:
        """Whether the job's plan cuts the work in sentences (the default
        plan does)."""
        return (self.plan_made or {}).get('pieces', SENTENCES) == SENTENCES

    def fills_nothing(self) -> bool:
        """Whether the job's plan fills nothing (``fills`` empty): a check, a
        list, a summary, whose pieces' last replies are its findings
        (RPF-A5)."""
        if self.plan_made is None:
            self.plan_made = self.plan_stored(self.job.decisions())
        plan = self.plan_made or {}
        return plan.get('by') != NO_PLAN and not plan.get('fills')

    def only_new(self, project: Optional[IgtProject] = None) -> Optional[Tuple[set, set]]:
        """For a job set up to fill only the words it adds (the setup's
        ``onlynew``, RPF-A7, read as :func:`targets.readable` reads a setup):
        the ids of the words and sentences its text edits added so far
        (:meth:`added`). None for any other job."""
        setup = getattr(self.job, 'setup', None)
        if not (tg.readable(setup) and setup.get('onlynew') is True):
            return None
        return self.added()

    def added(self) -> Tuple[set, set]:
        """The ids of the words and sentences the job's text edits added, as
        its rows hold them (:meth:`record_added`), read once per worker."""
        if self.added_ids is None:
            words, sentences = set(), set()
            for r in self.rows_of(ADDED_FORM):
                v = r['value'] if isinstance(r['value'], dict) else {}
                words |= set(v.get('words') or ())
                sentences |= set(v.get('sentences') or ())
            self.added_ids = (words, sentences)
        return self.added_ids

    def record_added(self, document_id: str, before, after) -> None:
        """Keep the words and sentences a write added, by id: those ``after``
        (the document read under the lock after the write) holds and
        ``before`` (read under the lock before it) did not. Under the lock
        nobody but the starter's own browser writes besides the job. In rows
        of their own, as many as their ids need (RPF-A7)."""
        had_w = {w.id for s in before.sentences for w in s.words}
        had_s = {s.id for s in before.sentences}
        words = sorted(w.id for s in after.sentences for w in s.words if w.id not in had_w)
        sentences = sorted(s.id for s in after.sentences if s.id not in had_s)
        rows, chunk = [], {'words': [], 'sentences': []}

        def flush():
            if chunk['words'] or chunk['sentences']:
                text = canonical({'document': document_id, **chunk})
                rows.append({'form': ADDED_FORM + document_id, 'key': analysis_key(text), 'analysis': text,
                             'count': 1, 'document_id': document_id, 'sentence_id': None})
        for k, ids in (('words', words), ('sentences', sentences)):
            for i in ids:
                chunk[k].append(i)
                if len(canonical({'document': document_id, **chunk})) > JOB_ANALYSIS_MAX_CHARS - 100:
                    flush()
                    chunk = {'words': [], 'sentences': []}
        flush()
        if rows:
            self.job.add_decisions(rows)
        held = self.added()
        held[0].update(words)
        held[1].update(sentences)

    def record_respelled(self, document_id: str, before, after) -> None:
        """Keep each word a write respelled and left its analysis on (RPF3-B):
        a word of the same id in ``before`` and ``after`` (both read under
        the lock), whose letters changed, holding stored morphemes. Core
        keeps a respelled word's morpheme tokens and their forms as they
        were, for a person's edit in the editor too (one rule for every
        token layer, plaid_text_edit_token_rules): the forms still spell the
        old word, which the report lists for a person to check. Nothing is
        re-segmented."""
        had = {w.id: w for s in before.sentences for w in s.words}
        rows = []
        for s in after.sentences:
            for w in s.words:
                old = had.get(w.id)
                stored = [m for m in w.morphemes if not m.virtual]
                if old is None or old.surface == w.surface or not stored:
                    continue
                text = canonical({'document': document_id, 'sentence_id': s.id, 'sentence': f's{s.index}',
                                  'ref': f's{s.index}.w{w.index}', 'form': w.surface, 'old': old.surface,
                                  'morphemes': [m.form for m in stored]})
                rows.append({'form': RESPELLED_FORM + w.id, 'key': analysis_key(text), 'analysis': text, 'count': 1,
                             'document_id': document_id, 'sentence_id': s.id})
        if rows:
            self.job.add_decisions(rows)

    def edits_text(self) -> bool:
        """Whether the job's plan says its instructions ask for the text to
        change (plan_work's ``edits_text``). The
        plan kept in core is read when this worker has not read it yet."""
        if self.plan_made is None:
            self.plan_made = self.plan_stored(self.job.decisions())
        return (self.plan_made or {}).get('edits_text') is True

    def evidence(self, ws: Workspace, project: IgtProject, st: Stretch, budget: int = JOB_EVIDENCE_CHARS,
                 lexicon: bool = True, nowhere: bool = True) -> str:
        """The evidence block of a piece (:func:`evidence.block`), for what
        the job fills (the stretch's targets), read now: a word empty for
        segmentation by how its form was analysed (people's analyses as the
        walk last read them, the job's own decisions), any other empty unit
        of a word or morpheme field by the values that field holds on other
        units of the same form (people's and the job's, per value), the
        lexicon entries spelled inside them where a target is linked to the
        lexicon. A sentence field has no form, and no evidence. No target,
        no block. Every form is looked up by its surface and by its surface
        trimmed, each by ``fit.surface_key`` (REV-DAY-P-1)."""
        fill = st.targets
        words = list(st.words.values())
        if not fill or not words:
            return ''
        seg = [w for w in words if any(t.id == tg.SEGMENTATION for t in fill) and tg.empty(tg.SEGMENTED, w=w)]
        unsegmented = {w.id for w in seg}
        gloss_field = project.gloss_field('Morpheme')
        people = self.people_index(ws, project)
        fields = []
        for t in tg.word_level(fill):
            if t.field is None:
                continue
            # A word the job also segments is shown by its analyses, which
            # render the gloss: the gloss field leaves it out, any other
            # field shows its values too (REV-DF-D-13).
            skip = unsegmented if gloss_field is not None and t.id == gloss_field.layer_id else set()
            if t.scope == 'Word':
                surfaces = [w.surface for w in words if w.id not in skip and tg.empty(t, w=w)]
                level = 'word'
            else:
                surfaces = [w.surface if m.virtual else m.form for w in words if w.id not in skip
                            for m in w.morphemes if tg.empty(t, m=m)]
                level = 'morpheme'
            if surfaces:
                fields.append(evidence.FieldEvidence(t.name, level, surfaces, self.values.get((t.name, 'people'), {}),
                                                     self.values.get((t.name, 'job'), {}), t.lexicon))
        surfaces = [w.surface for w in seg]
        mine: Dict[str, List[Dict[str, Any]]] = {}
        if surfaces:
            keys = list(dict.fromkeys(k for x in surfaces for k in (
                surface_key(x), surface_key(trim_ignored_edges(x, project.ignored_cfg)))))
            for row in self.job.lookup_decisions(keys):
                mine.setdefault(row.get('form'), []).append({**row, 'analysis': json.loads(row['analysis'])})
        if not surfaces and not fields:
            return ''
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        entries = self.entry_forms(ws, project)
        return evidence.block(ws, project, surfaces, people, mine, lambda a: rendering(a, gloss, entries),
                              budget=budget, lexicon=lexicon and any(t.lexicon for t in fill), fields=fields,
                              nowhere=nowhere)

    def precedent(self, ws: Workspace, project: IgtProject, st: Stretch) -> str:
        """The precedent of a document's or a selection's piece: the
        evidence block (one code path, one key) within JOB_PRECEDENT_CHARS,
        without the forms filled nowhere and the entries, which such a piece
        reads with its tools (REV-DAY-P-16)."""
        return self.evidence(ws, project, st, budget=JOB_PRECEDENT_CHARS, lexicon=False, nowhere=False)

    def targets(self, project: IgtProject) -> List[Target]:
        """What the job fills, as its plan names it (``fills``, kept as
        target ids, :mod:`.targets`): none when the plan names nothing. The
        plan kept in core is read when this worker has not read it yet."""
        if self.plan_made is None:
            self.plan_made = self.plan_stored(self.job.decisions())
        return tg.of_ids(project, (self.plan_made or {}).get('fills'))

    # --- the write (SPEC 5.4) --------------------------------------------------------
    def writing_rows(self, document_id: str) -> List[Dict[str, Any]]:
        """The job's writing rows of a document (:meth:`manifest`), each its
        analysis with its sentence id (the document's id for a row of the
        changes of no sentence), those of sentences gone since included.
        Every row of the job is read once per worker (``GET
        /jobs/{id}/decisions``): no other worker writes rows while this one
        holds the job, and this one keeps its own as it writes them."""
        if self.rows is None:
            rows: Dict[str, List[Dict[str, Any]]] = {}
            for r in self.job.decisions():
                form = r.get('form') or ''
                if form.startswith(WRITING_FORM):
                    rows.setdefault(r.get('first_document'), []).append(
                        {**json.loads(r['analysis']), 'sentence': form[len(WRITING_FORM):]})
            self.rows = rows
        return self.rows.setdefault(document_id, [])

    @staticmethod
    def key_of(row: Dict[str, Any]) -> str:
        """The Idempotency-Key of the request a writing row's try sends
        there: ``<seed>.<n>``, the first unless the row says (``req``)."""
        return f"{row['try']}.{row.get('req') or 0}"

    def view(self, document_id: str):
        """The document's writing rows that count, and whether each landed,
        as this worker knows it: ``(rows, landed(row))``. A try another
        replaced (``of``: cut in two, written again without what went since,
        or not sent at all) counts for nothing. A try's row landed when core
        has its key (:meth:`look_up`), the follow-up of a text edit also when
        the edit called for none (``none``). A write's own rows (``try``
        empty) landed when every try of the write did."""
        rows = self.writing_rows(document_id)
        replaced = {r['of'] for r in rows if r.get('of')}
        rows = [r for r in rows if not (r['try'] and r['try'] in replaced)]
        none = {self.key_of(r) for r in rows if r.get('none')}

        def key_landed(r):
            return self.key_of(r) in self.landed or self.key_of(r) in none
        cut = {r['write'] for r in rows if r['try'] and not key_landed(r)}

        def landed(r):
            return key_landed(r) if r['try'] else r['write'] not in cut
        return rows, landed

    def look_up(self, seeds) -> None:
        """Ask core which requests of the tries ``seeds`` landed (``POST
        /jobs/{id}/landed``): every key ``<seed>.<n>`` it holds. Exact and
        for good for a write core audits, for a day for one it does not (a
        comment): core answers from its audit log and from the answers it
        keeps of keyed writes."""
        seeds = sorted(set(seeds))
        for i in range(0, len(seeds), JOB_DECISIONS_PER_CALL):
            part = seeds[i:i + JOB_DECISIONS_PER_CALL]
            self.landed |= set(self.job.landed(part))
            self.looked |= set(part)

    def wrote_here(self, document_id: str) -> bool:
        """Whether a request of the job's writes in the document landed,
        core asked first about those of unknown fate (REV-SJ2-2)."""
        unknown = self.unknown(document_id)
        if unknown:
            self.look_up(unknown)
        rows, landed = self.view(document_id)
        return any(r['try'] and landed(r) for r in rows)

    def unknown(self, document_id: str) -> List[str]:
        """The tries of a document's writing rows this worker does not know
        the fate of."""
        return sorted({r['try'] for r in self.writing_rows(document_id) if r['try'] and r['try'] not in self.looked})

    def finished(self, document_id: str) -> set:
        """The sentences a landed write of their own piece wrote in, or
        recorded with nothing to write, as one of its own sentences: never a
        target again. A write in a sentence not of its piece (another
        piece's, through a project-wide tool) closes nothing: the
        sentence's own piece still works it (BRIEF NW)."""
        rows, landed = self.view(document_id)
        return {r['sentence'] for r in rows if not r.get('loose') and r.get('own') and landed(r)}

    def unsettled(self, document_id: str) -> bool:
        """Whether this worker may not write in the document before it
        settles it (:meth:`settle`): it has not read the job's writing rows
        yet, or one of the document's tries is of unknown fate (an answer
        lost, a crash, a write put off)."""
        return self.rows is None or document_id not in self.settled or bool(self.unknown(document_id))

    def gate(self, project: IgtProject, document_id: str, client=None) -> None:
        """THE GATE every write of the job in a document passes first (a
        stretch, a document piece, a selection piece, harmonize): when the
        document is :meth:`unsettled`, it is read and :meth:`settle` asks
        core what landed. So no write starts where the job does not know
        what it wrote. A walk settles before each stretch, so on that path
        this reads nothing."""
        if not self.unsettled(document_id):
            return
        self.settle(project, document_id, self.read(project, document_id, client or self.job.client()))

    def settle(self, project: IgtProject, document_id: str, doc) -> None:
        """Before a document's pieces: core is asked which of the
        document's tries of unknown fate landed (:meth:`look_up`), and what
        follows is knowledge, never read from the document (SPEC 3.8, BRIEF
        RX): a sentence with a landed row is written (its counts are its
        rows'), and every other change of a write cut short is a target
        again or listed (:meth:`unwritten`, in the report). The changes a
        write that landed any of its tries proposed are kept. The row's
        counts are written whole from the rows."""
        job = self.job
        unknown = self.unknown(document_id)
        if unknown:
            self.look_up(unknown)
        if unknown or document_id not in self.settled:
            # The changes a landed write proposed (kept once: a write whose
            # record was cut short by an error keeps them here).
            rows, landed = self.view(document_id)
            wrote = {r['write'] for r in rows if r['try'] and landed(r)}
            self.record_changes([c for r in rows if r.get('loose') and not r['try'] and r['write'] in wrote
                                 for c in r.get('proposed') or []])
            job.update_row(document_id, **self.tally(document_id, (job.rows.get(document_id) or {}).get('skipped')))
            self.settled.add(document_id)

    def unwritten(self, document_id: str) -> Tuple[List[Dict[str, Any]], int]:
        """THE RULE after a write cut short (a lost answer, a crash, a
        refusal), applied to each change of each of the write's tries that
        did not land: it is a TARGET AGAIN, when no try of the write landed
        in its sentence and that sentence is one of the write's own (or, for
        a change of no sentence of the piece, when nothing of the write
        landed and it has own sentences): the piece is taken again over that
        sentence and the model asked again. Every other such change is
        LISTED here, as the report's proposed changes do (``reason``
        INTERRUPTED), never sent again, unless a write of the job that
        landed made the same change (the piece taken again staged it again).
        So every change of every write is exactly one of: landed and
        counted, a target again, or listed.
        ``(changes, how many more the rows could not hold)``."""
        rows, landed = self.view(document_id)
        writes: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            writes.setdefault(r['write'], []).append(r)
        # A change another write of the job made (the piece taken again
        # staged it again) is written, never listed.
        made = {canonical(c) for r in rows if r['try'] and landed(r) for c in r.get('ops') or []}
        out, more = [], 0
        for wrows in writes.values():
            tries = [r for r in wrows if r['try']]
            if all(landed(r) for r in tries):
                continue
            some = any(landed(r) for r in tries)
            own = any(r.get('own') for r in wrows)
            landed_in = {r['sentence'] for r in tries if landed(r) and not r.get('loose')}
            for r in tries:
                if landed(r):
                    continue
                if r.get('loose'):
                    again = not some and own
                else:
                    again = r['sentence'] not in landed_in and (r.get('own') or (not some and own))
                if again:
                    continue
                out += [{**c, 'reason': INTERRUPTED} for c in r.get('ops') or [] if canonical(c) not in made]
                more += r.get('more') or 0
        return out, more

    def too_long_ids(self, document_id: str) -> set:
        """The sentences of a document the checks skipped as too long for a
        job: listed on its row, or counted past the list (S8-1)."""
        row = self.job.rows.get(document_id) or {}
        return {s.get('sentence_id') for s in row.get('skipped') or [] if s.get('reason') == 'too-long'} | (
            self.too_long.get(document_id) or set())

    def got_to(self, document_id: str) -> bool:
        """Whether the job's skips of sentences too long for it stand in a
        document at the end: the walk ended it done, and a plan limited by a
        search matched something there. Elsewhere (not reached, in use, put
        off, gone, or nothing matched) the job never got to them, and their
        blanks are not reached (S8-2)."""
        row = self.job.rows.get(document_id) or {}
        return row.get('state') == 'done' and not no_match(row)

    def excluded(self, document_id: str) -> set:
        """The sentences of a document no piece works: skipped, or written
        (:meth:`finished`)."""
        row = self.job.rows.get(document_id) or {}
        out = {s.get('sentence_id') for s in row.get('skipped') or []}
        out |= self.finished(document_id)
        out |= (self.unlisted.get(document_id) or set()) | (self.too_long.get(document_id) or set())
        return out

    def known_words(self, document_id: str, piece: Optional[str] = None) -> frozenset:
        """The tags of every word of every sentence a landed write of the job
        wrote in as one of its piece's own (its writing rows,
        :meth:`finished`), wherever a person has since moved them. A
        sentence holding any of them is not a target (:func:`wrote_in`,
        REV-B4-1). With ``piece``, every sentence that piece's landed writes
        wrote in, its own or not: the same piece taken up again leaves them
        out (``repeated``), and another piece's write there is not its own."""
        out: set = set()
        rows, landed = self.view(document_id)
        for r in rows:
            if r.get('loose') or not landed(r):
                continue
            if r['piece'] == piece if piece is not None else r.get('own'):
                out |= set(r.get('words') or ()) | set(r.get('others') or ())
        return frozenset(out)

    def wrote_in_sentences(self, document_id: str) -> Tuple[set, frozenset]:
        """The sentences a landed try of the job wrote something in, by id
        and by the tags of their words (a split or a merge may move them),
        as Left blank lists them (RPF-A9): a write's own rows of sentences
        it wrote nothing in are not among them."""
        rows, landed = self.view(document_id)
        ids, tags = set(), set()
        for r in rows:
            if r.get('loose') or not r['try'] or not landed(r) or not (r.get('counts') or {}).get('changes'):
                continue
            ids.add(r['sentence'])
            tags |= set(r.get('words') or ()) | set(r.get('others') or ())
        return ids, frozenset(tags)

    def written(self, document_id: str) -> Written:
        """What any landed write of the job wrote in the document
        (:class:`Written`), its own sentences or not: the words its rows
        name as analysed and the sentences whose translation it wrote."""
        rows, landed = self.view(document_id)
        words, translations = set(), set()
        for r in rows:
            if r.get('loose') or not landed(r):
                continue
            words |= set(r.get('words') or ())
            counts = r.get('counts') or {}
            if counts.get('translations') or counts.get('refreshed'):
                translations.add(r['sentence'])
        return Written(words, translations)

    def write(self, project: IgtProject, document_id: str, ws: JobWorkspace, doc, part: List[Sentence],
              prints: Dict[str, str], ops: List[Dict[str, Any]], note: str = '', piece: str = '',
              selection: bool = False, summary: Optional[str] = None) -> bool:
        """THE write of every piece of the job in one document, whatever the
        plan cut (a stretch, a whole document, the whole selection): through
        :meth:`gate` first, then under the document's lock by the apply rule
        (SPEC 5.4), sent as tries of one request each (:meth:`send`), then
        its record (:meth:`record`) and the changes it proposes
        (:meth:`record_changes`). ``doc`` is the document as the piece read
        it, ``part`` the piece's sentences in it, ``piece`` its tag
        (:func:`piece_tag`), ``selection`` whether it is a selection's write
        (:meth:`entries_that_fit`), ``summary`` the key of the piece whose
        summary counts it (:meth:`begin_summary`).

        Safe to do again after a failure anywhere in it: the gate asks core
        what landed, and the same piece leaves out what it staged in a
        sentence its own landed write wrote in. True when the write landed,
        False when it was refused and its sentences skipped."""
        job = self.job
        self.gate(project, document_id)
        ops = self.entries_that_fit(project, ops, selection)
        # A sentence THIS piece's landed write wrote in (by id, or a word of
        # it wherever a split or a merge moved it: the piece taken up again
        # after a lost answer, a crash, a write put off) is not written in
        # again, nor is a selection's change of no document a landed try
        # wrote: what the piece staged there is left out, and counted
        # (``repeated``). What a later piece stages in a sentence an earlier
        # one wrote in is written as any change (REV-JH-1).
        known = self.known_words(document_id, piece)
        rows, landed = self.view(document_id)
        mine = {r['sentence'] for r in rows if not r.get('loose') and r['piece'] == piece and landed(r)}
        again = {s.id for s in doc.sentences if s.id in mine or wrote_in(s, known)}
        done = self.loose_done()
        from .jobapply import sentence_of
        kept = [o for o in ops if getattr(sentence_of(o, doc), 'id', None) not in again
                and (o.get(LOOSE) is None or o[LOOSE] not in done)]
        repeated, ops = len(ops) - len(kept), kept
        # A word or a translation any landed write of the job wrote, in any
        # sentence, that reads blank now: a person undid it, and the job
        # never writes it again (REV-JG-1, REV-LNW-1). Counted as changed
        # during the job.
        written = self.written(document_id)
        kept = [o for o in ops if not written.undone(o, doc, project, job.id)]
        undone, ops = len(ops) - len(kept), kept
        out = self.excluded(document_id)
        part = [s for s in part if s.id not in out]
        st = Stretch(doc, project, part, job.id, self.known_words(document_id), self.written(document_id),
                     self.targets(project), only=self.only_new(project))
        row = job.rows.get(document_id) or {}
        group = row.get('gloss_group')
        if not group:
            group = uuid7()
            job.update_row(document_id, gloss_group=group)
        for tries in range(2):
            client = job.client()
            held = None
            lock = self.hold(client, document_id)
            try:
                try:
                    if self.someone_since_mark(client, document_id):
                        # Someone wrote after the piece's look (REV-HFA-1,
                        # -2): nothing is sent, the document is put off.
                        raise Deferred(document_id)
                    try:
                        held = self.write_held(project, document_id, client, ws, st, prints, ops, group, piece,
                                               repeated, undone, summary)
                        w, changed, after, vouched, proposed, put_off = held
                    except BaseException:
                        # Tries of it may have landed: the document is
                        # settled again from what core holds (D4).
                        self.settled.discard(document_id)
                        raise
                finally:
                    lock.__exit__(None, None, None)
            except DocumentLockLost as e:
                # The lock lapsed as the write ended (REV-J-B3 B3-4): put off
                # as any lock conflict, what landed known when it comes back.
                # A write that had returned records what it did to the text
                # first, and is settled again (REV-JR1-4).
                if held is None:
                    raise Deferred(document_id) from e
                put_off = Deferred(document_id)
                put_off.__cause__ = e
            except PlanError as e:
                wrote = getattr(e, 'wrote_any', True)
                # The starter's own browser wrote between the read under the
                # lock and the write (strict mode): taken again at once when
                # nothing of it landed. When a try of it had landed, the
                # document is put off, and the gate asks core what landed
                # when it comes back.
                if _status(e) == 409 and tries == 0 and not wrote:
                    continue
                if _gone_now(e) and not wrote and part:
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
                        return False
                # A conflict, something the write names gone in the moment
                # since the check, or a lock lost in the write (a 423): put
                # off, and the next walk reads what is there (REV-J-B3 B3-3,
                # B3-4).
                if _status(e) in (409, 423) or _gone_now(e):
                    raise Deferred(document_id) from e
                raise
            break
        # The write landed: what the rule did not apply is recorded as the
        # piece's proposed changes, never before (REV-J-B2 S4). A call core
        # fails here leaves the document to be settled again, which keeps
        # them from the write's rows (REV-JG3-2).
        # Each record tried again on its own after core's passing trouble,
        # never the write (D4). A write put off after tries of it landed
        # records what they did to the text, and is settled again from
        # what core holds when the walk comes back.
        try:
            if any(jobapply.edits_text(o) for o in w.ops):
                # The words it added, by id, for every job: an onlynew one
                # fills only those (RPF-A7), and the report tells them from
                # words a person brought in (REV-SJ2-R2-2).
                core_job.through_core(job, lambda: self.record_added(document_id, w.fresh, after))
                core_job.through_core(job, lambda: self.record_respelled(document_id, w.fresh, after))
                if not self.following:
                    # The sentences whose text or words this write changed,
                    # by id in the document it left (a sentence a split made
                    # is new): taken once more after it (:meth:`after_text`,
                    # RPF3-B). Its words too: split_word changes no text and
                    # adds a word (REV-RPF3B-4).
                    def shape(x):
                        return x.text, tuple(w.id for w in x.words)
                    had = {s.id: shape(s) for s in w.fresh.sentences}
                    self.text_edited.setdefault(document_id, set()).update(
                        s.id for s in after.sentences if had.get(s.id) != shape(s))
            if put_off is not None:
                self.settled.discard(document_id)
                raise put_off
            core_job.through_core(job, lambda: self.record_changes(proposed, note))
            # Not tried again on its own: it counts sentences changed during
            # the piece as it goes. A call core fails here leaves the
            # document to be settled again from what core holds.
            self.record(project, document_id, after, part, st, changed, vouched,
                        self.made_entries(ws, after, st, w.ops))
        except BaseException as e:
            self.settled.discard(document_id)
            # The write landed: never made again from its gate with the
            # piece's old prints, which would read the job's own landed
            # sentences as changed (REV-JR1-3, ``first_request``).
            if not hasattr(e, 'wrote_any'):
                e.wrote_any = True
            raise
        return True

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
                   prints: Dict[str, str], ops: List[Dict[str, Any]], group: str, piece: str = '',
                   repeated: int = 0, undone: int = 0, summary: Optional[str] = None):
        """The write, the lock held: the piece's ops checked again against
        the document as it is (:meth:`recheck`), sent (:meth:`send`), and
        the document read again BEFORE the lock goes. ``(the write, changed
        sentences, the document after, the words vouched for, the proposed
        changes)``.

        The words vouched for are those the job knows it wrote exactly as
        they now read (REV-J-B3 B3-1, B3-2): targets still blank as the lock
        was taken, in a document whose version is still the one the job's
        own last write left (strict mode moves the client's version with
        each of the job's writes, and under the lock only the starter's own
        browser could write besides). Any other write since, and none is
        vouched for: harmonize leaves them."""
        job = self.job
        # Read by the ignored-token rule as the project holds it now: a word
        # it hides since the piece read the document is not in this read, so
        # its sentence reads as changed and nothing is written there (S5-4).
        fresh = self.read(self.ignored_now(client, project), document_id, client)
        kept, counts, changed, proposed = self.recheck(ws, project, fresh, st, prints, ops)
        counts['repeated'] += repeated
        counts['changed'] += undone
        blank = {w.id for s in fresh.sentences if s.id in st.sentence_ids and s.id not in changed
                 for w in s.words if w.id in st.words and tg.empty_in_word(w, st.targets)}
        self.machine_status(project, kept)
        own = [s.id for s in st.doc.sentences if s.id in st.sentence_ids and s.id not in changed]
        setup = self.job_setup(project)
        w = Write(document_id, piece, st, own, kept, counts, fresh, proposed,
                  describe=lambda o, here: self.describe(o, fresh, project) if here else self.describe_loose(o),
                  within=setup.ids if setup is not None else None)
        if summary in self.unsummed:
            # Before the first request: a write cut short is counted by what of it landed.
            self.unsummed[summary]['writes'].add(w.id)
        put_off = None
        try:
            self.send(client, project, document_id, group, w)
        except BaseException as e:
            # Raised in send's own handlers too (a try too big, one out of
            # date): whether a try of it landed (REV-JR1-3).
            if not hasattr(e, 'wrote_any'):
                e.wrote_any = bool(w.done)
            # A try of it may have landed (an earlier one did, or the failing
            # one's answer was lost, its first or only one included), and it
            # failed whatever way: what landed is recorded, by the document
            # before and after under this lock, which records nothing when
            # nothing landed, then the failure goes up (D4, REV-JR1-4,
            # REV-JR1-R2-3). One :meth:`write` puts off (out of date, a 409, a
            # 423, something gone, the lock lost) goes up as the put-off.
            if not e.wrote_any or not isinstance(e, Exception):
                raise
            if isinstance(e, Deferred) or _lock_lost(e) \
                    or (isinstance(e, PlanError) and (_status(e) in (409, 423) or _gone_now(e))):
                put_off = e if isinstance(e, Deferred) else Deferred(document_id)
                put_off.__cause__ = put_off.__cause__ or e
            else:
                put_off = e
        known = client.document_versions.get(document_id)
        # Read again as any read is while core is busy: a landed write's
        # records need it (D4). Trouble that outlasts the tries leaves the
        # write as one that landed.
        try:
            after = core_job.through_core(job, lambda: self.read(project, document_id, client))
        except BaseException as e:
            e.wrote_any = True
            raise
        exact = known is not None and str(after.version) == str(known)
        if not exact:
            logger.info('Job %s: %s moved during the write (version %s, read %s): its words are not vouched for',
                        job.id, document_id, known, after.version)
        return w, changed, after, frozenset(blank) if exact else frozenset(), proposed, put_off

    def send(self, client, project: IgtProject, document_id: str, group: str, w: Write) -> None:
        """Send a write as TRIES (:meth:`Write.cut`), each one request, in
        the executor's own order and under a seed of its own, its MANIFEST in
        core first (:meth:`manifest`). A try that does not fit one request,
        or that the executor would send as two, is cut in two before
        anything of it is sent (``TooBig``, ``NeedsTwo``), and the halves'
        rows replace its own. One change that alone needs more is listed as
        a proposed change, never sent. Raises what a try raised, with
        ``wrote_any``: whether anything of the write may have landed."""
        queue = [{'seed': uuid7(), 'ops': ops} for ops in w.cut()]
        self.manifest(w, queue)
        refit = False
        while queue:
            t = queue.pop(0)
            seed, ops = t['seed'], t['ops']
            if refit and any(o.get('kind') == 'create_entry' for o in ops):
                # A try after one that landed: an entry an earlier try made
                # is linked, never made again.
                ops = self.entries_that_fit(project, ops, True)
            try:
                try:
                    self.apply(client, project, document_id, group, ops, seed, w)
                except (PlanError, PlanOutOfDate) as e:
                    dels = refused_for_links(e, ops)
                    if not dels:
                        raise
                    # Core counts links of the entry the job's token cannot
                    # read (another project's), and nothing of the try was
                    # written: never deleted by the job. One such delete is
                    # listed once, not applied, several are tried one by
                    # one, and the rest of the try is written (S9-2).
                    # A delete goes with the repairs it carries (another
                    # entry's reference cleared, a sense freed), which stand
                    # only if it goes: never one without it (REV-SJ2-1).
                    self.looked.add(seed)

                    def carried(d):
                        return [o for o in ops if o.get(REPAIR_OF) == d.get('item_id')]
                    gone = {d.get('item_id') for d in dels}
                    others = [o for o in ops if not any(o is d for d in dels) and o.get(REPAIR_OF) not in gone]
                    new = ([{'seed': uuid7(), 'ops': others}] if others else []) + (
                        [{'seed': uuid7(), 'ops': [d, *carried(d)]} for d in dels] if len(dels) > 1 else [])
                    if len(dels) == 1:
                        # Its name cut, never the reason, and no count of
                        # links removed beside a delete that was not done
                        # (REV-SJ2-8).
                        why = ': not deleted, the entry is linked where the job cannot read'
                        name = _cut(dels[0].get('name') or 'an entry', JOB_CHANGE_VALUE_CHARS - len(why) - 13)
                        self.record_changes([{**self.describe_loose(dels[0]), 'label': f'Delete entry {name}{why}'}])
                    self.keep_rows(w, [r for n in new for r in w.rows(n['seed'], n['ops'], replaces=seed)]
                                   or [w.marker(seed)])
                    queue[0:0] = new
                    continue
            except TooBig:
                # Nothing of it was sent.
                self.looked.add(seed)
                halves = w.halve(ops)
                if halves is None:
                    # One change that alone needs more than one request:
                    # listed for a person, never sent in part.
                    self.record_changes([w.describe(o, w.sentence_of(o) is not None) for o in ops
                                         if id(o) not in w.again])
                    self.keep_rows(w, [w.marker(seed)])
                    continue
                new = [{'seed': uuid7(), 'ops': h} for h in halves]
                self.keep_rows(w, [r for n in new for r in w.rows(n['seed'], n['ops'], replaces=seed)])
                queue[0:0] = new
                continue
            except PlanOutOfDate as e:
                self.looked.add(seed)
                rest, drops = self.without_gone(client, project, ops, e) if not t.get('again') else (None, None)
                if rest is None:
                    raise Deferred(document_id) from e
                # Nothing of the try was sent: written again without what is
                # gone since, under a seed of its own, its rows replacing its
                # own and counting what was dropped.
                if rest:
                    n = {'seed': uuid7(), 'ops': rest, 'again': True}
                    self.keep_rows(w, w.rows(n['seed'], rest, replaces=seed, drops=drops))
                    queue.insert(0, n)
                else:
                    self.keep_rows(w, [(w.document_id, {**w.marker(seed)[1], 'counts': dict(drops)})])
                continue
            except BaseException as e:
                e.wrote_any = bool(w.done) or (isinstance(e, PlanError) and e.wrote)
                raise
            w.done.add(seed)
            self.looked.add(seed)
            self.landed |= {self.key_of(r) for r in self.writing_rows(document_id) if r['try'] == seed}
            refit = True

    def manifest(self, w: Write, queue=()) -> None:
        """A write's MANIFEST, in core before its first request: the rows of
        every try of ``queue`` (``{seed, ops}``, :meth:`Write.rows`) and the
        write's own (:meth:`Write.own_rows`). A write with nothing to send
        has its own rows alone, which say so."""
        rows = [r for t in queue for r in w.rows(t['seed'], t['ops'])]
        self.keep_rows(w, rows + w.own_rows([t['ops'] for t in queue]))
        for t in queue:
            places = {o[LOOSE] for o in t['ops'] if o.get(LOOSE) is not None}
            if places:
                self.try_loose[t['seed']] = places

    def keep_rows(self, w: Write, rows: List[Tuple[str, Dict[str, Any]]]) -> None:
        """Writing rows to core, JOB_DECISIONS_PER_CALL a call, and kept by
        this worker as written."""
        decisions = []
        for sid, row in rows:
            text = writing_text(row)
            decisions.append({'form': writing_form(sid), 'key': analysis_key(text), 'analysis': text, 'count': 1,
                              'document_id': w.document_id, 'sentence_id': None if row.get('loose') else sid})
        for i in range(0, len(decisions), JOB_DECISIONS_PER_CALL):
            self.job.add_decisions(decisions[i:i + JOB_DECISIONS_PER_CALL])
        self.writing_rows(w.document_id).extend({**json.loads(d['analysis']), 'sentence': sid}
                                                for d, (sid, _) in zip(decisions, rows))

    def sending(self, w: Write, seed: str) -> None:
        """A try's request is about to go out (``ONE_REQUEST``): its rows are
        in core already (:meth:`manifest`)."""

    def loose_done(self) -> set:
        """The places among a selection's changes of no document of those a
        landed try of this worker wrote (``LOOSE``)."""
        return {i for seed, places in self.try_loose.items() if f'{seed}.0' in self.landed for i in places}

    def loose_landed(self) -> set:
        """:meth:`loose_done`, once core has said which of this worker's
        tries holding such changes landed (a write put off after a lost
        answer leaves one of unknown fate)."""
        unknown = [s for s in self.try_loose if s not in self.looked]
        if unknown:
            self.look_up(unknown)
        return self.loose_done()

    def apply(self, client, project: IgtProject, document_id: str, group: str, kept: List[Dict[str, Any]],
              seed: str, w: Write) -> None:
        """Write ``kept`` as one try (one request, ``ONE_REQUEST``, a text
        edit two at most) of the document's glossing entry, under ``seed``.
        A text edit that called for no follow-up says so in a row of its
        own, so its follow-up's row is never read as one not written."""
        label = job_label(self.job.instructions)
        setattr(client, ONE_REQUEST, lambda: self.sending(w, seed))
        try:
            # ``every``: a comment, alone in the try too, takes the try's
            # key, so core knows the request by it (REV-RX-4).
            with client.operation(label, kind='job', ref=self.gloss_ref(document_id), group_id=group,
                                  keys={'seed': seed, 'stamps': {}, 'every': True}):
                try:
                    execute_plan(client, kept, source=self.source, label=label, project=project,
                                 stamp_mode='machine', detail=self.detail, seed=seed)
                except (PlanError, PlanOutOfDate, TooBig):
                    raise
                except Exception as e:  # noqa: BLE001 - raised before the first write
                    # The plan's reads (offsets, scopes, entries) come
                    # before its request, and once it sends nothing
                    # leaves it but a PlanError or PlanOutOfDate
                    # (``applying``). So nothing was sent (REV-B4-6).
                    raise PlanError(str(e), 0, len(kept)) from e
        finally:
            setattr(client, ONE_REQUEST, None)
        edit = next((o for o in kept if o.get('kind') == 'edit_text'), None)
        if edit is not None and f'{seed}.1' not in self.job.landed([seed]):
            # The edit landed, and core holds no follow-up of it: it called
            # for none.
            self.keep_rows(w, [w.follow_up(seed, edit, none=True)])

    def without_gone(self, client, project: IgtProject, kept: List[Dict[str, Any]], e: PlanOutOfDate):
        """A try refused out of date before anything was sent, written again
        without what is gone since: a link to an entry gone since the model
        read it (deleted, merged away, its lexicon taken out of the project)
        is dropped as ``changed`` (SPEC 12, REV-J-B3 B3-3), the plan's own
        check asked again of each link and entry alone, and an entry staged
        only for links dropped so is not created. ``(rest, drops)``, or
        ``(None, None)`` when none of its ops is out of date alone: the
        document is put off. Core out of reach while checking is core's
        trouble: it goes up, the walk is tried again."""
        if core_job.plaid_error(e) is not None:
            raise e
        gone = {id(o) for o in kept if o.get('kind') in ('link', 'create_entry') and out_of_date(client, project, o)}
        if not gone:
            return None, None
        logger.info('Job %s: links or entries out of date are dropped: %s', self.job.id, e)
        unmade = {o.get('key') for o in kept if id(o) in gone and o.get('kind') == 'create_entry'}
        rest = [o for o in kept if id(o) not in gone
                and not (o.get('kind') == 'link' and o.get('new_entry_key') in unmade)]
        left = {id(o) for o in rest}
        drops = Counter({'changed': sum(1 for o in kept if o.get('kind') == 'link' and id(o) not in left)})
        # An entry made only for links that are now dropped is not made.
        wanted = {o.get('new_entry_key') for o in kept if o.get('kind') == 'link'}
        linked = {o.get('new_entry_key') for o in rest if o.get('kind') == 'link'}
        return [o for o in rest if o.get('kind') != 'create_entry' or o.get('key') in linked
                or o.get('key') not in wanted], drops

    def recheck(self, ws: JobWorkspace, project: IgtProject, fresh, st: Stretch, prints: Dict[str, str],
                ops: List[Dict[str, Any]]):
        """The ops to write to ``fresh`` (the document under the lock), and
        those recorded as proposed changes: an op whose sentence changed
        since the piece read it is dropped as ``changed`` (the piece is taken
        again), and the rest go to THE apply rule
        (:func:`plaid_agent.igt.jobapply.decide`), which applies every change
        in the document and the lexicons and proposes project setup.
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
        only = self.only_new(project)
        refused = []
        for op in ops:
            s = jobapply.sentence_of(op, st.doc) if st.doc is not None else None
            if s is not None and s.id in changed:
                counts['changed'] += 1
                # A sentence whose staged change a person's edit dropped is
                # taken again, though the piece was never shown it (a
                # whole-selection piece writes by reference): SF round 2.
                self.retake.setdefault(st.doc.id, set()).add(s.id)
                continue
            # A job set up to fill only the words it adds: the rule holds
            # here too, whatever path staged the op (RPF-INT 4). Listed as
            # refused, never written.
            out = not_added(op, only, [fresh, *ws._docs.values()])
            if out is not None:
                ws.leave_it(not_added_text(op), out[0], code=NOT_ADDED)
                refused.append({'sentence_id': out[0], 'what': not_added_text(op), 'code': NOT_ADDED})
                continue
            # Nor outside the piece's own sentences, whatever path staged it
            # (RP3-2): the workspace's stretch, none for a selection's.
            out = outside_piece(op, ws.stretch, [fresh, *ws._docs.values()]) if only is not None else None
            if out is not None:
                ws.leave_it(outside_piece_text(op), out[0], code=OUTSIDE)
                refused.append({'sentence_id': out[0], 'what': outside_piece_text(op), 'code': OUTSIDE})
                continue
            # Nor in a sentence the checks skipped as too long (S8-1).
            out = in_too_long(op, self.too_long_ids(fresh.id), [fresh])
            if out is not None:
                ws.leave_it(too_long_text(op), out, code=TOO_LONG)
                refused.append({'sentence_id': out, 'what': too_long_text(op), 'code': TOO_LONG})
                continue
            live.append(op)
        if refused:
            self.record_refusals(ws, fresh.id, refused)
        # Asked of core once in this write, when an op needs it (S9-1).
        maintains: Dict[str, bool] = {}

        def maintainer() -> bool:
            if 'v' not in maintains:
                maintains['v'] = self.starter_maintains(ws, project)
            return maintains['v']
        rule = jobapply.Rule(fresh, project, maintainer=maintainer, edits_text=self.edits_text())

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

    def starter_maintains(self, ws: JobWorkspace, project: IgtProject) -> bool:
        """Whether the person who started the job may rename, merge or
        delete the entries of the project's own lexicons: a maintainer of the
        project or an administrator, as core decides it for the job's token.
        Asked of core at each write that holds such a change, its roles read
        afresh, so a starter made a writer during the job has such a change
        proposed from the next write on, never sent for core to refuse
        (S9-1)."""
        starter = self.job.starter
        raw = ws.client.projects.get(project.id) or {}
        roles = {k: list(raw.get(k) or []) for k in ('maintainers', 'writers', 'readers')}
        return project_role(roles, starter) == LEXICON_MAINTAINER or Requester(ws.client, starter).is_admin()

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
        from .jobapply import sentence_of
        hit = _found(doc, token_of(op))
        ref = field = before = after = None
        if hit is not None:
            s, w, m = hit
            ref = f's{s.index}' + (f'.w{w.index}' if w is not None else '') + (
                f'.m{m.index}' if m is not None and not m.virtual else '')
        elif sentence_of(op, doc) is not None:
            ref = f's{sentence_of(op, doc).index}'
        gloss = getattr(project.gloss_field('Morpheme'), 'name', None)
        planned = op.get('planned_word')
        if planned is not None and hit is not None:
            # A word of a retyped sentence, by its number once retyped.
            ref = f's{hit[0].index}.w{planned.get("index")}'
            if planned.get('word_id') is None:
                hit = None
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
        elif kind in ('edit_text', 'delete_sentence', 'respell'):
            before, after = op.get('old'), op.get('new') if kind != 'respell' else op.get('value')
        what = (op.get('label') or kind or '')
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
        the cap a change is only counted, a row of its own keyed the same
        way and counted once however often it is sent (a call made again
        after its answer was lost, the change proposed again: REV-JR1-11),
        and the report says how many."""
        if not changes:
            return
        if self.changes is None:
            self.changes = {r.get('key') for r in self.job.decisions()
                            if str(r.get('form') or '').startswith(CHANGE_FORM)}
        rows, dropped, keys = [], set(), []
        for c in changes:
            text = self.change_text(c, note)
            key = analysis_key(canonical(c))
            if key in self.changes or key in keys:
                continue
            if len(self.changes) + len(keys) >= JOB_CHANGES_MAX:
                dropped.add(key)
                continue
            keys.append(key)
            rows.append({'form': CHANGE_FORM + key, 'key': key, 'analysis': text, 'count': 1,
                         'document_id': c.get('document_id'), 'sentence_id': None})
        rows += [{'form': DROPPED_FORM, 'key': key, 'analysis': '{}', 'count': 1, 'document_id': None,
                  'sentence_id': None} for key in sorted(dropped)]
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
                     part=(), findings: Optional[str] = None) -> None:
        """Keep a piece's note and the tables its code made among the job's
        decisions, keyed by the piece (its document and first sentence), so a
        piece done again after a put-off write keeps its first note, and,
        for a job that fills nothing, its whole reply, its findings
        (``findings``, :func:`findings_rows`, RPF-A5)."""
        key = analysis_key(canonical(piece))
        where = None
        if doc is not None and part and self.searched() is not None and not piece.get('after_text'):
            # The sentences a search matched are no run (SF).
            where = ', '.join(f's{s.index}' for s in part)
        elif doc is not None and part:
            where = f's{part[0].index}' + (f' to s{part[-1].index}' if len(part) > 1 else '')
        rows = []
        text = findings_text(findings) if findings else ''
        if text and key in self.unsummed:
            # Shown on the piece's own row of the work list (REV-RPF2-4).
            self.unsummed[key]['findings'] = text
        if text:
            rows += findings_rows(key, {'document': piece.get('document'),
                                        'name': doc.name if doc is not None else None,
                                        'sentences': None if piece.get('whole') else where}, text)
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

    def record_refusals(self, ws: JobWorkspace, document_id: Optional[str],
                        entries: Optional[List[Dict[str, Any]]] = None) -> None:
        """Keep what the piece's refusals left (``ws.left_by_refusal``, or
        ``entries`` of the same shape) among the job's decisions, each once,
        by the document holding its sentence (the piece's, when it names
        none), so the report lists it (``refused``, REV-DAY-SURFACE point 2)."""
        rows = []
        for r in self.refused_of(ws, document_id, entries):
            text = canonical(r)
            key = analysis_key(text)
            rows.append({'form': REFUSED_FORM + key, 'key': key, 'analysis': text, 'count': 1,
                         'document_id': r['document'], 'sentence_id': None})
        if rows:
            self.job.add_decisions(rows)

    @staticmethod
    def refused_of(ws: JobWorkspace, document_id: Optional[str],
                   entries: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
        """What the piece's refusals left (``entries``, else
        ``ws.left_by_refusal``), each ``{document, sentence_id, sentence,
        what, code}``, by the document holding its sentence (the piece's,
        when it names none)."""
        out = []
        for e in (ws.left_by_refusal if entries is None else entries):
            d, where = document_id, None
            for doc in ws._docs.values():
                s = doc.find(e['sentence_id']) if e.get('sentence_id') else None
                if s is not None and s[0] is not None:
                    d, where = doc.id, f's{s[0].index}'
                    break
            out.append({'document': d, 'sentence_id': e.get('sentence_id'), 'sentence': where,
                        'what': _cut(e['what'], JOB_CHANGE_VALUE_CHARS), 'code': e.get('code')})
        return out

    # --- what each piece did, for the job page (CONTRACT, added by LV) ----------------

    def now_iso(self) -> str:
        return datetime.fromtimestamp(self.job.now(), timezone.utc).isoformat(timespec='seconds') \
            .replace('+00:00', 'Z')

    @staticmethod
    def summary_row(seq: int, value: Dict[str, Any], document_id: Optional[str] = None,
                    sentence_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """The decision row of the plan's summary (``seq`` 0) or a piece's,
        or None when it cannot be cut to core's cap (:func:`summary_text`)."""
        text = summary_text(value)
        if text is None:
            return None
        return {'form': PIECE_FORM, 'key': f'{seq:0{PIECE_SEQ_DIGITS}d}', 'analysis': text,
                'count': 1, 'document_id': document_id, 'sentence_id': sentence_id}

    def summaries_known(self) -> None:
        """Read once per worker which pieces core holds a summary of, and
        the highest sequence number: a resumed job numbers on from it, and
        never sums up again a piece an earlier worker summed up."""
        if self.summarized is not None:
            return
        found, seq = set(), 0
        for r in self.job.lookup_decisions([PIECE_FORM]):
            try:
                seq = max(seq, int(r.get('key') or 0))
                key = json.loads(r['analysis']).get('piece')
            except (ValueError, TypeError, KeyError, AttributeError):
                continue
            if key:
                found.add(key)
        self.summarized, self.piece_seq = found, max(self.piece_seq, seq)

    def begin_summary(self, key: str, document_id: Optional[str], name: Optional[str], part: List[Sentence],
                      whole: bool, note: str, refused: List[Dict[str, Any]],
                      after_text: Optional[str] = None, ended: Optional[str] = None,
                      failed: Optional[str] = None) -> None:
        """A piece whose model context has ended, summed up once what it
        wrote is known (:meth:`end_summary`). The same piece taken up again
        (after a write put off, a document gone for a while) keeps the
        writes of its earlier run and adds its model calls, and its note and
        refusals are the last run's. ``ended``: what ended it without
        finishing (``budget``, its steps used up, or ``output``, a second call
        at its output limit, REV-RW-6). ``failed``: the failure's kind of a whole-document or
        selection piece whose documents then went to stretches (B1)."""
        earlier = self.unsummed.get(key) or {}
        ranged = bool(part) and not whole
        self.unsummed[key] = {
            'document': document_id, 'name': name, 'whole': whole,
            'first': f's{part[0].index}' if ranged else None, 'last': f's{part[-1].index}' if ranged else None,
            'first_id': part[0].id if ranged else None,
            # A stretch of a plan limited by a search names its sentences,
            # which are not a run (SF).
            **({'matching': [f's{s.index}' for s in part]}
               if ranged and not after_text and self.searched() is not None else {}),
            # Any other part whose sentences are no run names them (D12), at
            # most SENTENCES_LISTED, the rest counted (REV-JR2-2).
            **({'sentences': [f's{s.index}' for s in part[:SENTENCES_LISTED]],
                **({'sentences_more': len(part) - SENTENCES_LISTED} if len(part) > SENTENCES_LISTED else {})}
               if ranged and (after_text or self.searched() is None) and not is_run([s.index for s in part])
               else {}),
            'parts': {**(earlier.get('parts') or {}), **({document_id: {s.id for s in part}} if document_id else {})},
            'writes': set(earlier.get('writes') or ()), 'seq': earlier.get('seq'),
            'note': note, 'refused': refused, 'steps': (earlier.get('steps') or 0) + self.steps_now,
            # A piece after a text edit (RPF3-B): ``added`` under onlynew,
            # else ``edited``, which the work list words.
            **({'after_text': after_text} if after_text else {}),
            **({'ended': ended} if ended else {}), **({'failed': failed} if failed else {})}

    def end_summary(self, key: str) -> None:
        """Keep the summary of piece ``key`` among the job's decisions, once
        (a piece core already holds one of is not summed up again): what
        LANDED of its own writes, by the writing rows' rules (:meth:`view`,
        the fate of any try not known asked of core first), never what a try
        meant to write, its skipped sentences, its refusals, its note, its
        model calls and when it ended. Its sequence number is given once, so
        a call sent again is the same row. Only a piece an earlier worker
        summed up is skipped: a piece this worker summed up and takes again
        (a person changed its first sentence while the model worked) is a
        new run with writes of its own, and gets a row of its own with the
        next number (REV-LV-1)."""
        p = self.unsummed.get(key)
        if p is None:
            return
        try:
            self.keep_summary(key, p)
        except Exception as e:  # noqa: BLE001 - a summary never fails the job (REV-LV-2)
            if core_job.core_fault(e) in ('passing', 'mine', 'access'):
                raise
            logger.warning('Job %s: the summary of a piece was not kept: %s', self.job.id, e)
            self.unsummed.pop(key, None)

    def keep_summary(self, key: str, p: Dict[str, Any]) -> None:
        self.summaries_known()
        if key in self.summarized:
            self.unsummed.pop(key, None)
            return
        # The selection is one piece of the job, whatever worker ran it: its
        # row says everything its writes landed, an earlier worker's too (a
        # crash before that worker's summary), so a selection run again never
        # reads "Nothing written." beside what it wrote (REV-LV-3). A worker
        # that finds a selection summary in core sums up none (the guard).
        selection = p['document'] is None
        docs = list(self.job.order) if selection else list(p['parts'])
        unknown = [t for d in docs for t in self.unknown(d)]
        if unknown:
            self.look_up(unknown)
        rows = []
        for d in docs:
            mine, landed = self.view(d)
            rows += [r for r in mine if landed(r) and (r.get('piece') == SELECTION_TAG if selection
                                                       else r.get('write') in p['writes'])]
        skipped = [{**s, 'document_id': d} for d, ids in p['parts'].items()
                   for s in (self.job.rows.get(d) or {}).get('skipped') or [] if s.get('sentence_id') in ids]
        if p['seq'] is None:
            self.piece_seq += 1
            p['seq'] = self.piece_seq
        value = {'piece': key, **{k: p[k] for k in ('document', 'name', 'first', 'last', 'first_id', 'whole',
                                                    'note', 'steps')},
                 **written_sums(rows), 'ended_at': self.now_iso(),
                 **({'skipped': skipped} if skipped else {}), **({'refused': p['refused']} if p['refused'] else {}),
                 **({'findings': p['findings']} if p.get('findings') else {}),
                 **({'after_text': p['after_text']} if p.get('after_text') else {}),
                 **({'ended': p['ended']} if p.get('ended') else {}),
                 # How many documents its rest went to stretches in, and the
                 # first of them by id, which the page counts among (REV-RW-R2-6).
                 **({'rest': len(p['rest']), 'rest_documents': list(p['rest'])[:REST_LISTED]} if p.get('rest')
                    else {}),
                 **({'failed': p['failed']} if p.get('failed') else {}),
                 **({'matching': p['matching']} if p.get('matching') else {}),
                 **({'sentences': p['sentences']} if p.get('sentences') else {}),
                 **({'sentences_more': p['sentences_more']} if p.get('sentences_more') else {})}
        row = self.summary_row(p['seq'], value, p['document'], p['first_id'])
        if row is None:
            logger.warning('Job %s: the summary of a piece is too large to keep', self.job.id)
        else:
            self.job.add_decisions([row])
        self.unsummed.pop(key, None)

    def end_summaries(self) -> None:
        """Sum up every piece not summed up yet: one whose write was put off
        and never taken again, or whose document went."""
        for key in list(self.unsummed):
            self.end_summary(key)

    def failed_piece(self, document_id: str, doc, sentence_id: str, kind: Optional[str]) -> None:
        """A stretch of one sentence whose model work failed: skipped, and
        summed up as a piece that wrote nothing."""
        self.skip(document_id, doc, sentence_id, 'failed', kind)
        s = next((x for x in doc.sentences if x.id == sentence_id), None)
        key = analysis_key(canonical({'document': document_id, 'first': sentence_id, 'whole': False}))
        self.begin_summary(key, document_id, doc.name, [s] if s is not None else [], False, '', [])
        self.end_summary(key)

    def failed_whole(self, document_id: Optional[str], name: Optional[str], part: List[Sentence],
                     kind: Optional[str], rest: List[str] = ()) -> None:
        """A whole-document piece (``document_id``) or the selection's (None)
        whose model failed: summed up as a piece that wrote nothing, with its
        failure's kind, and ``rest``, how many documents went to stretches
        after it (none under a plan that fills nothing, BRIEF RW B5)."""
        piece = ({'document': document_id, 'first': part[0].id if part else None, 'whole': True} if document_id
                 else {'document': None, 'first': None, 'whole': True})
        key = analysis_key(canonical(piece))
        self.begin_summary(key, document_id, name, part if document_id else [], True, '', [],
                           failed=kind or BUDGET)
        if rest:
            self.unsummed[key]['rest'] = list(rest)
        self.end_summary(key)

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
        """The entries this stretch created that its target words now link
        to, those not in the lexicon as the stretch read it, which their
        decisions mark as made (the count of entries created is the creates
        the write applied, :meth:`record`). A create is staged only after
        its lexicon was read (``fit_guard``). No read of
        the lexicon is made for it (REV-J-B S3-10)."""
        if not any(o.get('kind') == 'create_entry' for o in ops):
            return frozenset()
        known = {it['id'] for items in ws._lexicons.values() for it in items}
        linked = {m.link.item_id for s in doc.sentences for w in s.words if w.id in st.words
                  for m in w.morphemes if m.link is not None}
        return frozenset(linked - known)

    # --- the record of a write (SPEC 3.8, 7.3) -----------------------------------------

    def record(self, project: IgtProject, document_id: str, doc, part: List[Sentence], st: Stretch,
               changed=frozenset(), vouched=frozenset(), made: frozenset = frozenset()) -> None:
        """After a piece's write landed: the cursor, a sentence changed
        since the piece read it taken again once and then skipped, what the
        job wrote on each word it vouches for (``vouched``, ids, as ``doc``
        reads them: :meth:`write_held`), stored once (:meth:`commit`), and
        the row's counts, written whole from the writing rows
        (:meth:`tally`)."""
        job = self.job
        row = job.rows.get(document_id) or {}
        now = {s.id: s for s in doc.sentences}
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
                if len(skipped) < JOB_SKIPPED_PER_DOCUMENT:
                    skipped.append({'sentence': f's{s.index}', 'sentence_id': s.id, 'reason': 'changed',
                                    'kind': None})
                else:
                    # Past core's cap of the list: counted, as :meth:`skip`
                    # counts (complexity-6).
                    self.unlisted.setdefault(document_id, set()).add(s.id)
                if not retry:
                    last = s.id
                continue
            if not retry:
                last = s.id
            if s.id in now and vouched:
                r = self.vouched_record(document_id, now[s.id], vouched, made)
                if r is not None:
                    records.append(r)
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
        hold = self.hold_cursor.get(document_id)
        if hold is not None:
            # A piece that ended without finishing left sentences to the walk
            # (:meth:`go_on`): the cursor stays before the first of them.
            ids = [x.id for x in doc.sentences]
            if hold in ids:
                before = ids[ids.index(hold) - 1] if ids.index(hold) > 0 else None
                cur = fields.get('last_sentence', row.get('last_sentence'))
                if cur in ids and (before is None or ids.index(cur) > ids.index(before)):
                    fields['last_sentence'] = before
        if len(skipped) != len(row.get('skipped') or []):
            fields['skipped'] = skipped
        self.commit(document_id, records)
        job.update_row(document_id, **fields, **self.tally(document_id, fields.get('skipped', row.get('skipped'))))

    def vouched_record(self, document_id: str, s: Sentence, vouched, made: frozenset = frozenset()):
        """What the job wrote on each word of ``s`` it vouches for (``vouched``,
        ids) and that is wholly its own: each one's key (``words``, which
        harmonize compares the word with) and their decisions (the precedent
        of later pieces), or None when there is none. A word written and not
        vouched for is counted (its writing row) and nothing more: harmonize
        leaves it, and no piece learns from it."""
        decisions: Dict[Tuple[str, str], Dict[str, Any]] = {}
        keys: Dict[str, str] = {}
        for w in s.words:
            if w.id not in vouched or not job_owned(w, self.job.id):
                continue
            keys[word_tag(w.id)] = word_key(w)
            text = canonical(word_analysis(w, made))
            if len(text) > JOB_ANALYSIS_MAX_CHARS:
                # Core keeps no analysis this long: the word is not offered
                # as a decision.
                continue
            key = (surface_key(w.surface), analysis_key(text))
            slot = decisions.setdefault(key, {'form': key[0], 'key': key[1], 'analysis': text, 'count': 0,
                                              'document_id': document_id, 'sentence_id': s.id})
            slot['count'] += 1
        return {'sentence': s.id, 'words': keys, 'decisions': list(decisions.values())} if keys else None

    def commit(self, document_id: str, records: List[Dict[str, Any]]) -> None:
        """Store what the job vouches for in each sentence once: its
        decisions in one call with a MARK of their own, a decision row whose
        form is ``RECORD_FORM`` and the sentence id (a form with a space,
        which no word has) and whose analysis holds the words' keys. Before
        a call the marks are asked again, so a call that landed before an
        error is never sent twice."""
        if not records:
            return
        there = self.marks([r['sentence'] for r in records])
        batch: List[Dict[str, Any]] = []
        for r in records:
            if r['sentence'] in there:
                continue
            text = mark_text(document_id, r['words'])
            group = r['decisions'] + [{'form': mark_form(r['sentence']), 'key': analysis_key(text),
                                       'analysis': text, 'count': 1, 'document_id': document_id,
                                       'sentence_id': r['sentence']}]
            if len(batch) + len(group) > JOB_DECISIONS_PER_CALL:
                self.job.add_decisions(batch)
                batch = []
            batch += group
        if batch:
            self.job.add_decisions(batch)

    def tally(self, document_id: str, skipped) -> Dict[str, Any]:
        """A row's counts and ``done``, from the document's writing rows
        whose tries landed (what they wrote, each once) and its skipped
        sentences: ``analyzed`` counts each sentence written in once,
        ``words`` each word analysed once, ``done`` each sentence finished
        once (written, or skipped). ``targets`` grows
        with a sentence that became a target after the checks, so done never
        passes it. Nothing of what is left blank: the report counts it from
        the document (:meth:`left_blank`), and a row never says nothing is
        left where nothing was counted (BRIEF NW round 3)."""
        rows, landed = self.view(document_id)
        sums = written_sums([r for r in rows if landed(r)])
        counts = {**empty_counts(), **sums['counts']}
        if sums.get('fields'):
            counts['fields'] = sums['fields']
        if sums.get('outside'):
            # What it wrote outside its setup, the translation's too (REV-SU-B-4).
            counts['outside'] = sums['outside']
        if sums.get('changes_parts'):
            # Its changes by kind, summing to ``changes`` (RPF-A3).
            counts['changes_parts'] = sums['changes_parts']
        row = self.job.rows.get(document_id) or {}
        ran_out = self.ran_out.get(document_id) or (row.get('counts') or {}).get(RAN_OUT)
        if ran_out == 'written' and not self.wrote_here(document_id):
            # Never "written" before core holds the write (REV-SJ2-2): a
            # write still to come, or one whose answer was lost.
            ran_out = None
        if ran_out:
            counts[RAN_OUT] = ran_out
        if (row.get('counts') or {}).get(UNANSWERED) is True:
            # Kept as the row says it (REV-JR2-3).
            counts[UNANSWERED] = True
        if document_id in self.one_stepped or (row.get('counts') or {}).get(ONE_STEP) is True:
            # Ended in the whole-selection piece's one step.
            counts[ONE_STEP] = True
            if self.one_stepped.get(document_id) or (row.get('counts') or {}).get(NOT_ALL_READ) is True:
                counts[NOT_ALL_READ] = True
        searched = self.searched()
        if searched is not None:
            # How many of its sentences the plan's search matched (SF).
            counts[MATCHED] = len(searched.get(document_id, ()))
        failed = len(self.unlisted.get(document_id) or ())
        more = max((row.get('counts') or {}).get(SKIPPED_MORE) or 0, failed)
        if more:
            counts[SKIPPED_MORE] = more
        too_long = max((row.get('counts') or {}).get(TOO_LONG_MORE) or 0, len(self.too_long.get(document_id) or ()))
        if too_long:
            # Never a target, so never in done (D11).
            counts[TOO_LONG_MORE] = too_long
        # A sentence too long for a stretch was never a target (the checks
        # leave it out of ``targets``), so it is not counted done.
        done = len(self.finished(document_id)
                   | {s.get('sentence_id') for s in skipped or [] if s.get('reason') != 'too-long'}) + failed
        out = {'counts': counts, 'done': done}
        if done > (row.get('targets') or 0):
            out['targets'] = done
        return out

    def marks(self, sentence_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        """The record core holds of each sentence of ``sentence_ids`` that
        has one, as :func:`mark_text` wrote it."""
        out: Dict[str, Dict[str, Any]] = {}
        for r in self.job.lookup_decisions([mark_form(sid) for sid in sentence_ids]):
            form = r.get('form') or ''
            if form.startswith(RECORD_FORM):
                out[form[len(RECORD_FORM):]] = json.loads(r['analysis'])
        return out

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
                    # A word left whose analysis holds nothing of the job's
                    # (only word fields) is not the job's to list (RPF-A1).
                    # Nor is one a person only verified (W-9): no inconsistency
                    # for that alone.
                    if why in (NOT_THE_JOBS, VERIFIED) or (why is not None and not analysis_holds_jobs(w, job.id)):
                        continue
                    into = mine if why is None else held.setdefault(why, {})
                    full = word_analysis(w)
                    a = harmonized_part(full)
                    slot = into.setdefault(surface_key(w.surface), {}).setdefault(
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
                left.append({'form': form, 'reason': LEFT_BY_RULE.get(by, by),
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
        changed under the lock, ``harmonize_bar``'s reason or ``changed``
        for a word gone or no longer the job's, or ``refused`` by staging). Nothing when the
        document is gone (its row says so), None when it stayed in use."""
        job = self.job
        # A look, then JOB_DEFER_ROUNDS waits for people, as the walk waits.
        for attempt in range(JOB_DEFER_ROUNDS + 1):
            if attempt:
                self.wait_for_people([document_id])
            client = job.client()
            if self.in_use(self.newest_change(client, document_id), self.own_ref):
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
                    # Harmonize asks the job's own rule too (REV-RPF-W-1).
                    ws.only_new = self.only_new(project)
                    doc = self.read(project, document_id, client)
                    ws._docs[document_id] = doc
                    doc = ws.doc(document_id)
                    commented = self.commented(client, project, document_id)
                    for wid, to in words:
                        hit = doc.find(wid)
                        why = harmonize_bar(hit[1], job.id, recorded, commented) \
                            if hit and hit[1] is not None else CHANGED
                        if why is None:
                            refusal = self.stage(ws, doc, hit[0], hit[1], to)
                            if refusal is not None:
                                logger.warning('Job %s: harmonize\'s rewrite of %s in %s was refused: %s', job.id, wid,
                                               document_id, refusal)
                                why = REFUSED
                        if why is None:
                            staged.add(wid)
                        else:
                            held[wid] = CHANGED if why == NOT_THE_JOBS else why
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
        # Every morpheme field the word holds is named, '' where ``to`` has
        # none, so the analysis set is ``to``'s whole (set_analysis compares
        # only what a call names).
        held = sorted({n for m in w.morphemes for n, sp in m.fields.items() if sp.value not in (None, '')})
        calls = [('set_analysis', {'document': name, 'ref': ref, 'morphemes': [
            {'form': m['form'], **({'type': m['type']} if m.get('type') else {}), 'equals': bool(m.get('equals')),
             'fields': {**{n: '' for n in held}, **dict(m.get('fields') or {})}} for m in to['morphemes']]})]
        calls += [('link_entry', {'document': name, 'refs': [f'{ref}.m{i}'], 'entry_id': m['entry']})
                  for i, m in enumerate(to['morphemes'], start=1) if m.get('entry')]
        # A morpheme the analysis keeps keeps its link (tools.in_place), and
        # the first one keeps it when the chain is replaced: one ``to`` links
        # to no entry is unlinked.
        bare = [f'{ref}.m{i}' for i, m in enumerate(to['morphemes'], start=1) if not m.get('entry')]
        if bare and any(m.link is not None for m in w.morphemes if not m.virtual):
            calls.append(('unlink_entry', {'document': name, 'refs': bare}))
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
        them those nothing links (``unlinked``). The job runs no cleanup of
        its own: an entry of the job with no links is left as it is, listed
        for a person to delete from the Entries screen's machine drafts or in
        a conversation about the job, and a job whose instructions say to
        delete such entries does it through its plan. Reads only, so a
        stopped job reports its entries the same way."""
        project = self.project()
        ws = Workspace(job.client(), project)
        created, unlinked = [], []
        for v in project.vocabs:
            if v.get('borrowed'):
                continue
            gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
            items = ws.lexicon(v)
            from .fit import form_key
            # The forms of the entries not this job's, by the one key a form
            # finds an entry by: an entry the job made beside one of them is
            # said so (RPF3 round 4, RP3-4: a second entry nidr read as the
            # fix of the first).
            others = {form_key(it.get('form')) for it in items
                      if _job_of(it.get('metadata') or {}) != job.id}
            for it in items:
                md = it.get('metadata') or {}
                if _job_of(md) != job.id:
                    continue
                entry = {'id': it['id'], 'lexicon': v['id'], 'form': it.get('form'),
                         'gloss': md.get(gloss) if gloss else None,
                         **({'beside_existing': True} if form_key(it.get('form')) in others else {})}
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

    def refusals(self, job) -> Dict[Optional[str], List[Dict[str, Any]]]:
        """What refusals the job could not follow left, by document
        (:meth:`record_refusals`), each ``{sentence, sentence_id, what}``, in
        the order kept. Empty when the decisions cannot be read."""
        try:
            rows = core_job.through_core(job, job.decisions)
        except Exception as e:  # noqa: BLE001 - a report without them rather than none
            logger.warning('Job %s: what its refusals left could not be read for the report: %s', job.id, e)
            return {}
        out: Dict[Optional[str], List[Dict[str, Any]]] = {}
        for r in rows:
            if not str(r.get('form') or '').startswith(REFUSED_FORM):
                continue
            try:
                v = json.loads(r['analysis'])
            except (ValueError, TypeError, KeyError):
                continue
            out.setdefault(v.get('document'), []).append(
                {'sentence': v.get('sentence'), 'sentence_id': v.get('sentence_id'), 'what': v.get('what'),
                 'code': v.get('code')})
        return out

    def document_reports(self, job) -> List[Dict[str, Any]]:
        out = []
        blank = self.left_blank(job)
        refused = self.refusals(job)
        rows = [job.rows.get(d) or {} for d in job.order]
        # "Left blank" lists what is empty of what the plan fills (its
        # targets, :meth:`left_blank`): nothing for a plan that fills
        # nothing. ``counts.blank`` counts it per target.
        for d, row in zip(job.order, rows):
            state = row.get('state')
            counts = row.get('counts') or empty_counts()
            done, targets = row.get('done'), row.get('targets')
            if self.ended and (self.rows or {}).get(d):
                # Counted again from the rows, as core now says what landed
                # (:meth:`known_at_end`).
                tally = self.tally(d, row.get('skipped'))
                counts, done, targets = {**counts, **tally['counts']}, tally['done'], tally.get('targets', targets)
            # What is blank in the sentences the job worked, read from the
            # document at the end (BRIEF NW), cut as every report list is,
            # and per target of the plan (``blank``: ``{target, unit, left,
            # not_reached}``, the whole list counted). The places of the
            # sentences it did not reach are counted apart, never listed.
            # ``left`` and ``not_reached`` count the words among them, for a
            # plan that fills something at word or morpheme level. A
            # document that could not be read has none of these, never 0,
            # and says so (``left_unread``, REV-LNW-2). One the job never
            # reached has none either: its state says so.
            unread = d in blank and blank[d] is None
            found = blank.get(d) or {}
            if found.get('unworked'):
                # A sentence holding words the job never worked (a person
                # merged them in after it wrote there) is not counted done
                # (S5-3, REV-SJ2-10).
                done = max(0, (done or 0) - len(found['unworked']))
            listed = found.get('left') or []
            unreached = found.get('not_reached') or []
            untouched = found.get('untouched') or []
            counts = {k: v for k, v in counts.items()
                      if k not in ('left', 'untouched', 'not_reached', 'blank', 'left_units')}
            if found.get('blank'):
                counts['blank'] = found['blank']
                if any(b['unit'] != 'sentence' for b in found['blank']):
                    counts['left'] = sum(1 for e in listed if e.get('form') is not None)
                    if untouched:
                        # The words and morphemes blank in sentences it
                        # worked and wrote nothing in: counted, never listed
                        # (RPF-A9).
                        counts['untouched'] = sum(1 for e in untouched if e.get('form') is not None)
                    if unreached:
                        counts['not_reached'] = sum(1 for e in unreached if e.get('form') is not None)
                # How many places Left blank lists, by unit, the cut ones
                # too: the Documents table says its unit (REV-DF-S N-2).
                units = Counter('sentence' if e.get('form') is None else 'morpheme' if '.m' in e['ref'] else 'word'
                                for e in listed)
                counts['left_units'] = [{'unit': u, 'left': units[u]} for u in ('word', 'morpheme', 'sentence')
                                        if units[u]]
            skips = list(row.get('skipped') or [])
            if not self.got_to(d):
                # A sentence too long for a job is skipped only where the job
                # got to it (S8-2).
                skips = [x for x in skips if x.get('reason') != 'too-long']
                counts.pop(TOO_LONG_MORE, None)
            left, more = core_job.cut(listed)
            # What a refusal the job could not follow left (REV-DAY-SURFACE
            # point 2): listed, never counted as left blank.
            gone, gone_more = core_job.cut(refused.get(d) or [])
            out.append({'document_id': d, 'name': self.names.get(d) or row.get('name'),
                        'state': state if state in ('done', 'in-use', 'gone') else 'not-reached',
                        'sentences': row.get('sentences'), 'targets': targets, 'done': done,
                        'counts': counts, 'skipped': skips,
                        'gloss_group': row.get('gloss_group'), 'harmonize_group': row.get('harmonize_group'),
                        # No list where nothing was counted (a plan that
                        # fills nothing, a document deleted or unread), so
                        # nothing reads "0 left blank" of it (REV-DF-S-2).
                        **({'left': left, 'left_more': more} if found.get('blank') else {}),
                        **({'left_unread': True} if unread else {}),
                        **({'refused': gone, 'refused_more': gone_more} if gone else {})})
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
        message = summary_message(report, tg.said_setup(getattr(job, 'setup', None),
                                                        tg.gone_ids(report.get('plan'))))
        while True:
            job.check()
            ws = JobWorkspace(job.client(), project, mode=JobWorkspace.PLAN)
            system = build_summary_prompt(project)
            kit = Toolkit(tools_for=lambda w: [], call_tool=lambda w, name, args: '', tracer=TRACER)
            self.trace(ws, system, kit, 'summary')
            try:
                # Its own line past the decide-now size: it is no piece and
                # has no tool (REV-RW-8).
                result = self.turn(ws, kit, system, [{'role': 'user', 'content': message}],
                                   pace=self.pace(line=JOB_TEXT_NOW))
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
            # A job stopped in its work: what each piece in hand wrote, so far as it is known.
            core_job.through_core(job, self.end_summaries)
        except Exception as e:  # noqa: BLE001 - a report without them rather than none
            logger.warning('Job %s: the summaries of its last pieces could not be kept: %s', job.id, e)
        try:
            rows = core_job.through_core(job, job.decisions)
        except Exception as e:  # noqa: BLE001 - a report without these parts rather than none
            logger.warning('Job %s: its plan and proposed changes could not be read for the report: %s', job.id, e)
            rows = []
        plan, changes, notes, dropped, fallback, tables_dropped = self.plan_stored(rows), [], [], 0, [], 0
        # The pieces that ended without finishing (REV-RW-6), each once.
        ended: set = set()
        keys: set = set()
        #: a word's last row, by its form (RPF3-B)
        respelled: Dict[str, Dict[str, Any]] = {}
        tables: Dict[str, Dict[str, Any]] = {}
        found: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            form = str(r.get('form') or '')
            if form == DROPPED_FORM:
                # One row a change, whatever its count (REV-JR1-11).
                dropped += 1
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
            if not form.startswith(' ') or form in (PLAN_FORM, PLAN_INSTRUCTIONS_FORM):
                continue
            try:
                value = json.loads(r['analysis'])
            except (ValueError, TypeError, KeyError):
                continue
            if form == PIECE_FORM:
                if isinstance(value, dict) and value.get('ended'):
                    ended.add(r.get('key'))
            elif form.startswith(FALLBACK_FORM):
                fallback.append({'document_id': None if value.get('document') == SELECTION
                                 else value.get('document'), 'reason': value.get('reason')})
            elif form.startswith(CHANGE_FORM):
                changes.append(value)
                keys.add(r.get('key'))
            elif form.startswith(NOTE_FORM):
                notes.append(value)
            elif form.startswith(RESPELLED_FORM):
                respelled[form] = {**value, 'document_id': value.get('document'),
                                   'name': self.names.get(value.get('document'))
                                   or (job.rows.get(value.get('document')) or {}).get('name')}
            elif form.startswith(FINDINGS_FORM):
                key = form[len(FINDINGS_FORM):].rsplit(' ', 1)[0]
                slot = found.setdefault(key, {k: value.get(k) for k in ('document', 'name', 'sentences')})
                slot.setdefault('parts', {})[value.get('part') or 0] = value.get('text') or ''
            elif form.startswith(TABLE_FORM):
                key = form[len(TABLE_FORM):].rsplit(' ', 1)[0]
                slot = tables.setdefault(key, {'title': value.get('title'), 'columns': value.get('columns'),
                                               'rows': [], 'more': value.get('more') or 0, 'parts': {}})
                slot['parts'][value.get('part') or 0] = value.get('rows') or []
        # The changes of the job's writes cut short that are not taken
        # again (:meth:`unwritten`), each once.
        try:
            core_job.through_core(job, lambda: self.known_at_end(job))
            for d in job.order:
                listed, n = self.unwritten(d)
                dropped += n
                for c in listed:
                    key = analysis_key(canonical({k: v for k, v in c.items() if k != 'reason'}))
                    if key not in keys:
                        keys.add(key)
                        changes.append(c)
        except Exception as e:  # noqa: BLE001 - a report without them rather than none
            logger.warning('Job %s: the changes it did not write could not be read for the report: %s', job.id, e)
        changes = self.still_proposed(job, changes)
        order = {d: i for i, d in enumerate(job.order)}
        changes.sort(key=lambda c: (order.get(c.get('document_id'), len(order)),
                                    [int(n) for n in re.findall(r'\d+', c.get('ref') or '')]))
        listed, more = core_job.cut(changes)
        # Each piece's note in the job's document order, then by its first
        # sentence, never in the order core keeps the rows (REV-DAY-P-20).
        notes.sort(key=lambda n: (order.get(n.get('document'), len(order)),
                                  [int(x) for x in re.findall(r'\d+', n.get('sentences') or '')[:1]]))
        shown_notes, notes_more = core_job.cut(notes)
        made = []
        for key in sorted(tables):
            t = tables[key]
            rows = [row for _, part in sorted(t['parts'].items()) for row in part]
            made.append({'title': t['title'], 'columns': t['columns'], 'rows': rows, 'more': t['more']})
        findings = self.findings_of(plan, list(found.values()), order)
        if plan is not None:
            # Each document the job holds that the plan left out, listed as
            # such on the job page and in read_job (the lead's ruling), but
            # one already final when the plan was made (gone at the checks:
            # its row says so, REV-JG2-7).
            named = set(plan.get('documents') or job.order)
            # The sentences a search matched are the walk's, not the report's (SF).
            plan = {**{k: v for k, v in plan.items() if k not in ('matched', 'matched_words')},
                    **self.fills_named(job, plan), **self.documents_named(job, plan),
                    'fallback': fallback,
                    'left_out': [{'document_id': d, 'name': self.names.get(d) or (job.rows.get(d) or {}).get('name')}
                                 for d in job.order
                                 if d not in named and (job.rows.get(d) or {}).get('state') not in ROW_FINAL]}
        order_of = {d: i for i, d in enumerate(job.order)}
        spelled = sorted(({k: v for k, v in r.items() if k != 'document'} for r in respelled.values()),
                         key=lambda r: (order_of.get(r['document_id'], len(order_of)),
                                        [int(x) for x in re.findall(r'\d+', r.get('ref') or '')]))
        spelled_listed, spelled_more = core_job.cut(spelled)
        return {'plan': plan,
                **({'respelled': spelled_listed, 'respelled_more': spelled_more} if spelled else {}),
                'proposed': listed, 'proposed_more': more + dropped, 'proposed_dropped': dropped,
                'notes': shown_notes, 'notes_more': notes_more, 'tables': made[:JOB_TABLES_MAX],
                'tables_more': max(0, len(made) - JOB_TABLES_MAX) + tables_dropped,
                **({'pieces_ended': len(ended)} if ended else {}),
                **({'findings': findings, **getattr(self, 'findings_counts', {})} if findings else {})}

    def findings_of(self, plan: Optional[Dict[str, Any]], found: List[Dict[str, Any]],
                    order: Dict[str, int]) -> Optional[str]:
        """The one report of a job whose plan fills nothing (RPF-A5), from
        the findings its pieces kept (``found``, each ``{document, name,
        sentences, parts}``): the one piece's whole, or, when several pieces
        kept some, each under a heading naming its piece, in the job's
        order, which the final context makes one report of when the job
        ends done (:meth:`merge_findings`). None for a job that fills
        something, or whose pieces kept none."""
        self.findings_pieces = []
        if plan is None or plan.get('by') == NO_PLAN or plan.get('fills'):
            return None
        pieces = []
        for f in found:
            text = ''.join(t for _, t in sorted(f.get('parts', {}).items())).strip()
            if text:
                pieces.append({**{k: f.get(k) for k in ('document', 'name', 'sentences')}, 'text': text})
        pieces.sort(key=lambda p: (order.get(p.get('document'), len(order)),
                                   [int(x) for x in re.findall(r'\d+', p.get('sentences') or '')[:1]]))
        self.findings_pieces = pieces
        self.findings_counts = {}
        if not pieces:
            return None
        if len(pieces) == 1:
            return findings_text(pieces[0]['text'])
        sections = self.findings_sections(pieces)
        joined = '\n\n'.join(sections)
        if len(joined) <= JOB_FINDINGS_MAX_CHARS:
            self.findings_counts = {'findings_pieces': len(pieces), 'findings_cut': 0}
            return joined
        # Past the cap: the pieces that fit whole, in the job's order, then
        # the cut line, never a heading with nothing under it. The rest are
        # left out here and each is on its own row of the work list
        # (REV-RPF-W-2, REV-RPF2-4). ``findings_cut``: how many are left out.
        room = JOB_FINDINGS_MAX_CHARS - len(FINDINGS_CUT) - 2
        whole, size = 0, 0
        while whole < len(sections) and size + len(sections[whole]) + (2 if whole else 0) <= room:
            size += len(sections[whole]) + (2 if whole else 0)
            whole += 1
        if whole == 0:
            # Not even the first piece fits: it is cut, and counted shown.
            self.findings_counts = {'findings_pieces': len(pieces), 'findings_cut': len(pieces) - 1}
            return findings_text(sections[0])
        self.findings_counts = {'findings_pieces': len(pieces), 'findings_cut': len(pieces) - whole}
        return '\n\n'.join(sections[:whole]) + '\n\n' + FINDINGS_CUT

    def findings_sections(self, pieces: List[Dict[str, Any]]) -> List[str]:
        """Each piece's findings whole under a heading naming its piece."""
        return [f'## {self.piece_heading(p)}\n\n{p["text"]}' for p in pieces]

    @staticmethod
    def piece_heading(p: Dict[str, Any]) -> str:
        """A piece as a heading names it: its document and sentences, "All
        the documents" for a selection."""
        name = p.get('name') or ('All the documents' if p.get('document') is None else 'A document')
        return f'{name}, {p["sentences"]}' if p.get('sentences') else name

    def merge_findings(self, job, report: Dict[str, Any]) -> Optional[str]:
        """The one report of a job that fills nothing whose findings several
        pieces kept: the final context, given every piece's findings whole,
        writes the job's one report, with no tools. None when one piece or
        none kept findings, and None when the pieces' findings do not fit
        whole in JOB_FINDINGS_MERGE_CHARS (REV-RPF-W-2): a merge that cannot
        be handed them all would leave pieces out with nothing saying so, so
        the report keeps the pieces' findings under their headings, cut
        where the cap is reached, with the counts of what it holds."""
        from .prompt import build_findings_prompt
        pieces = getattr(self, 'findings_pieces', None) or []
        if len(pieces) < 2:
            return None
        joined = '\n\n'.join(self.findings_sections(pieces))
        if len(joined) > JOB_FINDINGS_MERGE_CHARS:
            return None
        message = '\n'.join([
            'The job\'s instructions:', report.get('instructions') or '', '',
            f'The findings of each of its {len(pieces)} pieces, in the job\'s order:', '',
            joined, '', 'Write the job\'s one report now.'])
        project = self.project()
        while True:
            job.check()
            ws = JobWorkspace(job.client(), project, mode=JobWorkspace.PLAN)
            system = build_findings_prompt(project)
            kit = Toolkit(tools_for=lambda w: [], call_tool=lambda w, name, args: '', tracer=TRACER)
            self.trace(ws, system, kit, 'findings')
            try:
                result = self.turn(ws, kit, system, [{'role': 'user', 'content': message}],
                                   pace=self.pace(line=JOB_TEXT_NOW))
                return findings_text(result.text) or None
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

    def fills_named(self, job, plan: Dict[str, Any]) -> Dict[str, Any]:
        """``fills_names``: what the plan fills by the targets' names as the
        project now names them, each as the setup line names it
        (``targets.shown_names``, REV-SUFIX-4), for the job page and
        read_job ("Fills:
        segmentation, Morph Gloss.", "Fills nothing.", REV-DF-D-1). Nothing
        for a plan with no ``fills`` or when the project cannot be read."""
        if not isinstance(plan.get('fills'), list):
            return {}
        try:
            project = core_job.through_core(job, self.project)
        except Exception as e:  # noqa: BLE001 - the plan without the names rather than no report
            logger.warning('Job %s: what its plan fills could not be named for the report: %s', job.id, e)
            return {}
        return {'fills_names': tg.shown_names(project, tg.of_ids(project, plan['fills']))}

    @staticmethod
    def documents_named(job, plan: Dict[str, Any]) -> Dict[str, Any]:
        """``documents_named``: how many of the job's documents a plan that
        names fewer than all of them names, for the job page and read_job
        ("Worked on 2 documents at once.", S2-2). Nothing when it names none
        or every one."""
        order = set(job.order)
        named = {d for d in plan.get('documents') or [] if d in order}
        return {'documents_named': len(named)} if named and len(named) < len(order) else {}

    def still_proposed(self, job, changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """``changes`` less each one its document already holds as the
        report is written (:func:`holds_change`): a project-wide change
        staged in one piece is proposed in the documents it reaches, and a
        later piece of the job may write the same change in its own (REV-DAY-S-2):
        the report counts that write once, as a change. A document that
        cannot be read keeps its changes listed."""
        if not any(c.get('document_id') for c in changes):
            return changes
        try:
            project = core_job.through_core(job, self.project)
        except Exception as e:  # noqa: BLE001 - the list as it is rather than none
            logger.warning('Job %s: its proposed changes could not be checked: %s', job.id, e)
            return changes
        docs: Dict[str, Any] = {}
        out = []
        for c in changes:
            d = c.get('document_id')
            if d:
                if d not in docs:
                    try:
                        docs[d] = core_job.through_core(job, lambda: self.read(project, d))
                    except Exception as e:  # noqa: BLE001 - gone or unreadable: still listed
                        logger.info('Job %s: %s not read for its proposed changes: %s', job.id, d, e)
                        docs[d] = None
                if docs[d] is not None and holds_change(docs[d], project, c):
                    continue
            out.append(c)
        return out

    def known_at_end(self, job) -> None:
        """Once, as the report is written: every try of the job whose
        requests are not all known to have landed is asked of core again
        (a request still queued in core when it was first asked lands
        later), so the report counts and lists what core holds now."""
        if self.ended:
            return
        for d in job.order:
            self.writing_rows(d)
        self.look_up([r['try'] for rows in (self.rows or {}).values() for r in rows
                      if r['try'] and (r['try'] not in self.looked or self.key_of(r) not in self.landed)])
        self.ended = True

    def left_blank(self, job) -> Dict[str, Optional[Dict[str, List[Dict[str, Any]]]]]:
        """Per document the job reached, what is blank in it as it now is,
        read when the report is written, in the sentences the job was to
        work, less what the job wrote (:meth:`written`: one that reads blank
        was cleared by a person, and is counted as written, REV-LNW-4):
        every word empty for a word or morpheme level target of the plan and
        every sentence level target a sentence is empty for (THE rule,
        :func:`sentence_targets`), as ``{ref, sentence_id, begin, form,
        targets}`` in document order (``begin`` and ``form`` None for a
        sentence field, ``targets`` the names of the targets it is empty
        for), in two lists, and ``blank``, per target of the plan,
        ``{target, unit, left, not_reached, skipped}``, how many places of
        each list, and of the skipped sentences, are empty for it:

        * ``left``: in the sentences the job worked (a landed write of their
          own piece finished them, :meth:`finished`, wherever a split or a
          merge moved their words), whatever the piece staged there or not,
        * ``skipped``: in the sentences listed as skipped (no answer, too
          long, failed, changed), counted and never listed (REV-DF-D-9),
        * ``not_reached``: in its other sentences: the walk had not reached them when the job ended
          (stopped, or the document put off for good). A sentence of a
          document whose walk ended holds nothing here unless it became
          blank after the walk passed it.

        A sentence the walk takes (every sentence, or one holding something
        blank) is in exactly one of worked, skipped and not reached, so what
        the job analysed, left, skipped and did not reach add up to the
        words it was to work. A document the job never reached is read too,
        everything blank in it not reached; one the plan left out is not.
        None for a document that could not be
        read (every document, when what landed could not be read): the
        report says so (REV-LNW-2). A document gone lists nothing."""
        try:
            core_job.through_core(job, lambda: self.known_at_end(job))
            project = core_job.through_core(job, self.project)
        except Exception as e:  # noqa: BLE001 - a report without the list rather than none
            logger.warning('Job %s: the words it left blank could not be read for the report: %s', job.id, e)
            return {d: None for d in job.order}
        out: Dict[str, Optional[Dict[str, List[Dict[str, Any]]]]] = {}
        fill = self.targets(project)
        # A job that fills only the words it adds leaves nothing else blank (RPF-A7).
        only = self.only_new(project)
        # Every document the plan works is read, those it never reached too:
        # their blanks are not reached (REV-DF-S-3). A document the plan
        # left out is not the job's work.
        planned = (self.plan_made or {}).get('documents')
        for d in job.order:
            worked, known, written = self.finished(d), self.known_words(d), self.written(d)
            wrote, wrote_known = self.wrote_in_sentences(d)
            takes = self.search_takes(d)
            if planned and d not in planned and not worked:
                continue
            skipped = self.excluded(d) - worked
            if not self.got_to(d):
                # Never skipped where the job did not get to (S8-2).
                skipped -= self.too_long_ids(d)
            try:
                doc = core_job.through_core(job, lambda: self.read(project, d))
            except Gone:
                continue
            except Exception as e:  # noqa: BLE001 - unreadable: the report says so, the rest is still listed
                logger.warning('Job %s: %s could not be read for the words left blank: %s', job.id, d, e)
                out[d] = None
                continue
            lists = out.setdefault(d, {'left': [], 'untouched': [], 'not_reached': [], 'blank': []})
            added = core_job.through_core(job, self.added)[0]
            tally = {t.id: {k: 0 for k in BLANK_WHERE} for t in fill}
            for s in doc.sentences:
                if s.id in wrote or wrote_in(s, wrote_known):
                    where = 'left'
                elif s.id in worked or wrote_in(s, known):
                    # Worked, and nothing written there: counted, never
                    # listed, as the instructions may have said to leave it
                    # (RPF-A9, RP-3's junk sentence, RP-6's last sentences).
                    where = 'untouched'
                elif s.id in skipped:
                    # Counted, never listed: the sentence is listed as
                    # skipped (REV-DF-D-9).
                    where = 'skipped'
                elif takes is not None and not takes(s):
                    # Not matched by the plan's search: not the job's work (SF).
                    continue
                else:
                    where = 'not_reached'
                # THE rule over the plan's targets (:func:`sentence_targets`),
                # each entry naming the targets it is empty for.
                words, fields = sentence_targets(s, project, job.id, written=written, targets=fill)
                if only is not None:
                    words = [w for w in words if w.id in only[0]]
                    fields = fields if s.id in only[1] else []
                # In a sentence the job wrote in, the words no write of it
                # named (a person's merge or insert brought them after): the
                # walk never takes that sentence again (REV-B4-1), so they
                # are blank where the job did not reach, never left by it
                # (S5-3, REV-SJ2-10).
                # A word a landed text edit of the job added is the job's
                # (``record_added``), decided by word (REV-SJ2-R2-2).
                newcomers = ({f'w{w.index}' for w in s.words if word_tag(w.id) not in known and w.id not in added}
                             if where in ('left', 'untouched') and wrote_in(s, known) else set())
                begins = {f'w{w.index}': w.begin for w in s.words}
                # One entry per unit as the Empty line names it (targets.units:
                # a word, a morpheme sN.wK.mJ, a sentence field), with every
                # target it is empty for (REV-DF-S-6).
                entries: Dict[str, Dict[str, Any]] = {}
                for ref, form, t in tg.units(s, fill, words={w.id for w in words}, fields=fields):
                    here = 'not_reached' if ref and ref.split('.')[0] in newcomers else where
                    if here != where:
                        unworked = lists.setdefault('unworked', [])
                        if s.id not in unworked:
                            unworked.append(s.id)
                    # A word with no morphemes, empty for segmentation too,
                    # is one unit, a word, counted once under segmentation:
                    # never again as a morpheme of a morpheme field (RP-3).
                    if not (t.scope == 'Morpheme' and ref and '.m' not in ref):
                        tally[t.id][here] += 1
                    elif here == 'left':
                        # Such a word, listed blank for the morpheme field
                        # too, is counted as a word not segmented beside the
                        # field's morphemes, so the totals add up with the
                        # list (RPF3-B, RP2-2: "Gloss left blank 0
                        # morphemes" beside a word listed blank for Gloss).
                        tally[t.id]['unsegmented'] = tally[t.id].get('unsegmented', 0) + 1
                    if lists.get(here) is None:
                        continue
                    e = entries.get(ref)
                    if e is None:
                        e = entries[ref] = {'ref': f's{s.index}.{ref}' if ref else f's{s.index}', 'sentence_id': s.id,
                                            'begin': begins.get(ref.split('.')[0]) if ref else None,
                                            'form': form if ref else None, 'targets': [], 'where': here}
                    e['targets'].append(t.name)
                # In the order of the text, the sentence's fields last.
                for e in sorted(entries.values(), key=lambda e: (
                        e['begin'] is None, e['begin'] or 0, [int(n) for n in re.findall(r'\d+', e['ref'])])):
                    lists[e.pop('where')].append(e)
            # Per target of the plan, a row even at nothing left, counted in
            # its own unit: a word, a morpheme, a sentence (REV-DF-S-6: a
            # morpheme field's values and blanks sum). A target the plan
            # does not fill has no row, so nothing claims "0 left" of it
            # (REV-DAY-P-4, S-9).
            lists['blank'] = [{'target': t.name, 'unit': UNIT[t.scope], **tally[t.id]} for t in fill]
        return out

#: The unit a target's blanks are counted in, by its level.
UNIT = {'Word': 'word', 'Morpheme': 'morpheme', 'Sentence': 'sentence'}


def runner_factory(cfg: ModelConfig, trace_dir: Optional[str] = None, count=None,
                   piece_output_tokens: Optional[int] = JOB_PIECE_OUTPUT_TOKENS):
    """What the worker builds a claimed igt job's runner with."""
    return lambda job: IgtRunner(job, cfg, trace_dir=trace_dir, count=count,
                                 piece_output_tokens=piece_output_tokens)
