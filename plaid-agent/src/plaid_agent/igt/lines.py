"""analyze_sentence: a sentence, or a run of its words, analysed from
interlinear lines, as a linguist writes them (AS, 2026-11-14).

The model writes a segmented line and a gloss line, words apart by spaces,
morphemes by ``-`` and ``=``. The tool lines them up against the sentence's
real words, refuses the sentence whole where they do not line up, and links
every morpheme to the one lexicon entry with its form and gloss. It was made
after run4 of the job pilot, where a job at low reasoning put each whole
sentence's morphemes on its first word in 5 of 20 sentences, and spent 390
of 530 calls looking entries up and linking them morpheme by morpheme.

It stages the plan ops the other tools stage, through them: set_analysis's
op for each word (``tools.word_analysis_op``), create_entry's
(``lexicon._create_entry``) and link_entry's (``tools.t_link_entry``). There
is no op kind of its own, so the card, the executor and a job's apply rule
see what they always saw.

The pieces a variant of this tool would change, each in one place:
- the linking rule: ``fit.fits`` (form as the pair picker finds it, gloss
  after NFC, type where the types line gives one), asked in :func:`_fits`;
- ``new_entries``: :func:`_stage_sentence`, where a morpheme no entry fits
  is created for, and :func:`_creatable`, which says when it may be;
- the surface check: ``tools.surface_misfit`` and ``tools.SURFACE_SLACK``;
- the answer's wording: :func:`_answer`, :func:`_lineup` and the problem
  texts in :func:`_check`; the manual: :data:`HELP`.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

from ..core.tools import ToolError

from .fit import collation_key, fits, nfc, spelled
from .lexicon import _create_entry
from .lexview import morph_type
from .project import IgtDoc, IgtProject
from .tools import parse_analysis, surface_misfit, t_link_entry, word_analysis_op
from .vocab import ROLE_GLOSS
from .workspace import Workspace

#: The word left as it is: this on every line.
PLACEHOLDER = '_'
#: A morpheme of the gloss, types or another field's line with no value.
NO_VALUE = '_'
#: Sentences in one call.
MAX_SENTENCES = 20
#: Morphemes listed as needing attention, and the entries listed for each.
MAX_LISTED, MAX_CANDIDATES, MAX_REFS = 12, 4, 6

_REF = re.compile(r'^\s*s(\d+)(?:\.w(\d+)(?:\s*-\s*w?(\d+))?)?\s*$', re.IGNORECASE)
_SPLIT = re.compile(r'([-=])')

HELP = '''analyze_sentence: a sentence, or a run of its words, from interlinear lines.

Lines. forms is the segmented line and gloss the gloss line, as a linguist writes them: one word of the \
sentence per space-separated word, in order, and its morphemes apart by "-", or by "=" at a clitic \
boundary. Every line has as many words as the ref has, and each word as many morphemes on every line. \
Punctuation on a word is not part of its forms.
  ref "s4", forms "na-ku-ja le=o", gloss "PRS-INF-come today=DEF"
ref "s4.w3-w5" is a run of words of one sentence.
_ as a whole word on every line leaves that word as it is. _ for one morpheme on the gloss, types or a \
field line gives it no value. A form or gloss holding "-", "=", "_" or a space cannot be written here: \
put _ for that word and analyse it with set_analysis.

Types. types is an optional aligned line of morph types (stem, prefix, suffix, enclitic, ...). A linked \
morpheme goes by its entry's type. A morpheme with neither takes none, except one after "=", which \
the clitic rule types as set_analysis types it.

Other morpheme fields. fields maps a field name to its aligned line, e.g. {"POS": "v-asp"}.

Links. Each glossed morpheme is linked to the one lexicon entry, or sense, whose form is its form and \
whose gloss is its gloss (and whose type is its type, where types gives one). Where several fit, or \
none does, nothing is linked and the answer lists the morpheme with the entries to choose from: link one \
with link_entry (sN.wN.mN, entry_id). new_entries: true creates an entry, once, for each form and gloss \
no entry has, and links every morpheme of it. An ambiguous one is never created for.

Checks. A sentence whose lines do not line up, or a word whose forms are more than twice as long as the \
word plus 3, is not staged at all, and the answer shows its words beside what was given. A word \
whose forms differ from it otherwise is staged, with a note.

Several sentences: sentences=[{ref, forms, gloss, types?, fields?}, ...], up to 20, each staged or \
refused on its own.'''


class _Refused(Exception):
    """A sentence not staged, with what the answer says of it."""


def t_analyze_sentence(ws: Workspace, document: Optional[str] = None, ref: Optional[str] = None,
                       forms: Optional[str] = None, gloss: Optional[str] = None, types: Optional[str] = None,
                       fields: Optional[dict] = None, sentences: Optional[list] = None,
                       new_entries: bool = False, lexicon: Optional[str] = None, help: bool = False) -> str:
    if help:
        return HELP
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.', kind='not-found')
    one = {k: v for k, v in (('ref', ref), ('forms', forms), ('gloss', gloss), ('types', types),
                             ('fields', fields)) if v is not None}
    if sentences is not None and one:
        raise ToolError('Give ref, forms and gloss, or sentences (a list of them), not both.',
                        kind='invalid-argument')
    items = list(sentences) if sentences is not None else [one]
    if not items or items == [{}]:
        raise ToolError('Give ref, forms and gloss. help: true explains the lines.', kind='invalid-argument')
    if len(items) > MAX_SENTENCES:
        raise ToolError(f'At most {MAX_SENTENCES} sentences per call: split the list.', kind='too-large')
    if not document:
        raise ToolError('Give document.', kind='invalid-argument')
    doc = ws.doc(document)
    before = {id(o) for o in ws.ops}
    said: List[str] = []
    notes: List[str] = []
    listed: Dict[tuple, Dict[str, Any]] = {}
    made: List[str] = []
    staged_any = False
    for item in items:
        if not isinstance(item, dict):
            said.append('A sentence is {ref, forms, gloss}: not staged.')
            continue
        try:
            line, word_notes = _stage_sentence(ws, doc, item, bool(new_entries), lexicon, listed, made)
            said.append(line)
            notes += word_notes
            staged_any = True
        except _Refused as e:
            said.append(str(e))
        except (ToolError, ValueError) as e:
            said.append(f'{item.get("ref") or "A sentence"} not staged: {e}')
    if not staged_any:
        raise ToolError('\n'.join(said), kind='invalid-argument')
    n = sum(1 for o in ws.ops if id(o) not in before)
    return _answer(ws, n, said, notes, listed, made, bool(new_entries))


def _words_of(doc: IgtDoc, ref: str):
    """``(label, sentence, words)`` a ref names: a sentence, or a run of its
    words."""
    m = _REF.match(str(ref or ''))
    if not m:
        raise _Refused(f'{ref or "(no ref)"} not staged: a ref is a sentence ("s4") or a run of its words '
                       '("s4.w3-w5").')
    si = int(m.group(1))
    if not 1 <= si <= len(doc.sentences):
        raise _Refused(f's{si} not staged: document {doc.quoted} has {len(doc.sentences)} sentences.')
    s = doc.sentences[si - 1]
    if m.group(2) is None:
        return f's{si}', s, list(s.words)
    a = int(m.group(2))
    b = int(m.group(3)) if m.group(3) else a
    if not 1 <= a <= b <= len(s.words):
        raise _Refused(f'{ref} not staged: s{si} has {len(s.words)} words (w1 to w{len(s.words)}).')
    return f's{si}.w{a}-w{b}' if b > a else f's{si}.w{a}', s, s.words[a - 1:b]


def _pieces(word: str) -> Tuple[List[str], List[str]]:
    """A word of a line cut at its delimiters: the pieces, and the delimiter
    before each piece after the first."""
    parts = _SPLIT.split(word)
    return parts[0::2], parts[1::2]


def _lines(ws: Workspace, item: Dict[str, Any]):
    """``[(name, line words, field)]``: the forms line first, then the gloss
    line, types, and every other field's line, ``field`` None for forms and
    types."""
    g = ws.project.gloss_field('Morpheme')
    out = [('forms', str(item.get('forms') or '').split(), None)]
    if item.get('gloss') is not None:
        if g is None:
            raise ToolError('This project has no morpheme field for glosses.', kind='not-found')
        out.append(('gloss', str(item['gloss']).split(), g))
    elif g is not None:
        raise ToolError('Give gloss, the gloss line.', kind='invalid-argument')
    if item.get('types') is not None:
        out.append(('types', str(item['types']).split(), None))
    extra = item.get('fields') or {}
    if not isinstance(extra, dict):
        raise ToolError('fields maps a morpheme field name to its line, e.g. {"POS": "v-asp"}.',
                        kind='invalid-argument')
    for name, line in extra.items():
        f = ws.project.field(name)
        if f.scope != 'Morpheme':
            raise ToolError(f'"{f.name}" is a {f.scope} field: set_field sets it.', kind='invalid-argument')
        if g is not None and f.layer_id == g.layer_id:
            raise ToolError(f'"{f.name}" is the gloss line: give it as gloss.', kind='invalid-argument')
        out.append((f.name, str(line or '').split(), f))
    return out


def _check(ws: Workspace, label: str, words, lines) -> Tuple[List[str], List[Optional[list]]]:
    """``(problems, parsed)``: what keeps the lines from lining up with
    ``words``, and per word its morphemes (None for one left as it is), each
    ``(form, delimiter before, {line name: value})``."""
    n = len(words)
    problems = [f'{name} has {len(ws_)} word{"s" if len(ws_) != 1 else ""}, {label} has {n}'
                for name, ws_, _f in lines if len(ws_) != n]
    if problems:
        return problems, []
    parsed: List[Optional[list]] = []
    cfg = ws.project.ignored_cfg
    for i, w in enumerate(words):
        at = f'w{w.index}'
        given = {name: line[i] for name, line, _f in lines}
        if given['forms'] == PLACEHOLDER:
            off = [name for name, v in given.items() if v != PLACEHOLDER]
            if off:
                problems.append(f'{at}: _ in forms and not in {", ".join(off)}')
            parsed.append(None)
            continue
        forms, delims = _pieces(given['forms'])
        bad = False
        if any(f == '' for f in forms):
            problems.append(f'{at}: an empty morpheme in "{given["forms"]}"')
            bad = True
        cut = {}
        for name, v in given.items():
            if name == 'forms':
                continue
            pieces, _ = _pieces(v)
            if len(pieces) != len(forms):
                problems.append(f'{at}: {len(forms)} form{"s" if len(forms) != 1 else ""}, {len(pieces)} in {name}')
                bad = True
            elif any(p == '' for p in pieces):
                problems.append(f'{at}: an empty morpheme in {name} "{v}"')
                bad = True
            cut[name] = pieces
        if 'types' in cut and not bad:
            for t in cut['types']:
                if t != NO_VALUE:
                    try:
                        morph_type(t)
                    except ToolError:
                        problems.append(f'{at}: no morph type "{t}"')
                        bad = True
        if not bad:
            misfit = surface_misfit(w.surface, forms, cfg)
            if misfit:
                problems.append(f'{at}: {misfit}')
                bad = True
        parsed.append(None if bad else [(f, delims[k - 1] if k else '', {name: cut[name][k] for name in cut})
                                        for k, f in enumerate(forms)])
    return problems, parsed


def _lineup(words, lines) -> List[str]:
    """The sentence's words, numbered, beside what each line gave them."""
    shown = [(name, line) for name, line, _f in lines if name in ('forms', 'gloss')]
    out = []
    for p in range(max([len(words)] + [len(line) for _n, line in shown])):
        w = words[p] if p < len(words) else None
        head = f'  w{w.index} {w.surface}' if w is not None else '  (no word)'
        out.append(head + ''.join(f' | {line[p] if p < len(line) else "(none)"}' for _n, line in shown))
    return out


