"""The read tools: what the model can look at without proposing anything.

The corpus-wide half of reading (search over every document, the statistics
and worklists) is :mod:`.stats` and :mod:`.corpus`, which ask the query engine.
What is here reads one document, one entry, or one window of the change
history, and renders it for the model.
"""

import json
import re
import unicodedata
from collections import Counter
from typing import Dict, List, Optional

from ..core.args import clamp_limit, read_int, sentence_number
from ..core.limits import READ_LIMITS, RENDER_BUDGET
from ..core.tools import ToolError, server_refused, truncate

from .project import (Word, Morpheme, document_lines, joiner, render_document, render_overview,
                      render_word, segmentation, word_ref)
from .lexview import LexView, _num_key, entry_line
from .vocab import RESERVED_ITEM_KEYS, all_examples, arrange_as_tree, homograph_group, references_to
from .workspace import Workspace, _matcher, _meta_of


# --- read tools ---------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    return render_overview(ws.project, ws.documents())


def t_list_documents(ws: Workspace, pattern: Optional[str] = None, metadata_field: Optional[str] = None,
                     value: Optional[str] = None, limit: Optional[int] = None, offset: int = 0) -> str:
    """The documents, filtered by a name pattern and/or a metadata value, a
    page at a time (the overview shows only the first ``OVERVIEW_DOCS``)."""
    docs = sorted(ws.documents(), key=lambda d: (d.get('name') or '').lower())
    if pattern:
        m = _matcher(pattern, False)
        docs = [d for d in docs if m(d.get('name') or '')]
    if metadata_field:
        name = next((n for n in ws.project.document_metadata if n.lower() == metadata_field.lower()), None)
        if not name:
            raise ToolError(f'No document metadata field "{metadata_field}". Fields: '
                            + (', '.join(ws.project.document_metadata) or '(none configured)'))
        metas = ws.corpus.document_metadata() if not ws.prefer_scan else {d.id: d.metadata for d in ws.all_docs()}
        want = (value or '').casefold()
        docs = [d for d in docs if str((metas.get(d['id']) or {}).get(name, '') or '').casefold() == want
                or (not want and not (metas.get(d['id']) or {}).get(name))]
    limit = clamp_limit(limit, *READ_LIMITS['list_documents'])
    offset = read_int(offset, 'offset', 0, minimum=0)
    page = docs[offset:offset + limit]
    head = f'{len(docs)} document{"s" if len(docs) != 1 else ""}' + (' matching' if pattern or metadata_field else '') \
        + (f', showing {offset + 1}-{offset + len(page)}' if len(docs) > len(page) else '') + ':'
    lines = [head] + document_lines(page)
    if offset + len(page) < len(docs):
        lines.append(f'  … list_documents(offset={offset + len(page)}) for the next page')
    return truncate('\n'.join(lines))


def t_read_document(ws: Workspace, document: str, from_sentence: int = 1, to_sentence: Optional[int] = None) -> str:
    doc = ws.doc(document)
    return render_document(doc, ws.project, start=sentence_number(from_sentence, 'from_sentence') or 1,
                           end=sentence_number(to_sentence, 'to_sentence'),
                           ref_name=ws.corpus.ref_name(doc.id), budget=RENDER_BUDGET)


