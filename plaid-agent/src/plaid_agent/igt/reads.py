"""The read tools: what the model can look at without proposing anything.

The corpus-wide half of reading (search over every document, the statistics
and worklists) is :mod:`.stats` and :mod:`.corpus`, which ask the query engine.
What is here reads one entry, or looks across documents for a form. Reading a
document pages as :func:`..core.tools.read_document` does, rendered by the workspace, and the
change history and comments are :mod:`..core.history`, all shared with the other
apps.
"""

import json
import unicodedata
from collections import Counter
from typing import Dict, List, Optional

from ..core.args import clamp_limit, read_int
from ..core.limits import MAX_SENTENCES_PER_READ, READ_LIMITS, RENDER_BUDGET
from ..core.tools import ToolError, document_page, documents_page, named_sentences, truncate
from ..core.trace import ranges
from ..core.workspace import name_matcher

from .project import (Word, Morpheme, document_lines, joiner_between, read_view, render_overview, word_ref)
from .lexview import LexView, _num_key, entry_line
from .vocab import RESERVED_ITEM_KEYS, all_examples, arrange_as_tree, descendants_of, homograph_group, references_to
from .workspace import Workspace, _hits_in, _matcher, _meta_of


# --- read tools ---------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    from .queries import q_field_fill
    return render_overview(ws.project, ws.documents(), fill=q_field_fill(ws))


def t_list_documents(ws: Workspace, pattern: Optional[str] = None, metadata_field: Optional[str] = None,
                     value: Optional[str] = None, limit: Optional[int] = None, offset: int = 0) -> str:
    """:func:`core.tools.list_documents`, also filtered by a document
    metadata value (an empty value lists the documents lacking it), with the
    pattern matching metadata values as well as names."""
    docs = None
    if metadata_field:
        name = next((n for n in ws.project.document_metadata if n.lower() == metadata_field.lower()), None)
        if not name:
            raise ToolError(f'No document metadata field "{metadata_field}". Fields: '
                            + (', '.join(ws.project.document_metadata) or '(none configured)'))
        metas = ws.corpus.document_metadata()
        want = (value or '').casefold()
        docs = [d for d in ws.documents() if str((metas.get(d['id']) or {}).get(name, '') or '').casefold() == want
                or (not want and not (metas.get(d['id']) or {}).get(name))]
    lines = document_lines
    if pattern and ws.project.document_metadata:
        # The pattern matches a metadata value too, which the line then
        # shows: a text's abbreviation kept in metadata could not be found by
        # name (2026-10-12 survey).
        metas = ws.corpus.document_metadata()
        match = _matcher(pattern, False)
        by_name = name_matcher(pattern)
        why: Dict[str, List[str]] = {}
        kept = []
        for d in (ws.documents() if docs is None else docs):
            meta = metas.get(d['id']) or {}
            found = [f'{k}={meta[k]}' for k in ws.project.document_metadata
                     if meta.get(k) not in (None, '') and match(str(meta[k]))]
            if by_name(d.get('name')):
                kept.append(d)
            elif found:
                kept.append(d)
                why[d['id']] = found
        docs, pattern = kept, None
        if why:
            lines = lambda page: [line + (f'  ({", ".join(why[d["id"]])})' if d['id'] in why else '')  # noqa: E731
                                  for d, line in zip(page, document_lines(page))]
    limit = clamp_limit(limit, *READ_LIMITS['list_documents'])
    return documents_page(ws, pattern, limit, offset, docs=docs, lines=lines)


def t_read_document(ws: Workspace, document: Optional[str] = None, from_sentence=None, to_sentence=None,
                    sentences=None, fields=None) -> str:
    """:func:`core.tools.read_document`, showing only the ``fields`` named
    when it names any."""
    return document_page(ws, document, from_sentence, to_sentence, sentences,
                         **({'fields': fields} if fields else {}))


ITEMS_SHAPE = 'items takes a list like [{"document": "Text 1", "sentences": ["s3", "s8"]}, ...].'


