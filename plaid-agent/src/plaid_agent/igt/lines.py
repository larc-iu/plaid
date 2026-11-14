"""analyze_sentence: sentences, or runs of their words, analysed word by
word (AS, 2026-11-14, the v3 shape).

The model gives one item per word, "FORMS GLOSS" (morphemes apart by ``-``
and ``=``), so a word's forms and gloss are paired where it writes them and
two parallel lines cannot drift (v3, after the Natugu night runs). The tool
lines the items up against the sentence's real words, and links
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
  after NFC), asked in :func:`_fits`;
- ``new_entries``: :func:`_stage_sentence`, where a morpheme no entry fits
  is created for, and :func:`_creatable`, which says when it may be;
- the surface check: ``tools.surface_misfit`` and ``tools.SURFACE_SLACK``;
- the answer's wording: :func:`_answer`, :func:`_lineup`, :func:`_word_lines`
  and the problem texts in :func:`_check`; the manual: :data:`HELP`.
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.igt.ignored import is_token_ignored

from ..core.tools import ToolError

from .fit import collation_key, fits, nfc, spelled
from .lexicon import _create_entry
from .project import IgtDoc, IgtProject
from .retyped import renumbering
from .tools import ANALYSIS_OF, FITTED_TO, NEW_ENTRY, confirm_hint, entries_note, held_chain, parse_analysis, surface_misfit, t_link_entry, word_analysis_op
from .vocab import ROLE_GLOSS
from .workspace import Workspace

#: The word left as it is: this on every line.
PLACEHOLDER = '_'
#: A morpheme of the gloss or another field's line with no value.
NO_VALUE = '_'
#: Sentences in one call.
MAX_SENTENCES = 20
#: Morphemes listed as needing attention, and the entries listed for each.
MAX_LISTED, MAX_CANDIDATES, MAX_REFS = 12, 4, 6

_REF = re.compile(r'^\s*s(\d+)(?:\.w(\d+)(?:\s*-\s*w?(\d+))?)?\s*$', re.IGNORECASE)
_SPLIT = re.compile(r'([-=])')

HELP = '''analyze_sentence: sentences, or runs of their words, analysed word by word.

sentences is a list of {ref, words}. ref is a sentence ("s4") or a run of its words ("s4.w3-w5"). words \
has one item per word of the ref, in order, each "FORMS GLOSS": the word's morphemes apart by "-", or by \
"=" at a clitic boundary, one space, and their glosses apart the same way.
  {"ref": "s4", "words": ["na-ku-ja PRS-INF-come", "le=o today=DEF"]}
"_" as an item leaves that word as it is. "_" as one gloss of a word gives that morpheme none. A form or \
gloss holding a space, "-", "=" or "_" cannot be written here: give "_" and use set_analysis. \
Punctuation on a word is not part of its forms.

Other morpheme fields: columns names an item's columns, e.g. "columns": ["forms", "gloss", "POS"] and \
items like "na-ku-ja PRS-INF-come v-asp-v".

Types. A linked morpheme goes by its entry's type, and one after "=" is typed as a clitic. The rest \
take none: set_morpheme sets a type where one is needed.

Links. Each glossed morpheme is linked to the one lexicon entry, or sense, whose form is its form and \
whose gloss is its gloss. Where several fit, or none does, nothing is linked and the answer lists the \
morpheme with the entries to choose from: link one with link_entry (sN.wN.mN, entry_id). new_entries: \
true, only when the instructions or the user ask for new entries, creates an entry, once, for each form \
and gloss no entry has (the form as given, never for a gloss of ?), and links every morpheme of it. \
An ambiguous one is never created for.

Checks. An item of punctuation alone is left out. Then the items must be as many as the ref's words, \
and item n is word n's: another number stages nothing of the sentence, and the answer shows the words \
beside the items. A word whose forms and gloss differ in morphemes, hold an empty one, or are over \
twice the word's length plus 3, is listed and not staged: the other words are. Forms that differ from \
the word otherwise are staged with a note. A word given the morphemes it holds, as many, of the same \
forms and joints, keeps them: only values that differ and links of unlinked morphemes are staged. Up \
to 20 sentences a call, each on its own.'''

#: An item's columns when a sentence names none.
COLUMNS = ['forms', 'gloss']


class _Refused(Exception):
    """A sentence not staged, with what the answer says of it."""


def t_analyze_sentence(ws: Workspace, document: Optional[str] = None, sentences: Optional[list] = None,
                       new_entries: bool = False, lexicon: Optional[str] = None, help: bool = False) -> str:
    if help:
        return HELP
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.', kind='not-found')
    if not document:
        raise ToolError('Give document.', kind='invalid-argument')
    if not isinstance(sentences, list) or not sentences:
        raise ToolError('Give sentences, a list of {ref, words}, e.g. [{"ref": "s4", "words": '
                        '["na-ku-ja PRS-INF-come", "le=o today=DEF"]}].', kind='invalid-argument')
    if len(sentences) > MAX_SENTENCES:
        raise ToolError(f'At most {MAX_SENTENCES} sentences per call: split the list.', kind='too-large')
    doc = ws.doc(document)
    before = {id(o) for o in ws.ops}
    said: List[str] = []
    notes: List[str] = []
    listed: Dict[tuple, Dict[str, Any]] = {}
    made: List[str] = []
    taken: set = set()
    staged_any = False
    for item in sentences:
        if not isinstance(item, dict):
            said.append('A sentence is {ref, words}: not staged.')
            continue
        try:
            line, word_notes = _stage_sentence(ws, doc, item, bool(new_entries), lexicon, listed, made, taken)
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
    return _answer(ws, n, said, notes, listed, made)


def _words_of(ws: Workspace, doc: IgtDoc, ref: str):
    """``(label, sentence, words)`` a ref names: a sentence, or a run of its
    words. A run is named by numbers only, so one whose words a split, merge
    or word delete the plan holds renumbers is refused
    (``retyped.renumbering``)."""
    if not str(ref or '').strip():
        raise _Refused('A sentence not staged: give ref, the sentence ("s4") or a run of its words ("s4.w3-w5"), '
                       'e.g. "ref": "s4".')
    m = _REF.match(str(ref or ''))
    if not m:
        raise _Refused(f'{ref} not staged: a ref is a sentence ("s4") or a run of its words ("s4.w3-w5").')
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
    label = f's{si}.w{a}-w{b}' if b > a else f's{si}.w{a}'
    moved = next((m for m in (renumbering(ws, s, w) for w in s.words[a - 1:b]) if m), None)
    if moved is not None:
        raise _Refused(f'{label} not staged: this plan\'s {moved[0]} renumbers s{si}, so these numbers name other '
                       'words once it is applied. Analyze these words once the plan is applied.')
    return label, s, s.words[a - 1:b]


def _punctuation(item: str, cfg) -> bool:
    """An item that is no word: every space-separated part of it a token
    the project's ignored-token rule ignores (``is_token_ignored``, the rule
    that numbers the words). "_" is the placeholder, never punctuation."""
    parts = item.split()
    return bool(parts) and item.strip() != PLACEHOLDER and all(is_token_ignored(p, cfg) for p in parts)


def _pieces(word: str) -> Tuple[List[str], List[str]]:
    """A column of an item cut at its delimiters: the pieces, and the
    delimiter before each piece after the first."""
    parts = _SPLIT.split(word)
    return parts[0::2], parts[1::2]


def _columns(ws: Workspace, item: Dict[str, Any], label: str):
    """``[(name, field)]``: what each column of an item is, "forms" first,
    ``field`` None for it. The gloss field's own name is the gloss."""
    names = item.get('columns') or COLUMNS
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise _Refused(f'{label} not staged: columns is a list of names, e.g. ["forms", "gloss", "POS"].')
    g = ws.project.gloss_field('Morpheme')
    out = []
    for name in names:
        key = name.strip().lower()
        if key == 'forms':
            out.append(('forms', None))
            continue
        if key == 'gloss' and g is not None:
            out.append(('gloss', g))
            continue
        f = ws.project.field(name)
        if f.scope != 'Morpheme':
            raise _Refused(f'{label} not staged: "{f.name}" is a {f.scope} field: set_field sets it.')
        out.append(('gloss' if g is not None and f.layer_id == g.layer_id else f.name, f))
    names = [n for n, _f in out]
    if names[:1] != ['forms'] or len(set(names)) != len(names) or (g is not None and 'gloss' not in names):
        raise _Refused(f'{label} not staged: columns starts with "forms", has "gloss", and names each once.')
    return out