def _stage_sentence(ws: Workspace, doc: IgtDoc, item: Dict[str, Any], new_entries: bool, lexicon: Optional[str],
                    listed: Dict[tuple, Dict[str, Any]], made: List[str]) -> Tuple[str, List[str]]:
    """Stage one sentence: every word's analysis, the entries to create, the
    links. All of it or none of it."""
    label, s, words = _words_of(doc, item.get('ref'))
    if not words:
        raise _Refused(f'{label} not staged: it has no words.')
    lines = _lines(ws, item)
    problems, parsed = _check(ws, label, words, lines)
    if problems:
        raise _Refused('\n'.join([f'{label} not staged: ' + '; '.join(problems) + '.'] + _lineup(words, lines)))
    if all(p is None for p in parsed):
        raise _Refused(f'{label} not staged: every word is _.')
    fields = {name: f for name, _l, f in lines if f is not None}
    g = next((f for name, _l, f in lines if name == 'gloss'), None)
    notes: List[str] = []
    found: Dict[tuple, Dict[str, Any]] = {}
    created: List[str] = []
    with ws.staging():
        n_analysed = 0
        for w, morphs in zip(words, parsed):
            if morphs is None:
                continue
            ref = f's{s.index}.w{w.index}'
            given = [{'form': form, 'equals': delim == '=',
                      **({'type': cut['types']} if cut.get('types', NO_VALUE) != NO_VALUE else {}),
                      'fields': {fields[name].name: v for name, v in cut.items()
                                 if name in fields and v != NO_VALUE}}
                     for form, delim, cut in morphs]
            op, note = word_analysis_op(ws, doc, ref, parse_analysis(ws, given))
            ws.add_ops([op])
            n_analysed += 1
            if note:
                notes.append(f'{ref} {w.surface} | {"".join(d + f for f, d, _c in morphs)}: forms differ from '
                             'the word (allowed for allomorphy).')
        links: Dict[str, List[str]] = {}
        creates = 0
        for w, morphs in zip(words, parsed):
            for k, (form, _d, cut) in enumerate(morphs or [], start=1):
                value = cut.get('gloss', NO_VALUE)
                if g is None or value == NO_VALUE:
                    continue
                stated = cut.get('types', NO_VALUE)
                kind = morph_type(stated) if stated != NO_VALUE else None
                mref = f's{s.index}.w{w.index}.m{k}'
                hits = _fits(ws, form, value, kind)
                if not hits and new_entries and _creatable(ws, form, value):
                    v = _lexicon_for_new(ws, lexicon)
                    key = IgtProject.lexicon_field(v, ROLE_GLOSS)
                    if not key:
                        raise ToolError(f'new_entries: lexicon "{v["name"]}" has no gloss field.',
                                        kind='invalid-argument')
                    _create_entry(ws, v, form, {key: value}, kind, None)
                    creates += 1
                    created.append(f'{form} ‘{value}’')
                    hits = _fits(ws, form, value, kind)
                if len(hits) == 1:
                    links.setdefault(hits[0][1], []).append(mref)
                    continue
                key = (collation_key(form), nfc(value), kind)
                entry = found.setdefault(key, {'form': form, 'gloss': value, 'refs': [], 'hits': hits})
                entry['refs'].append(mref)
        n_links = 0
        for target, refs in links.items():
            t_link_entry(ws, doc.id, refs, entry_id=target)
            n_links += len(refs)
    made += created
    for key, entry in found.items():
        into = listed.setdefault(key, {**entry, 'refs': []})
        into['refs'] += entry['refs']
    counts = [f'{n_analysed} word{"s" if n_analysed != 1 else ""} analysed',
              f'{n_links} link{"s" if n_links != 1 else ""}']
    if creates:
        counts.append(f'{creates} entr{"ies" if creates != 1 else "y"} to create')
    return f'{label}: ' + ', '.join(counts) + '.', notes