def t_read_sentences(ws: Workspace, items=None, fields=None) -> str:
    """Chosen sentences of several documents in one call, each document under
    its own header as read_document prints it, so a citation names its
    document. One render budget and one sentence cap for the whole call: a
    document that does not fit, and every one after it, is listed at the end
    to be asked for again."""
    if not isinstance(items, list) or not items:
        raise ToolError(ITEMS_SHAPE)
    if fields:
        read_view(ws.project, fields)  # refused before anything is read
    wanted: Dict[str, list] = {}  # document id -> the sentences named, in the order named
    for it in items:
        if not isinstance(it, dict) or not it.get('document') or not it.get('sentences'):
            raise ToolError(ITEMS_SHAPE)
        named = it['sentences'] if isinstance(it['sentences'], list) else [it['sentences']]
        wanted.setdefault(ws.resolve_document_id(it['document']), []).extend(named)
    out: List[str] = []
    left: List[str] = []
    used = total = 0
    cut = False  # a document's render left some of its sentences out
    for doc_id, named in wanted.items():
        room = RENDER_BUDGET - used
        if cut or left or total >= MAX_SENTENCES_PER_READ:
            left.append(_named_left(ws, doc_id, named))
            continue
        doc = ws.doc(doc_id)
        picked = named_sentences(ws, doc, named)[:MAX_SENTENCES_PER_READ - total]
        shown: List[int] = []
        text = ws.render(doc, indexes=picked, budget=room, shown_out=shown, fields=fields or None,
                         pointer=not out)
        if out and len(text) > room:  # not even its first sentence fitted
            left.append(_named_left(ws, doc_id, named))
            continue
        out.append(text)
        used += len(text) + 1
        total += len(shown)
        if shown:
            numbers = [ws.sentence_shown(doc, doc.sentences[i - 1]) for i in shown]
            ws.note_read(len(shown), 'sentence', which=f'{ranges(numbers)} in {doc.name}')
        cut = len(shown) < len([i for i in picked if 1 <= i <= len(doc.sentences)])
    if left:
        out.append('Not read, as they did not fit: ' + '; '.join(left)
                   + '. Ask for them in another read_sentences call.')
    return truncate('\n\n'.join(out))


def _named_left(ws: Workspace, doc_id: str, named: list) -> str:
    """A document left for another call, and its sentences as they were
    asked for."""
    return f'"{ws.corpus.ref_name(doc_id)}" ' + ', '.join(str(n) for n in named)


#: What a model writes for each kind of ``where`` a read takes besides a
#: field's name. Only words that cannot mean the other kinds: "form" could be
#: a word's or a morpheme's.
WHERE_WORDS = {'baseline': ('baseline', 'word', 'words', 'wordform', 'wordforms', 'word form', 'word forms',
                            'surface'),
               'morpheme': ('morpheme', 'morphemes', 'morph', 'morphs', 'morpheme form', 'morpheme forms'),
               'lexicon': ('lexicon', 'entries', 'entry', 'vocabulary', 'vocab', 'dictionary')}
WHERE_SAYS = {'baseline': '"baseline" (word forms)', 'morpheme': '"morpheme" (morpheme forms)',
              'lexicon': '"lexicon" (entries)'}


def _where(ws: Workspace, where: Optional[str], default: str, kinds) -> str:
    """``where`` as one of ``kinds`` when it says one of them in other words
    ("words", "morphemes"), else as given (a field name). A field really
    called that keeps its name."""
    name = (where or default).strip()
    if name.lower().startswith('field:'):
        return name[6:].strip()
    low = name.lower()
    if any(low in (f.name.lower(), f.base_name.lower()) for f in ws.project.fields.values()):
        return name
    return next((k for k in kinds if low in WHERE_WORDS[k]), name)


def _field_or_where(ws: Workspace, name: str, kinds):
    """The field ``name`` names, or a refusal that offers the other kinds of
    ``where`` beside the fields."""
    try:
        return ws.project.field(name)
    except ValueError as e:
        if 'names several' in str(e):
            raise
        raise ToolError(f'{e}. Or where = ' + ', '.join(WHERE_SAYS[k] for k in kinds) + '.') from None