def _parse_item(text: str, names: List[str], word, cfg):
    """``(morphemes, wrong)`` of one word's item: its morphemes as
    ``(form, delimiter before, {column name: value})``, or None with what is
    wrong (and None, [] for the placeholder)."""
    if not isinstance(text, str):
        return None, ['an item is one string, "FORMS GLOSS"']
    text = text.strip()
    if text == PLACEHOLDER:
        return None, []
    cols = text.split()
    if len(cols) != len(names):
        return None, [f'{len(cols)} column{"s" if len(cols) != 1 else ""}, give "{" ".join(n.upper() for n in names)}"'
                      ' with one space between and none inside']
    given = dict(zip(names, cols))
    wrong: List[str] = []
    forms, delims = _pieces(given['forms'])
    if any(f == '' for f in forms):
        wrong.append(f'an empty morpheme in "{given["forms"]}"')
    cut = {}
    for name in names[1:]:
        pieces, _ = _pieces(given[name])
        if len(pieces) != len(forms):
            wrong.append(f'{len(forms)} form{"s" if len(forms) != 1 else ""}, {len(pieces)} in {name}')
        elif any(p == '' for p in pieces):
            wrong.append(f'an empty morpheme in {name} "{given[name]}"')
        cut[name] = pieces
    if not wrong:
        misfit = surface_misfit(word.surface, forms, cfg)
        if misfit:
            wrong.append(misfit)
    if wrong:
        return None, wrong
    return [(f, delims[k - 1] if k else '', {name: cut[name][k] for name in cut}) for k, f in enumerate(forms)], []