def t_search(ws: Workspace, pattern: str = '', where: str = 'baseline', document: Optional[str] = None,
             regex: bool = False, limit: Optional[int] = None, case_sensitive: bool = False) -> str:
    if not pattern:
        raise ToolError('Give a pattern (to list items LACKING a value, use worklist).')
    match = _matcher(pattern, bool(regex), bool(case_sensitive))
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    where_name = (where or 'baseline').strip()
    if where_name.lower().startswith('field:'):
        where_name = where_name[6:].strip()
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
        return _finish(out, total, limit, 'lexicon entries')

    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where_name)
    if not ws.use_scan(document):
        from .queries import q_search
        out, total = q_search(ws, pattern, where_l, field, bool(regex), limit, bool(case_sensitive))
        return _finish(out, total, limit, 'hits')
    docs = [ws.doc(document)] if document else ws.all_docs()
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            if field and field.scope == 'Sentence':
                sp = s.fields.get(field.name)
                if sp and match(sp.value):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}s{s.index} {field.name}={sp.value} | {s.text}')
                continue
            for w in s.words:
                hit = False
                if where_l == 'baseline':
                    hit = match(w.surface)
                elif where_l == 'morpheme':
                    hit = any(match(m.form) for m in w.morphemes)
                elif field.scope == 'Word':
                    sp = w.fields.get(field.name)
                    hit = bool(sp and match(sp.value))
                else:
                    hit = any(match(m.fields[field.name].value) for m in w.morphemes if field.name in m.fields)
                if hit:
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    return _finish(out, total, limit, 'hits')


def _finish(out, total, limit, noun):
    if not out:
        return f'No {noun}.'
    head = f'{total} {noun}' + (f' (showing {limit})' if total > limit else '') + ':'
    return truncate('\n'.join([head] + out))


def t_read_lexicon(ws: Workspace, lexicon: Optional[str] = None, pattern: Optional[str] = None,
                   limit: int = 80) -> str:
    vocabs = [ws.project.vocab(lexicon)] if lexicon else ws.project.vocabs
    if not vocabs:
        return 'This project has no lexicon.'
    match = _matcher(pattern, False) if pattern else (lambda s: True)
    limit = clamp_limit(limit, 80, 500)
    lines = []
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
    return truncate('\n'.join(lines))


def _bracket_line(w: Word, hit: Morpheme, field: Optional[str]) -> str:
    """The word's segmentation (field=None) or one morpheme field's values,
    joined as in the interlinear view, with the hit morpheme in [brackets]."""
    out = ''
    for i, m in enumerate(w.morphemes):
        if i:
            out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
        if field is None:
            piece = m.form
        else:
            sp = m.fields.get(field)
            piece = sp.value if sp and sp.value != '' else '_'
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
    where_l = (where or 'morpheme').lower()
    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where)
        if field.scope == 'Sentence':
            raise ToolError('concordance works on words and morphemes; use search for sentence fields')
    if not ws.use_scan(document):
        from .queries import q_concordance_hits
        hits, total = q_concordance_hits(ws, pattern, where_l, field, bool(regex), limit, bool(case_sensitive))
    else:
        # Whole-form match by default (a concordance of "ar" must not include
        # "para"). Regex for anything looser.
        if regex:
            match = _matcher(pattern, True, bool(case_sensitive))
        elif case_sensitive:
            match = lambda s: (s or '') == pattern  # noqa: E731
        else:
            wanted = pattern.casefold()
            match = lambda s: (s or '').casefold() == wanted  # noqa: E731
        docs = [ws.doc(document)] if document else ws.all_docs()
        hits = []
        total = 0
        for doc in docs:
            for s in doc.sentences:
                for w in s.words:
                    hit_morphs: List[Morpheme] = []
                    if where_l == 'baseline':
                        if not match(w.surface):
                            continue
                    elif where_l == 'morpheme':
                        hit_morphs = [m for m in w.morphemes if match(m.form)]
                        if not hit_morphs:
                            continue
                    elif field.scope == 'Word':
                        sp = w.fields.get(field.name)
                        if not (sp and match(sp.value)):
                            continue
                    else:
                        hit_morphs = [m for m in w.morphemes
                                      if field.name in m.fields and match(m.fields[field.name].value)]
                        if not hit_morphs:
                            continue
                    for hit in (hit_morphs or [None]):
                        total += 1
                        if len(hits) < limit:
                            hits.append((doc, s, w, hit))
    if not total:
        return f'No occurrences of "{pattern}".'
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
    lines = [f'{total} occurrence{"s" if total != 1 else ""} of "{pattern}" in {where_l if not field else field.name}'
             + (f' (showing {limit})' if total > limit else '') + '.',
             'Word patterns (hit in [brackets]), by frequency' + (f', among the {len(hits)} shown' if total > len(hits) else '') + ':']
    for key, n in sorted(patterns.items(), key=lambda kv: (-kv[1], kv[0]))[:25]:
        lines.append(f'  {n}\t{key}')
    if len(patterns) > 25:
        lines.append(f'  ... {len(patterns) - 25} more patterns')
    lines.append('Occurrences (previous [word] next | segmentation | morpheme fields || sentence):')
    lines.extend('  ' + h for h in lines_out)
    return truncate('\n'.join(lines))


