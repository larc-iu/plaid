"""What a piece of a job planned in sentences is handed besides its sentences
(BRIEF-EV): the evidence its model would otherwise look up one form at a time,
computed by the worker with no model, from the project as it is when the
piece starts.

Three parts, in this order, each a fixed rule:

- how each form of the piece's empty words was analysed before, by people in
  the project and earlier in this job (the job's precedent, up to
  ``JOB_PRECEDENT_PER_FORM`` analyses from each source), a form read as the
  surface check reads a word: without the punctuation the project's
  ignored-token rule trims off its edges, in lower case;
- one line naming the forms nobody analysed, so the model need not ask;
- every lexicon entry (senses included, every lexicon of the project) whose
  form, read the same way and without a leading or trailing "-" or "=", is
  spelled inside one of those forms and is at least
  ``JOB_EVIDENCE_MIN_ENTRY`` characters long: one line each, the entry as a
  tool names it back, its gloss and its morph type. A headword with no
  gloss of its own and senses under it is left out: its senses are listed.

The whole is at most ``JOB_EVIDENCE_CHARS`` characters. What does not fit is
cut in a fixed order: entries first, the shortest forms first (the last in
order among forms of one length), then analysed forms from the last, and one
line says what was left out and which tool reads it.
"""

from typing import Any, Dict, Iterable, List, Optional

from ..core.limits import JOB_EVIDENCE_CHARS, JOB_EVIDENCE_MIN_ENTRY, JOB_PRECEDENT_PER_FORM
from .fit import collation_key, entry_gloss, item_morph_type
from .project import IgtProject
from .tools import trim_ignored_edges
from .vocab import ROLE_GLOSS

#: The block's lines, as the model reads them.
ANALYSED_HEAD = 'How these forms were analysed before (by people in this project, and earlier in this job):'
NOWHERE_HEAD = 'Analysed nowhere before: '
ENTRIES_HEAD = 'Lexicon entries spelled inside these forms (form ‘gloss’ type):'


def form_of(surface: str, cfg) -> str:
    """A word's form as the block keys it: the surface without the edge
    punctuation the ignored-token rule trims, NFC, lower case."""
    return collation_key(trim_ignored_edges(surface or '', cfg))


def _bare(form: str) -> str:
    """An entry's form as it is looked for inside a word: lower case, NFC,
    without the "-" or "=" an affix's citation form carries at its edges."""
    return collation_key(form).strip('-=')


def regroup(index: Dict[str, Dict[str, Dict[str, Any]]], cfg) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """People's index (form_key of the surface -> {key: {analysis, count}})
    keyed by :func:`form_of` instead, the counts of one analysis under
    several surfaces ("aloohl" and "aloohl,") added up."""
    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for surface, keys in index.items():
        form = form_of(surface, cfg)
        if not form:
            continue
        for key, x in keys.items():
            slot = out.setdefault(form, {}).setdefault(key, {'analysis': x['analysis'], 'count': 0})
            slot['count'] += x['count']
    return out


def entry_lines(ws, project: IgtProject, forms: Iterable[str]) -> List[tuple]:
    """``(bare form, line)`` for every entry spelled inside one of
    ``forms``, in the order the block prints them (by form, then number)."""
    forms = [f for f in forms if f]
    several = len(project.vocabs) > 1
    out = []
    for v in project.vocabs:
        view = ws.view(v)
        gloss = IgtProject.lexicon_field(v, ROLE_GLOSS)
        by_id = {it['id']: it for it in view.items if it.get('id')}
        for it in view.items:
            bare = _bare(it.get('form') or '')
            if len(bare) < JOB_EVIDENCE_MIN_ENTRY or not any(bare in f for f in forms):
                continue
            value = entry_gloss(it, gloss)
            if not value and view.tree.senses_of(it['id']):
                continue  # its senses are listed, each with its gloss
            line = view.address(it['id'])
            if value:
                line += f' ‘{value}’'
            kind = item_morph_type(it, by_id)
            if kind:
                line += f' {kind}'
            if several:
                line += f' ({v["name"]})'
            out.append((bare, line))
    out.sort(key=lambda x: (x[1].casefold(), x[1]))
    return out