def _check(ws: Workspace, label: str, words, items: List[str], columns):
    """``(problems, parsed, bad)``: what keeps the items from lining up with
    ``words`` as a whole (another number of items than words, which refuses
    the sentence), per word its morphemes (None for one left as it is or not
    staged), each ``(form, delimiter before, {column name: value})``, and
    per word not staged ``(its item, what is wrong)`` by its place.

    By place only (the landing round, REV-LAS-1): item n is word n's."""
    n = len(words)
    if len(items) != n:
        return [f'words has {len(items)} item{"s" if len(items) != 1 else ""}, {label} has {n} '
                f'word{"s" if n != 1 else ""}'], [], {}
    cfg = ws.project.ignored_cfg
    names = [name for name, _f in columns]
    parsed: List[Optional[list]] = []
    bad: Dict[int, tuple] = {}
    for j, w in enumerate(words):
        morphs, wrong = _parse_item(items[j], names, w, cfg)
        if wrong:
            bad[j] = (items[j], wrong)
        parsed.append(morphs)
    return [], parsed, bad


def _word_lines(words, bad: Dict[int, tuple]) -> List[str]:
    """The line of each word not staged: the word, the item given, what is
    wrong."""
    return [f'  w{words[j].index} {words[j].surface} | {_shown(text)}: ' + '; '.join(why)
            for j, (text, why) in sorted(bad.items())]


def _shown(item) -> str:
    """An item as the answer quotes it: a string as given, anything else as
    JSON, never as Python writes it."""
    return item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)


def _lineup(words, items) -> List[str]:
    """The sentence's words, numbered, beside the items given."""
    out = []
    for p in range(max(len(words), len(items))):
        w = words[p] if p < len(words) else None
        head = f'  w{w.index} {w.surface}' if w is not None else '  (no word)'
        out.append(head + f' | {_shown(items[p]) if p < len(items) else "(none)"}')
    return out


