"""Talking about an unattended job: its summary for a turn asked from its page,
and the ``read_job`` tool (BRIEF-JD, 2026-11-13).

A job page is a place the way a document is (``where: {kind: 'job', id,
name}``). A turn asked from the page of an ENDED job gives the model a short
summary of the job, read from core as the turn starts: its name and id, its
state, who started it and when, the instructions as sent (cut), how its work
was cut, the start of its summary, the totals, and each report section with
how many rows it holds. A running or waiting job's page gives one fixed line
(its name, its state, and that read_job reads it), so the stored prompt does
not change every turn. Never the report itself: ``read_job`` reads a section
of it by page.

A section is named as the job page heads it, with its key: "Left blank
(left)". The headings are the page's own (``jobSections.json`` in plaid-igt,
one mapping for both).

Jobs record outcomes, never reasons (owner's ruling, 2026-11-13): nothing here
says why a job did anything, and the model is told so in the prompt.

The report's sections are the report's own lists (CONTRACT 5.3 and its "Added
by" sections), found by walking the report as it is: a list of rows at its top
(``documents``), a list of rows in one of its parts (``harmonize.changed``,
``entries.created``), and a list of rows in each document's entry, taken
together over the documents (``left``, ``skipped``). A key a later round adds
to the report is a section here with no change. Each list's ``<key>_more``
beside it (or in a document's ``counts``) says how many the worker did not
list.

Everything is read with the turn's own client, so a job the user cannot read
is refused as core refuses it.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..core.args import read_int
from ..core.history import doc_label
from ..core.record_ops import _names_nothing
from ..core.tools import ToolError, truncate

#: How much of a job's instructions, and of its summary, a turn's summary
#: quotes. read_job with the job gives them whole.
JOB_SUMMARY_NOTE_CHARS = 400

#: The job page's headings of the report's sections, in plaid-igt, and the
#: copy that travels in the package (``bb sample-prompts`` refreshes it).
REPO_SECTIONS = Path(__file__).resolve().parents[4] / 'plaid-igt' / 'src' / 'components' / 'projects' / 'jobs' \
    / 'jobSections.json'
PACKAGED_SECTIONS = Path(__file__).with_name('job-sections.json')


def _headings() -> Dict[str, str]:
    for path in (REPO_SECTIONS, PACKAGED_SECTIONS):
        if path.is_file():
            return json.loads(path.read_text(encoding='utf-8'))
    return {}


HEADINGS = _headings()


def section_name(key: str) -> str:
    """A section as the job page heads it, with its key: "Left blank
    (left)". A section the page has no heading for is its key alone."""
    heading = HEADINGS.get(key)
    return f'{heading} ({key})' if heading else key


def section_key(name: str) -> str:
    """The key of a section named by its key, its heading, or both as
    :func:`section_name` says them."""
    text = str(name or '').strip()
    if text.endswith(')') and '(' in text:
        text = text[text.rindex('(') + 1:-1].strip()
    by_heading = {h.casefold(): k for k, h in HEADINGS.items()}
    return by_heading.get(text.casefold(), text)
#: Rows of a report section one read_job call shows.
JOB_ROWS_PER_PAGE = 40
#: Jobs one read_job call with no job lists.
JOB_LIST_PER_PAGE = 10

#: Keys of a row that name nothing the model can read or plan with: a
#: sentence's token id and a word's offset (the page's link into the grid),
#: and History's group ids.
_HIDDEN = ('sentence_id', 'begin', 'gloss_group', 'harmonize_group', 'updated_at', 'position')


# --- the record ------------------------------------------------------------------

def _rows(value: Any) -> bool:
    """A list of rows: a non-empty list whose items are all objects."""
    return isinstance(value, list) and bool(value) and all(isinstance(v, dict) for v in value)


def _more(holder: Dict[str, Any], key: str) -> int:
    """How many rows of ``holder[key]`` the worker counted and did not list."""
    n = holder.get(f'{key}_more')
    if n is None:
        n = (holder.get('counts') or {}).get(f'{key}_more')
    return n if isinstance(n, int) else 0