def t_search(ws: Workspace, pattern: str = '', where: str = 'baseline', document: Optional[str] = None,
             regex: bool = False, limit: Optional[int] = None, case_sensitive: bool = False) -> str:
    if not pattern:
        raise ToolError('Give a pattern (to list items LACKING a value, use worklist).')
    match = _matcher(pattern, bool(regex), bool(case_sensitive))
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    where_name = _where(ws, where, 'baseline', ('baseline', 'morpheme', 'lexicon'))
    where_l = where_name.lower()
    out: List[str] = []
    total = 0

    if where_l == 'lexicon':
        for v in ws.project.vocabs:
            for it in ws.lexicon(v):
                line = entry_line(it)
                if match(line):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{line} ({v["name"]})')
        return _finish(ws, out, total, limit, 'lexicon entries', 'entry')

    field = None
    if where_l not in ('baseline', 'morpheme'):
        # A name several fields share ("Gloss" on words and on morphemes) is
        # a question about each: answered for each, under its full name.
        alike = ws.project.fields_sharing_name(where_name)
        if alike:
            start = len(ws.reads) if ws.reads is not None else 0
            text = '\n\n'.join(f'{f.name}: ' + t_search(ws, pattern, f.name, document, regex, limit, case_sensitive)
                                 for f in alike)
            _merge_notes(ws, start)
            return text
        field = _field_or_where(ws, where_name, ('baseline', 'morpheme', 'lexicon'))
    from .queries import q_empty_hint, q_search, where_label
    with ws.corpus.within(document):
        out, total, morphs = q_search(ws, pattern, where_l, field, bool(regex), limit, bool(case_sensitive))
        why = [] if total else q_empty_hint(ws, pattern, where_l, field, bool(regex), bool(case_sensitive), False)
    empty = ' '.join([f'No hits in {where_label(where_l, field)}.'] + why)
    return _finish(ws, out, total, limit, 'hits', 'match', morphs, empty=empty)


def _merge_notes(ws, start):
    """One note for the searches of a name several fields share, as the
    step is one search: their hits shown out of their hits found, added up."""
    if ws.reads is None or len(ws.reads) - start < 2:
        return
    notes = ws.reads[start:]
    of = [n.get('of') for n in notes]
    del ws.reads[start:]
    ws.note_read(sum(n['n'] for n in notes), notes[0]['unit'],
                 of=sum(of) if all(o is not None for o in of) else None)


def _finish(ws, out, total, limit, noun, unit, morphs=None, empty=None):
    """The hits found, with the count of those shown out of all found noted
    for the step's label (`BaseWorkspace.note_read`). A morpheme search's
    hits are words, and ``morphs`` the morphemes in them that match: "14
    hits" read as 14 morphemes where 23 matched, two in a word."""
    ws.note_read(len(out), unit, of=total)
    if not out:
        return empty or f'No {noun}.'
    if morphs is not None:
        noun = (f'word{"s" if total != 1 else ""} hit, holding {morphs} matching '
                f'morpheme{"s" if morphs != 1 else ""}')
    head = f'{total} {noun}' + (f' (showing {limit})' if total > limit else '') + ':'
    return truncate('\n'.join([head] + out))