MAX_FORMS_PER_CALL = 40


def t_analyses_of(ws: Workspace, form: Optional[str] = None, document: Optional[str] = None,
                  forms: Optional[list] = None) -> str:
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
    if len(wanted) > 1:
        return truncate('\n\n'.join(_analyses_of_one(ws, f, document) for f in wanted))
    return truncate(_analyses_of_one(ws, wanted[0], document))


def _analyses_of_one(ws: Workspace, form: str, document: Optional[str]) -> str:
    if not ws.use_scan(document):
        from .queries import q_analyses_of
        return q_analyses_of(ws, form)
    key = form.casefold()
    docs = [ws.doc(document)] if document else ws.all_docs()
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    wfields = [f.name for f in ws.project.fields_by_scope('Word')]
    word_tally: Dict[str, List[str]] = {}
    morph_tally: Dict[str, List[str]] = {}
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            for w in s.words:
                ref = f'{tag}{word_ref(s, w)}'
                if w.surface.casefold() == key:
                    parts = []
                    seg = segmentation(w)
                    if len(w.morphemes) > 1 or (w.morphemes and seg != w.surface):
                        parts.append('seg=' + seg)
                        for f in mfields:
                            line = _bracket_line(w, None, f)
                            if line.replace('_', '').replace('-', '').replace('=', ''):
                                parts.append(f'{f}={line}')
                        types = [m.morph_type for m in w.morphemes if m.morph_type]
                        if types:
                            parts.append('types=' + ','.join(m.morph_type or '?' for m in w.morphemes))
                    for f in wfields:
                        sp = w.fields.get(f)
                        if sp and sp.value != '':
                            parts.append(f'{f}={sp.value}')
                    if w.link:
                        parts.append(f'link={w.link.form}')
                    for l in w.mwes:
                        parts.append(f'mwe={l.form}')
                    mlinks = [f'm{m.index}:{m.link.form}' for m in w.morphemes if m.link]
                    if mlinks:
                        parts.append('mlinks=' + ' '.join(mlinks))
                    word_tally.setdefault(' | '.join(parts) or '(unanalyzed)', []).append(ref)
                for m in w.morphemes:
                    if m.form.casefold() == key:
                        parts = []
                        if m.morph_type:
                            parts.append(f'type={m.morph_type}')
                        for f in mfields:
                            sp = m.fields.get(f)
                            if sp and sp.value != '':
                                parts.append(f'{f}={sp.value}')
                        if m.link:
                            parts.append(f'link={m.link.form}')
                        pos = 'only' if len(w.morphemes) == 1 else ('first' if m.index == 1 else
                                                                   'last' if m.index == len(w.morphemes) else 'middle')
                        morph_tally.setdefault((' | '.join(parts) or '(unglossed)') + f'  [{pos} in word]', []
                                               ).append(f'{ref}.m{m.index} ({segmentation(w)})')
    lines = []
    for title, tally in ((f'Word "{form}"', word_tally), (f'Morpheme "{form}"', morph_tally)):
        if not tally:
            lines.append(f'{title}: no occurrences.')
            continue
        n = sum(len(v) for v in tally.values())
        lines.append(f'{title}: {n} occurrence{"s" if n != 1 else ""}, {len(tally)} distinct analys{"es" if len(tally) != 1 else "is"}:')
        for analysis, refs in sorted(tally.items(), key=lambda kv: -len(kv[1])):
            lines.append(f'  {len(refs)}\t{analysis}  e.g. {", ".join(refs[:3])}')
    return '\n'.join(lines)