def sections(report: Optional[Dict[str, Any]]) -> List[Tuple[str, List[Tuple[Optional[Dict], Dict]], int]]:
    """The report's sections in the report's order, each ``(name, rows,
    more)``: ``rows`` as ``(document entry or None, row)``, ``more`` the rows
    the worker did not list. The lists each document holds come right after
    ``documents``, a row under its document. Only sections that hold
    something."""
    report = report or {}
    out: List[Tuple[str, List[Tuple[Optional[Dict], Dict]], int]] = []
    for key, value in report.items():
        if _rows(value):
            out.append((key, [(None, r) for r in value], _more(report, key)))
            if key == 'documents':
                out.extend(_document_sections(value))
        elif isinstance(value, dict):
            for sub, rows in value.items():
                more = _more(value, sub) if isinstance(rows, list) else 0
                if _rows(rows) or (isinstance(rows, list) and more):
                    out.append((f'{key}.{sub}', [(None, r) for r in rows], more))
    return out


def _document_sections(documents: List[Dict[str, Any]]):
    """The lists in each document's entry, each taken over all the documents."""
    by_doc: Dict[str, List[Tuple[Optional[Dict], Dict]]] = {}
    more: Dict[str, int] = {}
    for d in documents:
        for sub, rows in d.items():
            if not isinstance(rows, list):
                continue
            listed = _rows(rows)
            if listed or _more(d, sub):
                by_doc.setdefault(sub, []).extend((d, r) for r in (rows if listed else []))
                more[sub] = more.get(sub, 0) + _more(d, sub)
    return [(name, rows, more[name]) for name, rows in by_doc.items()]


def _documents(n: int) -> str:
    return f'{n:,} document{"" if n == 1 else "s"}'


def _when(iso: Optional[str]) -> str:
    """An instant as the record holds it, to the minute: ``2026-11-13 03:10 UTC``."""
    if not iso:
        return ''
    text = str(iso).replace('T', ' ')
    return f'{text[:16]} UTC' if len(text) >= 16 else text


def _words(key: str) -> str:
    return key.replace('_', ' ')


def _totals(report: Dict[str, Any]) -> str:
    totals = report.get('totals') or {}
    said = [f'{_words(k)} {v:,}' for k, v in totals.items() if isinstance(v, int) and v]
    return ', '.join(said) if said else 'nothing counted'


def _sections_line(report: Optional[Dict[str, Any]]) -> str:
    found = sections(report)
    if not found:
        return 'The report lists nothing.'
    said = ', '.join(f'{section_name(name)} {len(rows) + more:,}' for name, rows, more in found)
    return f'Report sections and their rows: {said}.'


def _state_line(job: Dict[str, Any]) -> str:
    state = job.get('state') or ''
    reason = job.get('reason')
    line = f'State: {state}' + (f' ({reason})' if reason and reason != state else '')
    if state in ('running', 'stopping') and job.get('phase'):
        line += f', {job["phase"]}'
    if job.get('message'):
        line += f'. Its line: "{job["message"]}"'
    return line + '.'


def _quoted(what: str, text: str, chars: Optional[int]) -> str:
    if chars is not None and len(text) > chars:
        return (f'{what}, the first {chars:,} of {len(text):,} characters (read_job with the job gives it '
                f'whole): "{text[:chars]}…"')
    return f'{what}: "{text}"'


#: How the job page words a plan's pieces.
_PIECES = {'sentences': 'stretches of sentences', 'document': 'one piece per document',
           'selection': 'one piece for all the documents'}


def plan_line(report: Dict[str, Any]) -> Optional[str]:
    """How the job's work was cut, in one line, as the job page says it."""
    plan = report.get('plan')
    if not isinstance(plan, dict):
        return None
    line = f'Worked in {_PIECES.get(plan.get("pieces"), plan.get("pieces"))}'
    if plan.get('by') == 'default':
        line += ', as the planning ended with no plan'
    smaller = len(plan.get('fallback') or [])
    if smaller:
        line += f', {smaller:,} of them in smaller pieces'
    return line + '.'