def t_read_lexicon(ws: Workspace, lexicon: Optional[str] = None, pattern: Optional[str] = None,
                   limit: int = 80) -> str:
    vocabs = [ws.project.vocab(lexicon)] if lexicon else ws.project.vocabs
    if not vocabs:
        ws.note_read(0, 'entry')
        return 'This project has no lexicon.'
    match = _matcher(pattern, False) if pattern else (lambda s: True)
    limit = clamp_limit(limit, 80, 500)
    lines = []
    shown_all = matched = 0
    for v in vocabs:
        view = ws.view(v)
        # Senses under their entry, each with the number it is shown with,
        # which is also how a tool is told which one. Entries spelled the same
        # carry one too, so they read in that order.
        items = sorted(view.items, key=lambda it: ((it.get('form') or '').casefold(),
                                                   _num_key(view.number(it['id']))))
        hits = [it for it in items if match(entry_line(it, view))]
        n_entries = len(view.tree.roots)
        n_senses = len(items) - n_entries
        head = (f'Lexicon "{v["name"]}": {n_entries} '
                f'headword{"s" if n_entries != 1 else ""}, {n_senses} sense{"s" if n_senses != 1 else ""}'
                + (f', {len(hits)} matching' if pattern else ''))
        lines.append(head)
        shown = 0
        for it, depth, context in arrange_as_tree(hits, view.tree):
            if shown >= limit:
                break
            # A context row is an entry above a hit, printed so a sense is not
            # read as a headword. It does not count against the limit's tally
            # of matches, but it does take a line.
            if not context:
                shown += 1
            num = view.number(it['id'])
            lines.append('  ' + '  ' * depth + (f'{num} ' if num else '')
                         + entry_line(it, view) + (' | (context)' if context else ''))
        if len(hits) > shown:
            lines.append(f'  ... {len(hits) - shown} more (narrow with pattern)')
        shown_all += shown
        matched += len(hits)
    ws.note_read(shown_all, 'entry', of=matched)
    from .queries import looks_like_regex
    if pattern and not matched and looks_like_regex(pattern):
        # "^se$" and "a|b" found nothing and were retried as other regexes
        # (2026-10-12 survey).
        lines.append(f'"{pattern}" was read as literal text: pattern is plain text found anywhere in an '
                     f'entry\'s line.')
    return truncate('\n'.join(lines))


def _bracket_line(w: Word, hit: Morpheme, field: Optional[str]) -> str:
    """The word's segmentation (field=None) or one morpheme field's values,
    joined as in the interlinear view, with the hit morpheme in [brackets]."""
    out = ''
    pieces = []
    for m in w.morphemes:
        if field is None:
            pieces.append(m.form)
        else:
            sp = m.fields.get(field)
            pieces.append(sp.value if sp and sp.value != '' else '_')
    for i, (m, piece) in enumerate(zip(w.morphemes, pieces)):
        if i:
            out += joiner_between(pieces[i - 1], w.morphemes[i - 1].morph_type, piece, m.morph_type)
        out += f'[{piece}]' if m is hit else piece
    return out