def _stage_sentence(ws: Workspace, doc: IgtDoc, item: Dict[str, Any], new_entries: bool, lexicon: Optional[str],
                    listed: Dict[tuple, Dict[str, Any]], made: List[str], taken: set) -> Tuple[str, List[str]]:
    """Stage one sentence: every word's analysis, the entries to create, the
    links, all of it or none of it. A word whose item does not line up is
    left out and listed, another number of items refuses the sentence."""
    label, s, words = _words_of(ws, doc, item.get('ref'))
    if not words:
        raise _Refused(f'{label} not staged: it has no words.')
    again = [w for w in words if w.id in taken]
    if again:
        # A word staged twice in one call: the second analysis superseded
        # the first and the answer counted both (REV-LAS-6).
        raise _Refused(f'{label} not staged: {", ".join(f"w{w.index}" for w in again)} '
                       f'{"is" if len(again) == 1 else "are"} in an earlier sentence of this call.')
    items = item.get('words')
    if not isinstance(items, list) or not items:
        raise _Refused(f'{label} not staged: give words, one "FORMS GLOSS" item per word of the ref, e.g. '
                       '"words": ["na-ku-ja PRS-INF-come", "le=o today=DEF"].')
    given = list(items)
    items = [x for x in given if not (isinstance(x, str) and _punctuation(x, ws.project.ignored_cfg))]
    columns = _columns(ws, item, label)
    problems, parsed, bad = _check(ws, label, words, items, columns)
    if problems:
        dropped = len(given) - len(items)
        left = (f' ({dropped} item{"s" if dropped != 1 else ""} of punctuation left out)' if dropped else '')
        raise _Refused('\n'.join([f'{label} not staged: ' + '; '.join(problems) + f'{left}.']
                                  + _lineup(words, items)))
    not_staged = ', '.join(f'w{words[i].index}' for i in sorted(bad))
    if all(p is None for p in parsed):
        if bad:
            raise _Refused('\n'.join([f'{label} not staged: {not_staged}.'] + _word_lines(words, bad)))
        raise _Refused(f'{label} not staged: every word is _.')
    fields = {name: f for name, f in columns if f is not None}
    g = fields.get('gloss')
    notes: List[str] = []
    found: Dict[tuple, Dict[str, Any]] = {}
    created: List[str] = []
    with ws.staging():
        n_analysed = 0
        held: List[str] = []
        # Words whose planned analysis or values this call took back.
        took: List[str] = []
        gone_entries: List[str] = []
        stays: List[str] = []
        # The stored links of each word whose morphemes the analysis keeps
        # (``tools.in_place``). Such a morpheme's link stays whatever entry
        # fits: a person may have chosen a homonym, and only a call that
        # names an entry (link_entry) changes a link. An unlinked one is
        # linked as an analysed one is.
        kept: Dict[str, List[Optional[str]]] = {}
        for j, (w, morphs) in enumerate(zip(words, parsed)):
            if morphs is None:
                continue
            ref = f's{s.index}.w{w.index}'
            given = [{'form': form, 'equals': delim == '=',
                      'fields': {fields[name].name: v for name, v in cut.items()
                                 if name in fields and v != NO_VALUE}}
                     for form, delim, cut in morphs]
            staged = word_analysis_op(ws, doc, ref, parse_analysis(ws, given))
            if staged.stage(ws):
                took.append(f'w{w.index}')
                gone_entries += staged.entries
            if not staged.whole:
                kept[w.id] = [h['link'] for h in held_chain(w)]
                if not staged.ops and all(
                        was is not None or link is None for link, was in
                        zip([_would_link(ws, g, form, cut, new_entries) for form, _d, cut in morphs], kept[w.id])):
                    # The analysis it holds, links and all: nothing staged, nothing linked.
                    held.append(f'w{w.index}')
                    parsed[j] = None
                    continue
            if staged.ops:
                n_analysed += 1
            if staged.note:
                notes.append(f'{ref} {w.surface} | {"".join(d + f for f, d, _c in morphs)}: forms differ from '
                             'the word (allowed for allomorphy).')
        links: Dict[str, List[str]] = {}
        creates = 0
        # A link staged on a morpheme a word keeps, by the morpheme: its word
        # and the gloss it was fitted to (REV-KM-2, ``tools.in_place_back``).
        fitted: Dict[str, List[str]] = {}
        before = {id(o) for o in ws.ops}
        for w, morphs in zip(words, parsed):
            stored = [m for m in w.morphemes if not m.virtual]
            for k, (form, _d, cut) in enumerate(morphs or [], start=1):
                value = cut.get('gloss', NO_VALUE)
                if g is None or value == NO_VALUE:
                    continue
                mref = f's{s.index}.w{w.index}.m{k}'
                if w.id in kept and kept[w.id][k - 1] is not None:
                    # The owner's ruling: a stored link stays whatever the
                    # gloss. Said when its entry no longer fits (REV-KM-4).
                    if not _same(stored[k - 1].fields.get(g.name), value):
                        stays.append(kept_link_note(ws, mref, stored[k - 1], form, value))
                    continue
                if w.id in kept:
                    fitted[stored[k - 1].id] = [w.id, g.layer_id, value]
                hits = _fits(ws, form, value)
                if not hits and new_entries and _creatable(ws, form, value):
                    v = _lexicon_for_new(ws, lexicon)
                    key = IgtProject.lexicon_field(v, ROLE_GLOSS)
                    if not key:
                        raise ToolError(f'new_entries: lexicon "{v["name"]}" has no gloss field.',
                                        kind='invalid-argument')
                    _create_entry(ws, v, form, {key: value}, None, None)
                    creates += 1
                    created.append(f'{form} ‘{value}’')
                    hits = _fits(ws, form, value)
                if len(hits) == 1:
                    links.setdefault(hits[0][1], []).append(mref)
                    continue
                key = (collation_key(form), nfc(value))
                entry = found.setdefault(key, {'form': form, 'gloss': value, 'refs': [], 'hits': hits})
                entry['refs'].append(mref)
        n_links = 0
        for target, refs in links.items():
            t_link_entry(ws, doc.id, refs, entry_id=target)
            n_links += len(refs)
        for o in ws.ops:
            if id(o) not in before and o.get('kind') == 'link' and o.get('token_id') in fitted:
                o[ANALYSIS_OF], o[FITTED_TO] = fitted[o['token_id']][0], fitted[o['token_id']][1:]
    made += created
    taken.update(w.id for w, morphs in zip(words, parsed) if morphs is not None)
    for key, entry in found.items():
        into = listed.setdefault(key, {**entry, 'refs': []})
        into['refs'] += entry['refs']
    given = n_analysed + len(bad)
    counts = [(f'{n_analysed} of {given} words analysed' if bad
               else f'{n_analysed} word{"s" if n_analysed != 1 else ""} analysed'),
              f'{n_links} link{"s" if n_links != 1 else ""}']
    if creates:
        counts.append(f'{creates} entr{"ies" if creates != 1 else "y"} to create')
    line = f'{label}: ' + ', '.join(counts) + '.'
    if held:
        line += (f' Nothing to change in {", ".join(held)}: {"it holds" if len(held) == 1 else "they hold"} that '
                 'analysis.' + confirm_hint(ws))
    if took:
        line += f' Took back the planned change to {", ".join(took)}.' + entries_note(gone_entries)
    line += ''.join(x for x in stays if x)
    if bad:
        line = '\n'.join([f'{line} Not staged: {not_staged}'] + _word_lines(words, bad))
    return line, notes