def _items_of(ws: Workspace, v: dict) -> List[dict]:
    """Lexicon ``v``'s entries as the plan leaves them, and the entries this
    plan creates in it."""
    return list(ws.view(v).items) + [{'form': e['form'], 'metadata': e.get('metadata') or {}, 'key': k}
                                     for k, e in ws.new_entries.items() if e.get('vocab_id') == v['id']]


def _fits(ws: Workspace, form: str, gloss: str, kind: Optional[str]) -> List[tuple]:
    """``[(lexicon, entry id or new entry key, entry)]``: the entries of
    every lexicon of the project that fit (``fit.fits``)."""
    out = []
    for v in ws.project.vocabs:
        for it in fits(v, _items_of(ws, v), form, gloss, kind):
            out.append((v, it.get('id') or it.get('key'), it))
    return out


def _creatable(ws: Workspace, form: str, gloss: str) -> bool:
    """Whether ``new_entries`` creates an entry for this form and gloss: no
    entry of any lexicon has that form and that gloss, whatever its type."""
    return not _fits(ws, form, gloss, None)


def _lexicon_for_new(ws: Workspace, lexicon: Optional[str]) -> dict:
    if lexicon:
        return ws.project.vocab(lexicon)
    own = [v for v in ws.project.vocabs if not v.get('borrowed')]
    if len(own) == 1:
        return own[0]
    raise ToolError('new_entries: name the lexicon new entries go in (lexicon): '
                    + (', '.join(v['name'] for v in own) if own else 'this project has none of its own') + '.',
                    kind='ambiguous')