def t_concordance(ws: Workspace, pattern: str, where: str = 'morpheme', document: Optional[str] = None,
                  regex: bool = False, limit: int = 60, case_sensitive: bool = False) -> str:
    """Every occurrence of a morpheme form, word form, or field value with
    its aligned context: the containing word's segmentation and morpheme
    glosses (hit in brackets) and the neighbouring words, plus a tally of the
    distinct word patterns the hit occurs in. Built for morphotactic
    questions (what precedes/follows X, does X vary by context)."""
    if not pattern:
        raise ToolError('Give a pattern.')
    limit = clamp_limit(limit, 60, 300)
    where = _where(ws, where, 'morpheme', ('baseline', 'morpheme'))
    where_l = where.lower()
    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = _field_or_where(ws, where, ('baseline', 'morpheme'))
        if field.scope == 'Sentence':
            raise ToolError('concordance works on words and morphemes; use search for sentence fields')
    from .queries import concordance_where, q_concordance_hits, q_concordance_tally, q_empty_hint, where_label
    with ws.corpus.within(document):
        hits, total, cut = q_concordance_hits(ws, pattern, where_l, field, bool(regex), limit, bool(case_sensitive))
        why = [] if total else q_empty_hint(ws, pattern, where_l, field, bool(regex), bool(case_sensitive),
                                            not regex)
        # Past the hits shown, the tallies are the engine's over every
        # occurrence, not a count of the ones shown (survey item 10).
        whole = None
        if total > len(hits):
            hit_where, mvar = concordance_where(ws.corpus, pattern, where_l, field, bool(regex), bool(case_sensitive))
            whole = q_concordance_tally(ws, hit_where, '?w', mvar)
    ws.note_read(len(hits), 'match', of=total)
    if not total:
        return ' '.join([f'No occurrences of "{pattern}" in {where_label(where_l, field)}'
                         + ('' if regex else ', matching whole values') + '.'] + why)
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    patterns: Counter = Counter()
    lines_out: List[str] = []
    for doc, s, w, hit in hits:
        wi = w.index - 1
        prev = s.words[wi - 1].surface if wi > 0 else '#'
        nxt = s.words[wi + 1].surface if wi + 1 < len(s.words) else '#'
        seg = _bracket_line(w, hit, None) if w.morphemes else w.surface
        glosses = ' | '.join(f'{f}={_bracket_line(w, hit, f)}' for f in mfields
                             if any(f in m.fields for m in w.morphemes))
        pattern_key = seg if hit is None else f'{seg}' + (f'  {glosses}' if glosses else '')
        patterns[pattern_key] += 1
        wf = ' | '.join(f'{f.name}={w.fields[f.name].value}' for f in ws.project.fields_by_scope('Word')
                        if f.name in w.fields and w.fields[f.name].value != '')
        lines_out.append(f'{ws.corpus.tag(doc.id)}{word_ref(s, w)} {prev} [{w.surface}] {nxt} | seg={seg}'
                         + (f' | {glosses}' if glosses else '') + (f' | {wf}' if wf else '')
                         + f' || {s.text}')
    # The shown count is the hits rendered: the per-call document budget can
    # stop well short of the limit, and "(showing 200)" over 67 lines was
    # read as 200 (2026-10-12 survey).
    docs_shown = len({doc.id for doc, _s, _w, _h in hits})
    lines = [f'{total} occurrence{"s" if total != 1 else ""} of "{pattern}" in {where_l if not field else field.name}'
             + (f' (showing {len(hits)})' if total > len(hits) else '') + '.'
             + (f' The ones shown come from the first {docs_shown} document{"s" if docs_shown != 1 else ""} '
                f'with hits. Name a document to see its own.' if cut else ''),
             'Word patterns (hit in [brackets]), by frequency' + (f', among the {len(hits)} shown' if total > len(hits) else '') + ':']
    # The hit's own values, tallied: asked which glosses a morpheme carries,
    # models read the patterns below and missed the rare ones among them.
    tallies = []
    if whole is not None:
        tallies = [f'Across all {total} occurrences:'] + ['  ' + t for t in whole]
    else:
        for f in mfields:
            own = Counter((m.fields[f].value if f in m.fields else '') or '(blank)' for _, _, _, m in hits
                          if m is not None)
            if own:
                tallies.append(f'The hit\'s own {f}: ' + ', '.join(f'{v} {n}' for v, n in own.most_common(25))
                               + (f', and {len(own) - 25} more values' if len(own) > 25 else '') + '.')
    lines[1:1] = tallies
    for key, n in sorted(patterns.items(), key=lambda kv: (-kv[1], kv[0]))[:25]:
        lines.append(f'  {n}\t{key}')
    if len(patterns) > 25:
        lines.append(f'  ... {len(patterns) - 25} more patterns')
    lines.append('Occurrences (previous [word] next | segmentation | morpheme fields || sentence):')
    lines.extend('  ' + h for h in lines_out)
    return truncate('\n'.join(lines))


MAX_FORMS_PER_CALL = 40


def t_analyses_of(ws: Workspace, form: Optional[str] = None, document: Optional[str] = None,
                  forms: Optional[list] = None, value: Optional[str] = None) -> str:
    """How a word form and/or a morpheme form has been analyzed so far: the
    distinct analyses with counts and an example reference each. The same
    evidence the editor's precedent ranking uses. Several forms at once
    (``forms``) come back one block each, so glossing a sentence is one call."""
    wanted = [str(f).strip() for f in (forms or []) if str(f).strip()]
    if form and str(form).strip():
        wanted.insert(0, str(form).strip())
    wanted = list(dict.fromkeys(wanted))
    if not wanted:
        raise ToolError('Give a form, or forms (a list).')
    if len(wanted) > MAX_FORMS_PER_CALL:
        raise ToolError(f'At most {MAX_FORMS_PER_CALL} forms per call; split the list.')
    # The occurrences tallied, every form's together, for the step's label.
    found: List[int] = []
    value = str(value).strip() if value is not None and str(value).strip() else None
    out = '\n\n'.join(_analyses_of_one(ws, f, document, found, value) for f in wanted)
    ws.note_read(sum(found), 'match')
    return truncate(out)


def _analyses_of_one(ws: Workspace, form: str, document: Optional[str], found: List[int],
                     value: Optional[str] = None) -> str:
    """One form's tallies, with the occurrences tallied added to ``found``."""
    from .queries import q_analyses_of
    with ws.corpus.within(document):
        return q_analyses_of(ws, form, found, value)