def summary(job: Dict[str, Any], note_chars: Optional[int] = JOB_SUMMARY_NOTE_CHARS) -> List[str]:
    """The job in a few lines: state, who and when, the instructions (cut at
    ``note_chars``, with a note of what was cut), how its work was cut, its
    summary (cut the same way), the totals, and the report's sections with
    their rows. Never a row of the report."""
    report = job.get('report')
    lines = [_state_line(job)]
    started = f'Started by {job.get("started_by_name") or job.get("started_by") or "unknown"}'
    if job.get('created_at'):
        started += f', {_when(job["created_at"])}'
    if job.get('finished_at'):
        started += f'. Ended {_when(job["finished_at"])}'
    lines.append(started + '.')
    count = job.get('document_count')
    if count is None:
        count = len(job.get('documents') or [])
    lines.append(f'Documents: {count:,}.')
    lines.append(_quoted('Instructions as sent', job.get('instructions') or '', note_chars))
    if report is None:
        lines.append('No report yet.' if job.get('state') in ('waiting', 'running', 'stopping')
                     else 'It has no report.')
        return lines
    planned = plan_line(report)
    if planned:
        lines.append(planned)
    told = (report.get('plan') or {}).get('piece_instructions') if isinstance(report.get('plan'), dict) else None
    if told:
        # The assistant's own words when it planned the job, never the
        # starter's instructions (the lead's ruling on REV-JG-14).
        lines.append(_quoted('What the assistant told every piece, as it planned the job', told, note_chars))
    if report.get('summary'):
        lines.append(_quoted('The job\'s own summary', report['summary'], note_chars))
    elif report.get('summary_failed'):
        lines.append('The job\'s own summary could not be written.')
    lines.append(f'Totals: {_totals(report)}.')
    lines.append(_sections_line(report))
    return lines


def _job(ws, job_id: str) -> Dict[str, Any]:
    """The job, read with the turn's own client. One refusal for an id that
    names no job the user can read and for a job of another project."""
    try:
        job = ws.client.jobs.get(job_id)
    except Exception as e:  # noqa: BLE001 - core's refusal, said as it says it
        if _names_nothing(e):
            job = None
        else:
            raise
    if not isinstance(job, dict) or job.get('project') != ws.project.id:
        raise ToolError(f'No job of this project has the id "{job_id}". read_job with no job lists them.',
                        kind='not-found')
    return job


# --- the place -------------------------------------------------------------------

#: A job's states that are its end.
ENDED = ('done', 'cancelled', 'failed')


def job_place(ws, where: Dict[str, Any]) -> Optional[tuple]:
    """``(noun, name, note)`` for a turn asked from a job's page: the job's id
    (what read_job takes back), and what the model is told: the job by its
    page's name beside its id, and for an ended job its summary as read now,
    for one not ended one fixed line. A job that is gone says so."""
    job_id = str(where.get('id') or '')
    if not job_id:
        return None
    name = str(where.get('name') or '').strip()
    called = f'"{name}" (job {job_id})' if name else f'job {job_id}'
    try:
        job = _job(ws, job_id)
    except ToolError:
        return ('job', job_id, f'The user has open the page of {called}, which no longer exists in this project.')
    except Exception as e:  # noqa: BLE001 - the turn goes on without it
        return ('job', job_id, f'The user has open the page of {called}, which could not be read now: {e}')
    by_name = (f' Call it "{name}" to the user: its id is for read_job only.' if name else '')
    if job.get('state') not in ENDED:
        return ('job', job_id, f'The user has open the page of an assistant job of this project, {called}, which '
                               f'is {job.get("state")}.{by_name} read_job reads it.')
    head = f'The user has open the page of an assistant job of this project, {called}.{by_name} Its record as read now:'
    return ('job', job_id, '\n'.join([head, *summary(job), 'read_job reads a section of the report.']))


# --- read_job --------------------------------------------------------------------

def _document_name(ws, entry: Optional[Dict[str, Any]], doc_id: Optional[str]) -> str:
    """A document as a row names it: its name, live or as the report kept it,
    or that it was deleted."""
    if entry is not None and 'name' in entry:
        name = entry.get('name')
    else:
        name = doc_label(ws, doc_id) if doc_id else None
        name = None if name == doc_id else name
    return f'"{name}"' if name else f'a deleted document ({doc_id})'


def _report_names(report: Dict[str, Any]) -> Dict[str, Optional[str]]:
    return {d.get('document_id'): d.get('name') for d in report.get('documents') or [] if isinstance(d, dict)}


def _value(ws, key: str, value: Any, names: Dict[str, Optional[str]]) -> Optional[str]:
    if value is None or value == '' or value == [] or value == {}:
        return None
    if key == 'lexicon' and isinstance(value, str):
        return next((f'"{v["name"]}"' for v in ws.project.vocabs if v['id'] == value), value)
    if key == 'documents' and isinstance(value, list) and all(isinstance(v, str) for v in value):
        return ', '.join(_document_name(ws, {'name': names[v]} if v in names else None, v) for v in value)
    if isinstance(value, dict):
        said = [f'{_words(k)} {v:,}' for k, v in value.items() if isinstance(v, int) and v]
        return ', '.join(said) or None
    if isinstance(value, list):
        if all(isinstance(v, dict) and 'analysis' in v for v in value):
            parts = []
            for v in value:
                part = f'{v.get("analysis")} ×{v.get("count")}' if v.get('count') is not None else str(v['analysis'])
                where = _value(ws, 'documents', v.get('documents'), names)
                parts.append(part + (f' in {where}' if where else ''))
            return ', '.join(parts)
        if all(isinstance(v, dict) for v in value):
            return f'{len(value):,}'
        return ', '.join(str(v) for v in value)
    return f'{value:,}' if isinstance(value, int) and not isinstance(value, bool) else str(value)