def block(ws, project: IgtProject, surfaces: Iterable[str], people: Dict[str, Dict[str, Dict[str, Any]]],
          mine: Dict[str, List[Dict[str, Any]]], render, budget: int = JOB_EVIDENCE_CHARS) -> str:
    """The block for the piece whose empty words have ``surfaces``.

    ``people`` is people's index as :meth:`IgtRunner.people_index` keeps it,
    ``mine`` the job's own decisions by the form they were looked up under,
    ``render(analysis)`` an analysis as one short line."""
    cfg = project.ignored_cfg
    forms = list(dict.fromkeys(f for f in (form_of(s, cfg) for s in surfaces) if f))
    if not forms:
        return ''
    theirs_by = regroup(people, cfg)
    ours_by: Dict[str, List[Dict[str, Any]]] = {}
    for key, rows in mine.items():
        ours_by.setdefault(form_of(key, cfg), []).extend(rows)
    analysed, nowhere = [], []
    for form in forms:
        bits = []
        theirs = sorted((theirs_by.get(form) or {}).values(), key=lambda x: -x['count'])[:JOB_PRECEDENT_PER_FORM]
        if theirs:
            bits.append('people: ' + '; '.join(f'{render(x["analysis"])} ({x["count"]})' for x in theirs))
        ours = sorted(ours_by.get(form) or [], key=lambda r: -(r.get('count') or 0))[:JOB_PRECEDENT_PER_FORM]
        if ours:
            bits.append('this job: ' + '; '.join(f'{render(r["analysis"])} ({r.get("count")})' for r in ours))
        if bits:
            analysed.append(f'- "{form}": ' + ' | '.join(bits))
        else:
            nowhere.append(form)
    entries = entry_lines(ws, project, forms)

    def size(lines):
        return sum(len(x) + 1 for x in lines)
    tail_room = 160  # the left-out line, whatever its numbers
    fixed = ([ANALYSED_HEAD] if analysed else []) + ([NOWHERE_HEAD + ', '.join(nowhere) + '.'] if nowhere else [])
    kept_analysed = list(analysed)
    while kept_analysed and size(fixed + kept_analysed) + tail_room > budget:
        kept_analysed.pop()
    room = budget - tail_room - size(fixed + kept_analysed) - len(ENTRIES_HEAD) - 1
    # Entries kept: the longest forms first, cut where the room ends.
    ranked = sorted(range(len(entries)), key=lambda i: (-len(entries[i][0]), i))
    keep, used = set(), 0
    for i in ranked:
        cost = len(entries[i][1]) + 1
        if used + cost > room:
            break
        keep.add(i)
        used += cost
    kept_entries = [line for i, (_, line) in enumerate(entries) if i in keep]
    left_entries = [entries[i][0] for i in range(len(entries)) if i not in keep]
    lines = []
    if kept_analysed:
        lines += [ANALYSED_HEAD, *kept_analysed]
    if nowhere:
        lines.append(NOWHERE_HEAD + ', '.join(nowhere) + '.')
    if kept_entries:
        lines += [ENTRIES_HEAD, *kept_entries]
    left = []
    if left_entries:
        short = min(len(x) for x in left_entries)
        long = max(len(x) for x in left_entries)
        span = f'{short}' if short == long else f'{short} to {long}'
        left.append(f'{len(left_entries)} lexicon entr{"y" if len(left_entries) == 1 else "ies"} of {span} '
                    f'letter{"" if span == "1" else "s"} (read_lexicon finds them)')
    if len(kept_analysed) < len(analysed):
        n = len(analysed) - len(kept_analysed)
        left.append(f'how {n} form{"" if n == 1 else "s"} were analysed (analyses_of reads them)')
    if left:
        lines.append('Left out for length: ' + ' and '.join(left) + '.')
    return '\n'.join(lines)