def _answer(ws: Workspace, n: int, said: List[str], notes: List[str], listed: Dict[tuple, Dict[str, Any]],
            made: List[str], new_entries: bool) -> str:
    out = [ws.planned_note(n)] + said + notes
    several = [e for e in listed.values() if len(e['hits']) > 1]
    none = [e for e in listed.values() if not e['hits']]
    shown = 0

    def head(e) -> str:
        refs = e['refs'][:MAX_REFS]
        more = len(e['refs']) - len(refs)
        return (f'  {e["form"]} ‘{e["gloss"]}’ ×{len(e["refs"])} ({", ".join(refs)}'
                + (f' and {more} more' if more else '') + ')')

    if several:
        out.append('Several entries fit, nothing linked (link_entry with one entry_id):')
        for e in several:
            if shown >= MAX_LISTED:
                break
            shown += 1
            out.append(head(e) + ':')
            out += ['  ' + line for line in _candidate_lines(ws, e['hits'])]
    if none:
        out.append('No entry fits, nothing linked:')
        for e in none:
            if shown >= MAX_LISTED:
                break
            shown += 1
            out.append(head(e) + '.' + _none_detail(ws, e['form'], e['gloss']))
    if shown < len(several) + len(none):
        out.append(f'{len(several) + len(none) - shown} more not listed.')
    if none and not new_entries:
        new = sum(1 for e in none if _creatable(ws, e['form'], e['gloss']))
        if new:
            out.append(f'new_entries: true creates {new} of them.')
    if made:
        out.append('New entries: ' + ', '.join(made[:MAX_LISTED])
                   + (f' and {len(made) - MAX_LISTED} more' if len(made) > MAX_LISTED else '') + '.')
    return '\n'.join(out)