def _row_line(ws, entry: Optional[Dict[str, Any]], row: Dict[str, Any], names: Dict[str, Optional[str]]) -> str:
    """One row: its document first when it has one, then its keys."""
    parts = []
    if entry is not None:
        parts.append(_document_name(ws, entry, entry.get('document_id')))
    elif 'document_id' in row:
        parts.append(f'{_document_name(ws, row, row.get("document_id"))}, id {row.get("document_id")}')
    for k, v in row.items():
        if k in _HIDDEN or k in ('document_id', 'name') and 'document_id' in row or k.endswith('_more'):
            continue
        said = _value(ws, k, v, names)
        if said is not None:
            parts.append(f'{_words(k)}: {said}')
    return ' | '.join(parts)


def _row_documents(entry: Optional[Dict[str, Any]], row: Dict[str, Any]) -> set:
    found = set()
    if entry is not None:
        found.add(entry.get('document_id'))
    if row.get('document_id'):
        found.add(row['document_id'])
    for v in row.values():
        if isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    found.update(item.get('documents') or [])
    return found


def _resolve_document(report: Dict[str, Any], document: str) -> str:
    names = _report_names(report)
    if document in names:
        return document
    hits = [i for i, n in names.items() if n and n == document] or \
           [i for i, n in names.items() if n and n.casefold() == document.casefold()]
    if len(hits) == 1:
        return hits[0]
    listed = ', '.join(f'"{n}"' for n in names.values() if n)
    raise ToolError(f'The job holds no document "{document}". Its documents: {listed or "none named"}.',
                    kind='not-found')


def _list_jobs(ws, page: int) -> str:
    jobs = ws.client.jobs.list(ws.project.id)
    start = (page - 1) * JOB_LIST_PER_PAGE
    shown = jobs[start:start + JOB_LIST_PER_PAGE]
    ws.note_read(len(shown), 'row', of=len(jobs))
    if not jobs:
        return 'This project has no jobs.'
    if not shown:
        raise ToolError(f'Page {page} is past the end: {len(jobs):,} jobs, {JOB_LIST_PER_PAGE} a page.',
                        kind='not-found')
    lines = [f'Jobs of this project, newest first: {start + 1} to {start + len(shown)} of {len(jobs):,}.']
    for j in shown:
        ended = f', ended {_when(j.get("finished_at"))}' if j.get('finished_at') else ''
        instructions = ' '.join(str(j.get('instructions') or '').split())
        brief = instructions if len(instructions) <= 60 else instructions[:59] + '…'
        lines.append(f'{j.get("id")} | {j.get("state")} | "{brief}" | started by '
                     f'{j.get("started_by_name") or j.get("started_by")}, {_when(j.get("created_at"))}{ended} | '
                     f'{_documents(j.get("document_count") or 0)}')
    if start + len(shown) < len(jobs):
        lines.append(f'Older jobs: page {page + 1}.')
    lines.append('read_job with a job\'s id gives its summary and its report\'s sections.')
    return '\n'.join(lines)


