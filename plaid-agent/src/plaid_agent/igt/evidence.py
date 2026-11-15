"""What a piece of a job planned in sentences is handed besides its sentences
(BRIEF-EV): the evidence its model would otherwise look up one form at a time,
computed by the worker with no model, from the project as it is when the
piece starts.

Three parts, in this order, each a fixed rule:

- how each form of the piece's empty words was analysed before, by people in
  the project and earlier in this job (the job's precedent, up to
  ``JOB_PRECEDENT_PER_FORM`` analyses from each source), a form read as the
  surface check reads a word: without the punctuation the project's
  ignored-token rule trims off its edges, by ``fit.surface_key``;
- one line naming the forms nobody analysed, so the model need not ask;
- every lexicon entry (senses included, every lexicon of the project) whose
  form, by the key every tool names an entry by (``fit.form_key``), is
  spelled inside one of those forms and is at least
  ``JOB_EVIDENCE_MIN_ENTRY`` characters long: one line each, the entry as a
  tool names it back, its gloss and its morph type. A headword with no
  gloss of its own and senses under it is left out: its senses are listed.

The whole is at most ``JOB_EVIDENCE_CHARS`` characters. What does not fit is
cut in a fixed order: entries first, the shortest forms first (the last in
order among forms of one length), then analysed forms from the last, then the
forms analysed nowhere from the last ("and N more"), and one line says what
was left out and which tool reads it.
"""

from typing import Any, Dict, Iterable, List, Optional

from ..core.limits import JOB_EVIDENCE_CHARS, JOB_EVIDENCE_MIN_ENTRY, JOB_PRECEDENT_PER_FORM
from . import fit
from .fit import entry_gloss, item_morph_type, surface_key
from .project import IgtProject
from .tools import trim_ignored_edges
from .vocab import ROLE_GLOSS

#: The block's lines, as the model reads them.
ANALYSED_HEAD = 'How these forms were analysed before (by people in this project, and earlier in this job):'
NOWHERE_HEAD = 'Analysed nowhere before: '
ENTRIES_HEAD = 'Lexicon entries spelled inside these forms (form ‘gloss’ type):'


def form_of(surface: str, cfg) -> str:
    """A word's form as the block keys it: the surface without the edge
    punctuation the ignored-token rule trims, by the key the job's decisions
    and people's index are kept by (``fit.surface_key``)."""
    return surface_key(trim_ignored_edges(surface or '', cfg))


def _bare(form: str) -> str:
    """An entry's form as it is looked for inside a word: the key a form
    names an entry by (``fit.form_key``), so the block lists only entries a
    morpheme spelled so can link to (EV2)."""
    return fit.form_key(form)


def regroup(index: Dict[str, Dict[str, Dict[str, Any]]], cfg) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """People's index (surface_key of the surface -> {key: {analysis, count}})
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


class FieldEvidence:
    """What the block shows for one field the job fills (a word or a
    morpheme field): the forms of its empty units, and the values the field
    holds on other units of the same form, people's and this job's, each
    ``form key -> {value: count}`` by :func:`form_of` of the unit's form."""

    def __init__(self, name: str, level: str, surfaces: Iterable[str], people: Dict[str, Dict[str, int]],
                 mine: Dict[str, Dict[str, int]], lexicon: bool = False):
        self.name, self.level, self.surfaces = name, level, list(surfaces)
        self.people, self.mine, self.lexicon = people, mine, lexicon


def _counts(index: Dict[str, Dict[str, int]], cfg) -> Dict[str, Dict[str, int]]:
    out: Dict[str, Dict[str, int]] = {}
    for surface, values in index.items():
        form = form_of(surface, cfg)
        for v, n in values.items():
            out.setdefault(form, {})
            out[form][v] = out[form].get(v, 0) + n
    return out


def _top(values: Dict[str, int]) -> str:
    ranked = sorted(values.items(), key=lambda kv: (-kv[1], kv[0]))[:JOB_PRECEDENT_PER_FORM]
    return '; '.join(f'{v} ({n})' for v, n in ranked)


def block(ws, project: IgtProject, surfaces: Iterable[str], people: Dict[str, Dict[str, Dict[str, Any]]],
          mine: Dict[str, List[Dict[str, Any]]], render, budget: int = JOB_EVIDENCE_CHARS,
          lexicon: bool = True, fields: Iterable[FieldEvidence] = (), nowhere: bool = True) -> str:
    """The block for the piece whose words empty of segmentation have
    ``surfaces``, and whose units empty in each field it fills are named by
    ``fields`` (:class:`FieldEvidence`, one section each, after the
    analyses).

    ``people`` is people's index as :meth:`IgtRunner.people_index` keeps it,
    ``mine`` the job's own decisions by the form they were looked up under,
    ``render(analysis)`` an analysis as one short line. ``lexicon``: the
    entries spelled inside the forms of the analyses and of a field linked
    to the lexicon are listed (a target linked to the lexicon). The
    precedent of a document's or a selection's piece is this block without
    the forms filled nowhere (``nowhere`` False) and the entries: one code
    path."""
    return _block(ws, project, surfaces, people, mine, render, budget, lexicon, list(fields), nowhere=nowhere)