def t_lexicon_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, examples: int = 3, entry_gloss: Optional[str] = None) -> str:
    """One lexicon entry in full: every field, where it is linked (words vs
    morphemes, how many), and example occurrences."""
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
    if view is not None:
        lines.extend(f'  {r}' for r in view.ref_summary(target))
        lines.extend(_dictionary_lines(ws, view, target))
    word_links, morph_links, mwes, exs = 0, 0, 0, []
    examples = read_int(examples, 'examples', 3, minimum=0, maximum=20)
    if not ws.prefer_scan:
        from .queries import q_entry_usage
        word_links, morph_links, mwes, exs = q_entry_usage(ws, target['id'], examples)
    seen_mwes = set()
    for doc in (ws.all_docs() if ws.prefer_scan else []):
        tag = ws.doc_tag(doc)
        for s in doc.sentences:
            for w in s.words:
                hit = False
                if w.link and w.link.item_id == target['id']:
                    word_links += 1
                    hit = True
                for l in w.mwes:
                    if l.item_id == target['id']:
                        word_links += 1  # one per member word, as the query path counts tokens
                        seen_mwes.add(l.id)
                        hit = True
                for m in w.morphemes:
                    if m.link and m.link.item_id == target['id']:
                        morph_links += 1
                        hit = True
                if hit and len(exs) < examples:
                    exs.append(f'  {tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    if ws.prefer_scan:
        mwes = len(seen_mwes)
    lines.append(f'Linked from {word_links} word{"s" if word_links != 1 else ""} and {morph_links} morpheme{"s" if morph_links != 1 else ""}'
                 + (f' ({mwes} multi-word expression{"s" if mwes != 1 else ""})' if mwes else '') + '.')
    if exs:
        lines.append('Examples:')
        lines.extend(exs)
    return truncate('\n'.join(lines))


def _dictionary_lines(ws: Workspace, view: LexView, target: dict) -> List[str]:
    """An entry's place in its lexicon: the senses under it, what refers to it,
    and its promoted examples."""
    out: List[str] = []
    senses = view.tree.senses_of(target['id'])
    if senses:
        out.append(f'Senses ({len(senses)}):')
        for c in senses:
            out.append(f'  {view.number(c["id"])} {entry_line(c, view)}')
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
    if not ws.use_scan(document):
        from .queries import q_consistency
        values, by_form, (unlinked_n, unlinked), (linked_empty_n, linked_empty) = q_consistency(ws, f)
        return _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty,
                                  ws.corpus.clipped_note(f'{f.name} values'))
    docs = [ws.doc(document)] if document else ws.all_docs()
    values: Counter = Counter()
    by_form: Dict[str, Counter] = {}
    unlinked: List[str] = []
    unlinked_n = 0
    linked_empty: List[str] = []
    linked_empty_n = 0
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            if f.scope == 'Sentence':
                sp = s.fields.get(f.name)
                if sp and sp.value != '':
                    values[sp.value] += 1
                continue
            for w in s.words:
                units = [(w, w.surface, f'{tag}{word_ref(s, w)}')] if f.scope == 'Word' else \
                    [(m, m.form, f'{tag}{word_ref(s, w)}.m{m.index}') for m in w.morphemes]
                for u, form, ref in units:
                    sp = u.fields.get(f.name)
                    val = sp.value if sp else ''
                    if val != '':
                        values[val] += 1
                        by_form.setdefault(form.casefold(), Counter())[val] += 1
                        if not u.link and not getattr(u, 'mwes', None):
                            unlinked_n += 1
                            if len(unlinked) < 15:
                                unlinked.append(f'{ref} {form} ({val})')
                    elif u.link or getattr(u, 'mwes', None):
                        linked_empty_n += 1
                        if len(linked_empty) < 15:
                            linked_empty.append(f'{ref} {form} → {linked_form(u)}')
    return _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty)


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


