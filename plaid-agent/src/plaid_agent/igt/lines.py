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

import re
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.igt.ignored import is_token_ignored

import unicodedata

from plaid_client.workflows.igt.glossing import is_zero_morph

from ..core.tools import ToolError

from .fit import collation_key, fits, nfc, spelled
from .lexicon import _create_entry
from .project import IgtDoc, IgtProject
from .tools import parse_analysis, surface_misfit, t_link_entry, trim_ignored_edges, word_analysis_op
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
and gloss no entry has, and links every morpheme of it. An ambiguous one is never created for.

Checks. An item of punctuation alone is left out. Items go to the ref's words by their forms: an item \
matches a word when its forms, joined, are no more than 40% of the word's length in edits from it, and \
between two matched words as many items as words go to them in order. A word with no item, an item \
with no word, and a word whose forms and gloss differ in morphemes, hold an empty one, or are over \
twice the word's length plus 3, are listed and not staged: the other words are. One item for several \
words, or a count more than 3 off, stages nothing. Forms that differ from the word otherwise are staged \
with a note. Up to 20 sentences a call, each on its own.'''

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
    staged_any = False
    for item in sentences:
        if not isinstance(item, dict):
            said.append('A sentence is {ref, words}: not staged.')
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
    return _answer(ws, n, said, notes, listed, made)


def _words_of(doc: IgtDoc, ref: str):
    """``(label, sentence, words)`` a ref names: a sentence, or a run of its
    words."""
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
    return f's{si}.w{a}-w{b}' if b > a else f's{si}.w{a}', s, s.words[a - 1:b]


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


#: When the number of items is off, by at most this many, and there are two
#: or more, the items are lined up against the words by their forms (v3,
#: :func:`_line_up`).
MAX_SLIP = 3
#: An item matches a word when :func:`similarity` of its forms and the word
#: is at least this.
MATCH_AT_LEAST = 0.6


def _bare(text: str) -> str:
    return unicodedata.normalize('NFC', text or '').lower().replace(' ', '')


def similarity(forms: str, surface: str) -> float:
    """How alike an item's forms column is to a word: one less the edit
    distance (Levenshtein, by code point) of the two over the WORD's length,
    so forms longer than the word cost what they add (a whole sentence's
    forms on one word come out far below zero). The forms are joined (the
    delimiters and the zero morph left out), ``surface`` is the word as the
    surface check reads it (the caller trims its edge punctuation), both
    NFC, in lower case, spaces left out. 1 is the word itself."""
    a = _bare(''.join(f for f in _SPLIT.split(forms)[0::2] if not is_zero_morph(f)))
    b = _bare(surface)
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / len(b)


def _line_up(words, items: List[str], cfg) -> List[Tuple[int, int]]:
    """``[(word place, item place)]``, in order. First the anchors: the
    order-keeping pairing of items with words that pairs the most items with
    a word they match (similarity of the item's forms and the word at least
    :data:`MATCH_AT_LEAST`), and of those the one whose matches are most
    alike in sum. Then each stretch between two anchors (or before the first,
    or after the last) that holds as many words as items is paired in order:
    an item there is the word's by its place, as with the same number of
    items and words, where every word's own item is its by place unless a
    shift moves the anchors. A placeholder item matches no word."""
    surfaces = [trim_ignored_edges(w.surface, cfg) for w in words]
    n, m = len(words), len(items)
    sim = [[0.0] * m for _ in range(n)]
    for j, w in enumerate(surfaces):
        for i, text in enumerate(items):
            parts = text.split()
            if parts and text.strip() != PLACEHOLDER:
                sim[j][i] = similarity(parts[0], w)
    best = [[(0, 0.0)] * (m + 1) for _ in range(n + 1)]
    for j in range(n - 1, -1, -1):
        for i in range(m - 1, -1, -1):
            options = [best[j + 1][i], best[j][i + 1]]
            if sim[j][i] >= MATCH_AT_LEAST:
                k, t = best[j + 1][i + 1]
                options.append((k + 1, t + sim[j][i]))
            best[j][i] = max(options)
    pairs, j, i = [], 0, 0
    while j < n and i < m:
        if sim[j][i] >= MATCH_AT_LEAST:
            k, t = best[j + 1][i + 1]
            if best[j][i] == (k + 1, t + sim[j][i]):
                pairs.append((j, i))
                j, i = j + 1, i + 1
                continue
        if best[j][i] == best[j + 1][i]:
            j += 1
        else:
            i += 1
    out = []
    for (pj, pi), (nj, ni) in zip([(-1, -1)] + pairs, pairs + [(n, m)]):
        if nj - pj == ni - pi:
            out += [(pj + k, pi + k) for k in range(1, nj - pj)]
        if nj < n:
            out.append((nj, ni))
    return out