def _items_of(ws: Workspace, v: dict) -> List[dict]:
    """Lexicon ``v``'s entries as the plan leaves them, and the entries this
    plan creates in it."""
    return list(ws.view(v).items) + [{'form': e['form'], 'metadata': e.get('metadata') or {}, 'key': k}
                                     for k, e in ws.new_entries.items() if e.get('vocab_id') == v['id']]


def _fits(ws: Workspace, form: str, gloss: str) -> List[tuple]:
    """``[(lexicon, entry id or new entry key, entry)]``: the entries of
    every lexicon of the project that fit (``fit.fits``)."""
    out = []
    for v in ws.project.vocabs:
        for it in fits(v, _items_of(ws, v), form, gloss):
            out.append((v, it.get('id') or it.get('key'), it))
    return out


def _same(span, value: str) -> bool:
    """Whether a stored span holds ``value`` (NFC), none holding ''."""
    return nfc(span.value if span is not None else '') == nfc(value)


def kept_link_note(ws: Workspace, ref: str, m, form: str, gloss: str) -> str:
    """' s1.w1.m2 stays linked to -di.' when the stored link of morpheme
    ``m`` names an entry that does not fit ``form`` and the gloss given,
    else ''. The link stays (the owner's ruling, REV-KM-4)."""
    if m.link is None or any(hit[1] == m.link.item_id for hit in _fits(ws, form, gloss)):
        return ''
    return f' {ref} stays linked to {ws.entry_shown(m.link.item_id, m.link.form)}.'


def _would_link(ws: Workspace, g, form: str, cut: Dict[str, str], new_entries: bool):
    """The entry the link pass below would link a morpheme to, as
    ``word_analysis_op`` compares it with the one it is linked to: the one
    entry that fits, ``NEW_ENTRY`` for one it would create, None for no
    link."""
    value = cut.get('gloss', NO_VALUE)
    if g is None or value == NO_VALUE:
        return None
    hits = _fits(ws, form, value)
    if len(hits) == 1:
        return hits[0][1]
    if not hits and new_entries and _creatable(ws, form, value):
        return NEW_ENTRY
    return None


def _creatable(ws: Workspace, form: str, gloss: str) -> bool:
    """Whether ``new_entries`` creates an entry for this form and gloss: a
    gloss that says something (not empty, not only "?", REV-LAS-5), and no
    entry of any lexicon with that form and that gloss, whatever its type.
    The entry's form is the morpheme's as given, a capital kept."""
    if not gloss.strip().strip('?'):
        return False
    return not _fits(ws, form, gloss)


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
            made: List[str]) -> str:
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
    glosses), else the headwords spelled close to it."""
    same = [(v, it) for v in ws.project.vocabs for it in spelled(v, ws.view(v).items, form)]
    if same:
        lines = ws.entry_lines(same[:MAX_CANDIDATES], [])
        return (' Spelled so:\n' + '\n'.join('  ' + line for line in lines)
                + (f'\n    and {len(same) - MAX_CANDIDATES} more' if len(same) > MAX_CANDIDATES else ''))
    close, more = ws.spelled_close(form, ws.project.vocabs, limit=MAX_CANDIDATES)
    if close:
        return ' Close: ' + ', '.join(close) + (f', and {more} more' if more else '') + '.'
    return ''