#: The most entries spelled alike that lexicon_entry shows in full at once.
ALIKE_IN_FULL = 4


def _spelled_alike(ws: Workspace, form: str, lexicon: Optional[str]):
    """When ``form`` names several existing entries and nothing this plan
    adds, a function writing them out; else None, and the lookup goes on as
    for any other name (so a planned entry spelled the same is still the
    workspace's refusal to make)."""
    vocabs = [ws.project.vocab(lexicon)] if lexicon else ws.project.vocabs
    hits = [(v, it) for v in vocabs for it in _hits_in(ws, v, form, None, lambda meta, view=None: True)]
    if len(hits) < 2 or any(e['form'].lower() == form.lower() for e in ws.new_entries.values()):
        return None

    def write(examples):
        ws.note_read(len(hits), 'entry')
        head = (f'{len(hits)} entries are spelled "{form}". Pass the entry_form shown with one to name it '
                f'in a change.')
        if len(hits) <= ALIKE_IN_FULL:
            return '\n\n'.join([head] + [_entry_in_full(ws, entry_id=it['id'], examples=examples)
                                         for _v, it in hits])
        lines = [head]
        for v, it in hits:
            view = ws.view(v)
            lines.append(f'  entry_form "{view.address(it["id"])}" {entry_line(it, view)} ({v["name"]})')
        lines.append('lexicon_entry with one of those entry_forms shows it in full.')
        return '\n'.join(lines)
    return write


def t_lexicon_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, examples: int = 3, entry_gloss: Optional[str] = None) -> str:
    """One lexicon entry in full: every field, where it is linked (words vs
    morphemes, how many), and example occurrences.

    A bare form that several entries share is answered with all of them
    rather than refused: this is a read, so showing each is the answer to
    the question asked, and each comes with the entry_form that names it in
    a change."""
    if isinstance(entry_form, str) and entry_form.strip() and '#' not in entry_form \
            and not entry_id and not entry_gloss:
        several = _spelled_alike(ws, entry_form.strip(), lexicon)
        if several:
            return several(examples)
    out = _entry_in_full(ws, entry_form, lexicon, entry_id, examples, entry_gloss)
    ws.note_read(1, 'entry')
    return out