# How far back recent_changes looks when no `since` is given, widening until
# it has enough entries: the audit endpoint pages from the OLDEST entry, so
# an unbounded read of a long-lived project would fetch its whole history to
# show the newest twenty.
AUDIT_WINDOWS_DAYS = (7, 30, 180, 730, None)


def _audit_entries(ws: Workspace, document: Optional[str], start: Optional[str], keep) -> list:
    """The audit entries at or after ``start`` that ``keep`` accepts."""
    try:
        if document:
            did = ws.resolve_document_id(document)
            entries = ws.client.documents.audit(did, start_time=start)
        else:
            entries = ws.client.projects.audit(ws.project.id, start_time=start)
    except ToolError:
        raise
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The change history', e) from None
    return [e for e in entries or [] if keep(e)]


def t_recent_changes(ws: Workspace, document: Optional[str] = None, limit: Optional[int] = None,
                     since: Optional[str] = None, user: Optional[str] = None) -> str:
    """The newest entries of the audit log: who changed what, when, under
    which operation label (the assistant's own applied plans included).
    `since` is a date (YYYY-MM-DD) or timestamp; `user` matches the actor's
    name or email. Without `since`, recent windows are read first and
    widened until `limit` entries are in hand."""
    import datetime
    limit = clamp_limit(limit, *READ_LIMITS['recent_changes'])
    ws.on_progress('Reading the change history…')
    u = (user or '').casefold()

    def keep(e):
        return not u or u in ((e.get('user') or {}).get('display_name') or '').casefold() \
            or u in ((e.get('user') or {}).get('id') or '').casefold()

    if since:
        start = since.strip()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
            start += 'T00:00:00Z'
        entries = _audit_entries(ws, document, start, keep)
    else:
        now = datetime.datetime.now(datetime.timezone.utc)
        entries = []
        for days in AUDIT_WINDOWS_DAYS:
            start = (now - datetime.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ') if days else None
            entries = _audit_entries(ws, document, start, keep)
            if len(entries) >= limit:
                break
    entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        return 'No changes recorded.'
    lines = [f'{len(entries)} most recent change{"s" if len(entries) != 1 else ""}'
             + (f' since {since}' if since else '') + (f' by "{user}"' if user else '')
             + ' (newest first; as_of= is the moment right after that change, for restore_document):']
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        when = (e.get('time') or '')[:16].replace('T', ' ')
        after = e.get('end_time') or e.get('time') or ''
        ops = e.get('ops') or []
        kinds: Counter = Counter(o.get('type') for o in ops)
        what = e.get('message') or (ops[0].get('description') if len(ops) == 1 and ops else
                                    ', '.join(f'{n}× {k}' for k, n in kinds.most_common(4)))
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])[:3])
        lines.append(f'  {when}  {who}: {what}' + (f'  [{docs}]' if docs else '')
                     + (f'  ({len(ops)} ops)' if len(ops) > 1 else '') + f'  as_of={after}')
    return truncate('\n'.join(lines))


def t_plan_status(ws: Workspace) -> str:
    if not ws.ops:
        return 'The plan is empty.'
    lines = [f'{len(ws.ops)} planned change{"s" if len(ws.ops) != 1 else ""} (nothing written yet):']
    lines.extend(f'  {i + 1}. {op["label"]}' for i, op in enumerate(ws.ops[:200]))
    if len(ws.ops) > 200:
        lines.append(f'  ... {len(ws.ops) - 200} more')
    return '\n'.join(lines)