def _block(ws, project, surfaces, people, mine, render, budget, lexicon, fields, nowhere=True) -> str:
    cfg = project.ignored_cfg
    sections = []  # (head, nowhere head, lines, forms nowhere, left-out text)
    forms = list(dict.fromkeys(f for f in (form_of(s, cfg) for s in surfaces) if f))
    entry_forms = list(forms)
    if forms:
        theirs_by = regroup(people, cfg)
        ours_by: Dict[str, List[Dict[str, Any]]] = {}
        for key, rows in mine.items():
            ours_by.setdefault(form_of(key, cfg), []).extend(rows)
        analysed, none = [], []

        def lines(rows):
            """Analyses as their lines with their counts, most first: two
            that read as the same line (differing only in what the line does
            not show, a word field) are one line, their counts summed
            (REV-DAY-S-15)."""
            by: Dict[str, int] = {}
            for x in rows:
                line = render(x['analysis'])
                by[line] = by.get(line, 0) + (x.get('count') or 0)
            return '; '.join(f'{line} ({n})' for line, n in
                             sorted(by.items(), key=lambda kv: -kv[1])[:JOB_PRECEDENT_PER_FORM])
        for form in forms:
            bits = []
            theirs = list((theirs_by.get(form) or {}).values())
            if theirs:
                bits.append('people: ' + lines(theirs))
            ours = ours_by.get(form) or []
            if ours:
                bits.append('this job: ' + lines(ours))
            if bits:
                analysed.append(f'- "{form}": ' + ' | '.join(bits))
            else:
                none.append(form)
        sections.append((ANALYSED_HEAD, NOWHERE_HEAD, analysed, none,
                         lambda n: f'how {n} form{"" if n == 1 else "s"} were analysed (analyses_of reads them)'))
    for fe in fields:
        fforms = list(dict.fromkeys(f for f in (form_of(s, cfg) for s in fe.surfaces) if f))
        if not fforms:
            continue
        if fe.lexicon:
            entry_forms += [f for f in fforms if f not in entry_forms]
        theirs_v, ours_v = _counts(fe.people, cfg), _counts(fe.mine, cfg)
        lines, none = [], []
        for form in fforms:
            bits = []
            if theirs_v.get(form):
                bits.append('people: ' + _top(theirs_v[form]))
            if ours_v.get(form):
                bits.append('this job: ' + _top(ours_v[form]))
            if bits:
                lines.append(f'- "{form}": ' + ' | '.join(bits))
            else:
                none.append(form)
        units = f'{fe.level}s'
        sections.append((f'{fe.name} on other {units} of these forms (by people in this project, and earlier in '
                         'this job):', f'{fe.name} on no other {fe.level} of: ', lines, none,
                         lambda n, name=fe.name: f'the {name} of {n} form{"" if n == 1 else "s"}'))
    if not sections:
        return ''
    if not nowhere:
        sections = [(h, nh, lines, [], left) for h, nh, lines, _, left in sections]
    entries = entry_lines(ws, project, entry_forms) if lexicon else []

    def size(lines):
        return sum(len(x) + 1 for x in lines)
    tail_room = 160  # the left-out line, whatever its numbers
    # The forms filled nowhere go last of all, from the last, so the bound
    # holds whatever the piece.
    shown = [list(sec[3]) for sec in sections]

    def nowhere_line(i):
        none = sections[i][3]
        more = len(none) - len(shown[i])
        return sections[i][1] + ', '.join(shown[i]) + (f' and {more} more' if more else '') + '.'

    def nowhere_size():
        return sum(len(nowhere_line(i)) + len(sections[i][0]) + 2 for i in range(len(sections)) if sections[i][3])
    while any(shown) and nowhere_size() + tail_room > budget:
        shown[max(i for i in range(len(shown)) if shown[i])].pop()
    fixed = [x for i, sec in enumerate(sections) for x in ([sec[0]] if sec[2] else []) + (
        [nowhere_line(i)] if sec[3] else [])]
    kept = [list(sec[2]) for sec in sections]
    while any(kept) and size(fixed + [x for k in kept for x in k]) + tail_room > budget:
        kept[max(i for i in range(len(kept)) if kept[i])].pop()
    room = budget - tail_room - size(fixed + [x for k in kept for x in k]) - len(ENTRIES_HEAD) - 1
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
    for i, sec in enumerate(sections):
        if kept[i]:
            lines += [sec[0], *kept[i]]
        if sec[3]:
            lines.append(nowhere_line(i))
    if kept_entries:
        lines += [ENTRIES_HEAD, *kept_entries]
    left = []
    if left_entries:
        short = min(len(x) for x in left_entries)
        long = max(len(x) for x in left_entries)
        span = f'{short}' if short == long else f'{short} to {long}'
        left.append(f'{len(left_entries)} lexicon entr{"y" if len(left_entries) == 1 else "ies"} of {span} '
                    f'letter{"" if span == "1" else "s"} (read_lexicon finds them)')
    for i, sec in enumerate(sections):
        if len(kept[i]) < len(sec[2]):
            left.append(sec[4](len(sec[2]) - len(kept[i])))
    if left:
        lines.append('Left out for length: ' + ' and '.join(left) + '.')
    return '\n'.join(lines)