def _entry_in_full(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                   entry_id: Optional[str] = None, examples: int = 3, entry_gloss: Optional[str] = None) -> str:
    """One entry, named exactly, in full (:func:`t_lexicon_entry`)."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'new':
        e = ws.new_entries[target]
        return f'Entry "{e["form"]}" is new in this plan (not written yet): ' + entry_line({'form': e['form'], 'metadata': e['metadata']})
    # The plan's own copy of the entry, so a value set or an example promoted
    # a moment ago reads back the same whether the entry was named by id or
    # by form.
    meta = _meta_of(ws, target)
    # An entry this plan removes is not in the plan's view, so its form, its
    # number and the entry_form naming it back all came out as its id. Read
    # that one against the lexicon as it stands instead. No entry_form is
    # offered for it: the numbers beside the others have moved, so the one it
    # carried now names something else, and its id is the way back.
    doomed = target['id'] in ws.doomed_entries()
    view = ws.view_of_item(target['id'], removed=doomed)
    if view is not None:
        num = view.number(target['id'])
        if view.is_sense(target['id']):
            where = f'Sense {num} of headword "{view.head_of(target["id"])}"'
        else:
            group = homograph_group(view.items, target['id'])
            where = (f'Headword "{target.get("form")}"'
                     + (f' ({num} of {len(group)} spelled that way)' if group else ''))
        back = '' if doomed else f', entry_form "{view.address(target["id"])}"'
        lines = [f'{where} (id {target["id"]}{back})']
    else:
        lines = [f'Entry "{target.get("form")}" (id {target["id"]})']  # a flat lexicon has no headwords
    if doomed:
        lines.append('This plan deletes or merges this entry away.')
    ref_names = {f['name'] for f in (view.ref_fields if view is not None else [])}
    hidden = view.hidden_fields(target) if view is not None else set()
    for k, v in meta.items():
        if (k in RESERVED_ITEM_KEYS or k in ref_names or k in hidden or k.startswith('prov')
                or v in (None, '', [], {})):
            continue
        lines.append(f'  {k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v}')
    examples = read_int(examples, 'examples', 3, minimum=0, maximum=20)
    word_links, morph_links, mwes, exs = _entry_usage(ws, target['id'], examples)
    # A headword's links usually sit on its senses, so its own count alone is
    # often 0 while the entry is in wide use. The summary adds up the senses
    # (each with the senses under it) and the Senses list says each one's.
    by_sense: Dict[str, tuple] = {}
    if view is not None:
        for c in view.tree.senses_of(target['id']):
            w = m = x = 0
            for it in [c] + descendants_of(view.tree, c['id']):
                sw, sm, sx, sexs = _entry_usage(ws, it['id'], max(0, examples - len(exs)))
                w, m, x = w + sw, m + sm, x + sx
                exs.extend(sexs)
            by_sense[c['id']] = (w, m, x)
    if view is not None:
        lines.extend(f'  {r}' for r in view.ref_summary(target))
        lines.extend(_dictionary_lines(ws, view, target, by_sense))
    if by_sense:
        own_w, own_m = word_links, morph_links
        word_links += sum(t[0] for t in by_sense.values())
        morph_links += sum(t[1] for t in by_sense.values())
        mwes += sum(t[2] for t in by_sense.values())
    lines.append(f'Linked from {_links(word_links, morph_links)}'
                 + (f' ({mwes} multi-word expression{"s" if mwes != 1 else ""})' if mwes else '')
                 + (f', counting its senses. The {"sense" if view.is_sense(target["id"]) else "headword"} '
                    f'itself: {_links(own_w, own_m)}' if by_sense else '')
                 + '.')
    if exs:
        lines.append('Examples:')
        lines.extend(exs[:examples])
    return truncate('\n'.join(lines))


def _links(words: int, morphs: int) -> str:
    return f'{words} word{"s" if words != 1 else ""} and {morphs} morpheme{"s" if morphs != 1 else ""}'


def _entry_usage(ws: Workspace, item_id: str, examples: int):
    """(word links, morpheme links, multi-word expressions, example lines) for
    one item's OWN links, not its senses'."""
    from .queries import q_entry_usage
    return q_entry_usage(ws, item_id, examples)


def _dictionary_lines(ws: Workspace, view: LexView, target: dict,
                      by_sense: Optional[Dict[str, tuple]] = None) -> List[str]:
    """An entry's place in its lexicon: the senses under it (with each one's
    links when ``by_sense`` has them), what refers to it, and its promoted
    examples."""
    out: List[str] = []
    senses = view.tree.senses_of(target['id'])
    if senses:
        out.append(f'Senses ({len(senses)}):')
        for c in senses:
            n = (by_sense or {}).get(c['id'])
            sub = ' with the senses under it' if n is not None and view.tree.senses_of(c['id']) else ''
            tail = f' (linked from {_links(n[0], n[1])}{sub})' if n is not None else ''
            out.append(f'  {view.number(c["id"])} {entry_line(c, view)}{tail}')
    back = [r for r in references_to(view.items, view.fields, target['id'])]
    if back:
        out.append('Referred to by:')
        for r in back[:12]:
            how = r['field']['name'] if r['field'] else 'a sense of it'
            out.append(f'  {view.label(r["item"]["id"])} ({how})')
        if len(back) > 12:
            out.append(f'  ... {len(back) - 12} more')
    # The plan's own copy, so an example promoted a moment ago is listed
    # (and numbered) the same whether the entry was named by id or by form.
    exs = all_examples({'metadata': _meta_of(ws, target)})
    if exs:
        out.append(f'Usage examples ({len(exs)}):')
        for i, e in enumerate(exs):
            out.append(f'  [{i}] ' + _example_line(ws, e))
    return out


def _example_line(ws: Workspace, e: dict) -> str:
    """One promoted example, resolved to its sentence where it still exists.
    A FLEx import's text examples carry their own text and have no token."""
    if isinstance(e.get('text'), str):
        tr = f' || {e["translation"]}' if e.get('translation') else ''
        return f'{e["text"]}{tr} (imported text)'
    try:
        doc = ws.doc(e['document'])
    except ToolError:
        return f'a document that is gone ({e["document"]})'
    for sent in doc.sentences:
        for w in sent.words:
            if w.id == e['token']:
                return f'{ws.doc_tag(doc)}{word_ref(sent, w)} {w.surface} || {sent.text}'
    return f'{ws.doc_tag(doc)}a word that is gone ({e["token"]})'