def _parse_item(text: str, names: List[str], word, cfg):
    """``(morphemes, wrong)`` of one word's item: its morphemes as
    ``(form, delimiter before, {column name: value})``, or None with what is
    wrong (and None, [] for the placeholder)."""
    text = str(text or '').strip()
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
    """``(problems, parsed, bad, extra)``: what keeps the items from lining
    up with ``words`` as a whole (which refuses the sentence), per word its
    morphemes (None for one left as it is or not staged), each
    ``(form, delimiter before, {column name: value})``, per word not staged
    ``(its item or None, what is wrong)`` by its place in ``words``, and the
    places of the items that matched no word.

    The items are lined up by their forms (:func:`_line_up`), which gives
    item k to word k when the numbers are the same and no shift shows.
    Another number is taken when it is off by at most :data:`MAX_SLIP` and
    there are two items or more: the items are lined up by their forms
    (:func:`_line_up`), a word with no item and an item with no word are
    listed, and when no item matches a word nothing is staged."""
    n = len(words)
    cfg = ws.project.ignored_cfg
    names = [name for name, _f in columns]
    count = (f'words has {len(items)} item{"s" if len(items) != 1 else ""}, {label} has {n} '
             f'word{"s" if n != 1 else ""}')
    if abs(len(items) - n) > MAX_SLIP or (len(items) == 1 and n > 1):
        return [count], [], {}, []
    pairs = _line_up(words, items, cfg)
    if not pairs:
        return [count + ', and none matches a word'], [], {}, []
    of = dict(pairs)
    parsed: List[Optional[list]] = []
    bad: Dict[int, tuple] = {}
    for j, w in enumerate(words):
        if j not in of:
            bad[j] = (None, ['no item'])
            parsed.append(None)
            continue
        morphs, wrong = _parse_item(items[of[j]], names, w, cfg)
        if wrong:
            bad[j] = (items[of[j]], wrong)
        parsed.append(morphs)
    used = set(of.values())
    return [], parsed, bad, [i for i in range(len(items)) if i not in used]


def _word_lines(words, items, bad: Dict[int, tuple], extra: List[int] = ()) -> List[str]:
    """The line of each word not staged (the word, the item given, what is
    wrong) and of each item that matched no word."""
    return ([f'  w{words[j].index} {words[j].surface}' + (f' | {text}' if text is not None else '') + ': '
             + '; '.join(why) for j, (text, why) in sorted(bad.items())]
            + [f'  item {i + 1} {items[i]}: matches no word' for i in extra])


def _lineup(words, items) -> List[str]:
    """The sentence's words, numbered, beside the items given."""
    out = []
    for p in range(max(len(words), len(items))):
        w = words[p] if p < len(words) else None
        head = f'  w{w.index} {w.surface}' if w is not None else '  (no word)'
        out.append(head + f' | {items[p] if p < len(items) else "(none)"}')
    return out


def _stage_sentence(ws: Workspace, doc: IgtDoc, item: Dict[str, Any], new_entries: bool, lexicon: Optional[str],
                    listed: Dict[tuple, Dict[str, Any]], made: List[str]) -> Tuple[str, List[str]]:
    """Stage one sentence: every word's analysis, the entries to create, the
    links, all of it or none of it. A word whose item does not line up is
    left out and listed, another number of items refuses the sentence."""
    label, s, words = _words_of(doc, item.get('ref'))
    if not words:
        raise _Refused(f'{label} not staged: it has no words.')
    items = item.get('words')
    if not isinstance(items, list) or not items:
        raise _Refused(f'{label} not staged: give words, one "FORMS GLOSS" item per word of the ref, e.g. '
                       '"words": ["na-ku-ja PRS-INF-come", "le=o today=DEF"].')
    given = [str(x) for x in items]
    items = [x for x in given if not _punctuation(x, ws.project.ignored_cfg)]
    columns = _columns(ws, item, label)
    problems, parsed, bad, extra = _check(ws, label, words, items, columns)
    if problems:
        dropped = len(given) - len(items)
        left = (f' ({dropped} item{"s" if dropped != 1 else ""} of punctuation left out)' if dropped else '')
        raise _Refused('\n'.join([f'{label} not staged: ' + '; '.join(problems) + f'{left}.']
                                  + _lineup(words, items)))
    not_staged = ', '.join(f'w{words[i].index}' for i in sorted(bad))
    if all(p is None for p in parsed):
        if bad:
            raise _Refused('\n'.join([f'{label} not staged: {not_staged}.'] + _word_lines(words, items, bad, extra)))
        raise _Refused(f'{label} not staged: every word is _.')
    fields = {name: f for name, f in columns if f is not None}
    g = fields.get('gloss')
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
                mref = f's{s.index}.w{w.index}.m{k}'
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
    made += created
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
    if bad:
        line = f'{line} Not staged: {not_staged}'
    if bad or extra:
        line = '\n'.join([line] + _word_lines(words, items, bad, extra))
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


def _creatable(ws: Workspace, form: str, gloss: str) -> bool:
    """Whether ``new_entries`` creates an entry for this form and gloss: no
    entry of any lexicon has that form and that gloss, whatever its type."""
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