def _candidate_lines(ws: Workspace, hits: List[tuple]) -> List[str]:
    existing = [(v, it) for v, _t, it in hits if it.get('id')]
    news = [(it['key'], ws.new_entries[it['key']]) for _v, _t, it in hits if not it.get('id')]
    lines = ws.entry_lines(existing, news)
    return lines[:MAX_CANDIDATES] + ([f'  and {len(lines) - MAX_CANDIDATES} more'] if len(lines) > MAX_CANDIDATES
                                     else [])


def _none_detail(ws: Workspace, form: str, gloss: str) -> str:
    """For a morpheme no entry fits: the entries spelled as it is (other
    glosses or types), else the headwords spelled close to it."""
    same = [(v, it) for v in ws.project.vocabs for it in spelled(v, ws.view(v).items, form)]
    if same:
        lines = ws.entry_lines(same[:MAX_CANDIDATES], [])
        return (' Spelled so:\n' + '\n'.join('  ' + line for line in lines)
                + (f'\n    and {len(same) - MAX_CANDIDATES} more' if len(same) > MAX_CANDIDATES else ''))
    close, more = ws.spelled_close(form, ws.project.vocabs, limit=MAX_CANDIDATES)
    if close:
        return ' Close: ' + ', '.join(close) + (f', and {more} more' if more else '') + '.'
    return ''