def _norm_value(v: str) -> str:
    v = unicodedata.normalize('NFKC', v or '').casefold()
    return ''.join(ch for ch in v if ch.isalnum())


def linked_form(u) -> str:
    """The entry a word or morpheme is linked to, by form: its own link, else
    the multi-word expression it belongs to, else ``?``."""
    if u.link:
        return u.link.form
    mwes = getattr(u, 'mwes', None)
    return mwes[0].form if mwes else '?'


def t_check_consistency(ws: Workspace, field: str, document: Optional[str] = None) -> str:
    """A deterministic consistency report for one field: values that are
    spelling/case variants of each other, forms carrying several different
    values, and items annotated in this field but not linked to the lexicon
    (or linked but empty)."""
    f = ws.project.field(field)
    from .queries import q_consistency
    with ws.corpus.within(document) as held:
        ws.note_read(1 if held else len(ws.corpus.documents or ws.documents()), 'document')
        values, by_form, (unlinked_n, unlinked), (linked_empty_n, linked_empty) = q_consistency(ws, f)
    return _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty,
                              ws.corpus.clipped_note(f'{f.name} values'))


def _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty,
                       clipped: str = '') -> str:
    lines = [f'Consistency of {f.name} ({f.scope} field): {sum(values.values())} values, '
             f'{len(values)} distinct.' + clipped]
    groups: Dict[str, List[str]] = {}
    for v in values:
        groups.setdefault(_norm_value(v), []).append(v)
    variants = [g for g in groups.values() if len(g) > 1]
    if variants:
        lines.append(f'{len(variants)} value{"s" if len(variants) != 1 else ""} spelled more than one way:')
        for g in sorted(variants, key=lambda g: (-sum(values[v] for v in g), sorted(g)))[:40]:
            lines.append('  ' + ' / '.join(f'{v} ({values[v]})' for v in sorted(g, key=lambda v: (-values[v], v))))
    else:
        lines.append('No spelling or case variants among values.')
    if f.scope != 'Sentence':
        multi = {form: c for form, c in by_form.items() if len(c) > 1}
        if multi:
            lines.append(f'{len(multi)} {"morpheme" if f.scope == "Morpheme" else "word"} form{"s" if len(multi) != 1 else ""} with several {f.name} values (homonymy or inconsistency):')
            for form, c in sorted(multi.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))[:40]:
                lines.append(f'  {form}: ' + ', '.join(f'{v} ({n})' for v, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))))
        else:
            lines.append(f'Every form carries a single {f.name} value.')
        by_value: Dict[str, Counter] = {}
        for form, c in by_form.items():
            for v, n in c.items():
                by_value.setdefault(v, Counter())[form] += n
        shared = {v: c for v, c in by_value.items() if len(c) > 1}
        if shared:
            lines.append(f'{len(shared)} {f.name} value{"s" if len(shared) != 1 else ""} carried by several forms (allomorphy or a gloss collision):')
            for v, c in sorted(shared.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:25]:
                lines.append(f'  {v}: ' + ', '.join(f'{form} ({n})' for form, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[:8]) + (' …' if len(c) > 8 else ''))
        if ws.project.vocabs:
            lines.append(f'{unlinked_n} annotated but not linked to the lexicon'
                         + (': ' + '; '.join(unlinked) + (' …' if unlinked_n > len(unlinked) else '') if unlinked else '.'))
            lines.append(f'{linked_empty_n} linked but with no {f.name} value'
                         + (': ' + '; '.join(linked_empty) + (' …' if linked_empty_n > len(linked_empty) else '') if linked_empty else '.'))
    return truncate('\n'.join(lines))