def _section_rows(ws, job: Dict[str, Any], section: str, document: Optional[str], page: int) -> str:
    report = job.get('report')
    if report is None:
        raise ToolError(f'Job {job["id"]} is {job.get("state")} and has no report yet.', kind='not-found')
    found = {name: (rows, more) for name, rows, more in sections(report)}
    section = section_key(section)
    if section not in found:
        named = ', '.join(section_name(n) for n in found) or 'none, the report lists nothing'
        raise ToolError(f'The report of job {job["id"]} has no section "{section}". Its sections: {named}.',
                        kind='not-found')
    rows, more = found[section]
    names = _report_names(report)
    scope = ''
    whole = ''
    if document:
        doc_id = _resolve_document(report, document)
        if not any(_row_documents(e, r) for e, r in rows):
            raise ToolError(f'The rows of {section_name(section)} name no document, so document cannot narrow them. '
                            'Leave it '
                            'out.', kind='invalid-argument')
        per_document = all(e is not None for e, _ in rows)
        rows = [(e, r) for e, r in rows if doc_id in _row_documents(e, r)]
        if per_document:
            more = sum(_more(e, section) for e in report.get('documents') or [] if e.get('document_id') == doc_id)
        else:
            whole = ' in the whole section'
        scope = f' in {_document_name(ws, {"name": names.get(doc_id)}, doc_id)}'
    start = (page - 1) * JOB_ROWS_PER_PAGE
    shown = rows[start:start + JOB_ROWS_PER_PAGE]
    ws.note_read(len(shown), 'row', of=len(rows))
    if rows and not shown:
        raise ToolError(f'Page {page} is past the end: {len(rows):,} rows, {JOB_ROWS_PER_PAGE} a page.',
                        kind='not-found')
    head = f'Job {job["id"]}, report section {section_name(section)}{scope}'
    if not rows:
        head += ': no rows'
    else:
        head += f': rows {start + 1} to {start + len(shown)} of {len(rows):,}'
    if more:
        head += f', and {more:,} more{whole} the report counted and did not list'
    lines = [head + f'. As the job ended, {_when(report.get("finished_at") or job.get("finished_at"))}.']
    lines.extend((_table_lines(r) if section == 'tables' else _row_line(ws, e, r, names)) for e, r in shown)
    if start + len(shown) < len(rows):
        lines.append(f'Rows {start + len(shown) + 1} to {len(rows):,}: page {page + 1}.')
    return truncate('\n'.join(lines))


def _table_lines(table: Dict[str, Any]) -> str:
    """A table a job's code made, whole: its title, its columns and each row,
    as data, and how many rows it counted and did not keep."""
    out = [f'Table "{table.get("title")}": ' + ' | '.join(str(c) for c in table.get('columns') or [])]
    out += [' | '.join('' if v is None else str(v) for v in row) for row in table.get('rows') or []]
    if table.get('more'):
        out.append(f'and {table["more"]:,} more rows the code counted and the report did not keep')
    return '\n'.join(out)


def _help() -> str:
    return '\n'.join([
        'read_job reads an assistant job of this project: what it did, as its record says. A job\'s record holds '
        'what it did and the notes it left, in the model\'s own words, and nothing more of why.',
        '- No job: the project\'s jobs, newest first, each with its id.',
        '- job: its summary (state, who started it and when, the instructions whole, how its work was cut, the '
        'summary the job wrote, totals) and the report\'s sections with how many rows each holds.',
        f'- job and section: the section\'s rows, {JOB_ROWS_PER_PAGE} a page (page 2 for the next). document '
        'narrows them to one document, by name or id.',
        '- The sections are the report\'s own lists, named as the job page heads them with their key, among '
        'them: ' + ', '.join(section_name(k) for k in HEADINGS) + '. A section takes its key or its heading. '
        'proposed holds the changes the job staged and did not apply (what, where, from which value to which), '
        'which a plan can make once the user asks. left holds words and translations it left blank, a sentence '
        'alone being its translation. tables holds what the job\'s code counted, as data.',
        '- A row gives its document and the place in it (s3.w2, s12), which read_document and the plan tools '
        'take. The report is as the job ended: the document may have changed since.',
    ])


def t_read_job(ws, job: Optional[str] = None, section: Optional[str] = None, document: Optional[str] = None,
               page: Any = None) -> str:
    """Read the project's jobs, a job's summary, or a page of one section of
    its report (see the module's note)."""
    page = read_int(page, 'page', 1, minimum=1)
    job_id = str(job).strip() if job else ''
    section = str(section).strip() if section else ''
    if section.lower() == 'help':
        return _help()
    if not job_id:
        if section or document:
            raise ToolError('Name the job: read_job with no job lists them, with their ids.',
                            kind='invalid-argument')
        return _list_jobs(ws, page)
    found = _job(ws, job_id)
    if not section:
        if document:
            raise ToolError('document narrows a section: name the section too.', kind='invalid-argument')
        report = found.get('report')
        text = '\n'.join([f'Job {job_id}.', *summary(found, note_chars=None),
                          'read_job with a section reads its rows.' if report else '']).rstrip()
        # The summary holds counts, never a row: it is said as the lines it printed.
        ws.note_read(text.count('\n') + 1, 'printed')
        return truncate(text)
    return _section_rows(ws, found, section, str(document).strip() if document else None, page)
