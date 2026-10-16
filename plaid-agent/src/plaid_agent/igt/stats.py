"""Corpus-wide reads: numbers, worklists, lexicon and integrity reports, and
sequence search. They run on the query engine (see queries.py), held to one
document with ``document=``. check_integrity reads the documents themselves
(it inspects raw text)."""

import difflib
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

from .project import (IgtDoc, Word, render_word, segmentation, word_ref)
from ..core.tools import ToolError, truncate
from .lexview import entry_line
from .workspace import Workspace
from .vocab import descendants_of, validate_vocab_refs
from ..core.args import clamp_limit, read_int
from ..core.limits import NGRAM_MAX, READ_LIMITS
from .media import clock, past_end, recording_of


def _pct(n, d):
    return f'{(100.0 * n / d):.0f}%' if d else 'n/a'


def _docs(ws: Workspace, document: Optional[str]) -> List[IgtDoc]:
    """The documents a walk reads: the one named, those a ``documents``
    argument holds the call to, or all."""
    if document:
        return [ws.doc(document)]
    held = ws.corpus.documents
    return [ws.doc(i) for i in held] if held else ws.all_docs()


def _tag(ws, docs, doc):
    return ws.doc_tag(doc, len(docs) > 1)


def _analyzed(w: Word) -> bool:
    """Has any analysis at all: a non-default segmentation, any field value,
    or any link."""
    if w.fields or w.link or w.mwes:
        return True
    if len(w.morphemes) > 1:
        return True
    for m in w.morphemes:
        if m.fields or m.link or m.morph_type or m.form != w.surface:
            return True
    return False


# --- corpus_stats -----------------------------------------------------------------

def merge_numbers(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Sum per-document number dicts that carry their form tallies."""
    total: Dict[str, Any] = {}
    for k in ('sentences', 'words', 'morphemes', 'analyzed', 'linked'):
        total[k] = sum(r[k] for r in rows)
    forms: Counter = Counter()
    mforms: Counter = Counter()
    for r in rows:
        forms.update(r.get('_forms') or {})
        mforms.update(r.get('_mforms') or {})
    total['forms'] = len(forms)
    total['hapax'] = sum(1 for n in forms.values() if n == 1)
    total['morpheme_forms'] = len([f for f in mforms if f])
    total['morpheme_hapax'] = sum(1 for f, n in mforms.items() if f and n == 1)
    total['ttr'] = (len(forms) / total['words']) if total['words'] else 0.0
    total['longest'] = []
    for k in rows[0] if rows else ():
        if k.startswith('field:'):
            total[k] = (sum(r[k][0] for r in rows), sum(r[k][1] for r in rows))
    return total


def t_corpus_stats(ws: Workspace, document: Optional[str] = None, by: Optional[str] = None) -> str:
    """Totals and coverage for the project or one document; with `by`, a
    per-document table (`by="document"`) or a breakdown by a document
    metadata field (`by="Genre"`)."""
    project = ws.project
    lines: List[str] = []
    from .queries import q_backward_segments, q_corpus_numbers, q_segments
    with ws.corpus.within(document) as held:
        names = {held: ws.corpus.doc_name(held)} if held else {
            i: n for i, n in ws.corpus.doc_names().items() if not ws.corpus.documents or i in ws.corpus.documents}
        n_docs = len(names)
        # The time alignment, and the recordings' lengths where there is one
        # (survey item 11). A project with no segments reads no recording.
        times = q_segments(ws)
        recs = recordings(ws, names) if times else {}
        # Left out of every count of time, as the editor leaves them out, and
        # said, so a total is never read as the whole recording's.
        backward = q_backward_segments(ws)
        if by is None:
            whole = q_corpus_numbers(ws, per_doc=False)
            # One document is loaded whole, so its longest words can be named.
            if held:
                whole['longest'] = sorted((w for s in ws.doc(held).sentences for w in s.words),
                                          key=lambda w: -len(w.morphemes))[:3]
        else:
            rows = q_corpus_numbers(ws, per_doc=True)
            for did in names:
                rows.setdefault(did, q_corpus_numbers.empty(project))
            metas = ws.corpus.document_metadata()

            def total(ids):
                return merge_numbers([rows[i] for i in ids])
        clipped = ws.corpus.clipped_note('counts')
    if backward:
        clipped = (f'\n{backward} segment{"s" if backward != 1 else ""} whose end is before '
                   f'{"their" if backward != 1 else "its"} start {"are" if backward != 1 else "is"} left out.'
                   + clipped)

    def describe(n: Dict[str, Any], docs_n: int, head: str, ids=None):
        lines.append(head)
        lines.append(f'  {docs_n} document{"s" if docs_n != 1 else ""}, {n["sentences"]} sentences, {n["words"]} words '
                     f'({n["forms"]} distinct forms, {n["hapax"]} hapax, type/token {n["ttr"]:.2f}), '
                     f'{n["morphemes"]} morphemes ({n["morpheme_forms"]} distinct'
                     + (f', {n["morpheme_hapax"]} hapax' if 'morpheme_hapax' in n else '') + ')')
        lines.append(f'  Words with any analysis: {_pct(n["analyzed"], n["words"])}'
                     + (f'; linked to the lexicon: {_pct(n["linked"], n["words"])}' if project.vocabs else ''))
        cov = []
        for f in project.fields.values():
            filled, of = n[f'field:{f.name}']
            cov.append(f'{f.name} {_pct(filled, of)} ({filled}/{of} {f.scope.lower()}s)')
        if cov:
            lines.append('  Field coverage: ' + ', '.join(cov))
        longest = n.get('longest') or []
        if longest and longest[0].morphemes and len(longest[0].morphemes) > 1:
            lines.append('  Longest words: ' + ', '.join(f'{w.surface} ({len(w.morphemes)}: {segmentation(w)})'
                                                        for w in longest if len(w.morphemes) > 1))
        if times:
            lines.append('  ' + time_line(times, recs, list(names) if ids is None else ids))

    ws.note_read(n_docs, 'document')
    if by is None:
        describe(whole, n_docs, f'Project "{project.name}"' if not document else f'Document {ws.doc_label(next(iter(names)), quote=True)}')
        return truncate(_with_note(lines, clipped))

    if by.lower() == 'document':
        gm, gs = project.gloss_field('Morpheme') or project.gloss_field('Word'), project.gloss_field('Sentence')
        first_m, first_s = (gm.name if gm else None), (gs.name if gs else None)
        head = ['document', 'sentences', 'words', 'analyzed', 'linked' if project.vocabs else None,
                f'{first_m}' if first_m else None, f'{first_s}' if first_s else None, 'hapax', 'TTR']
        head += ['segments', 'transcribed', 'recording'] if times else []
        head += project.document_metadata
        lines.append('\t'.join(h for h in head if h))
        for did in sorted(rows, key=lambda i: (names.get(i) or '').lower()):
            n = rows[did]
            cells = [ws.doc_label(did), str(n['sentences']), str(n['words']), _pct(n['analyzed'], n['words']),
                     _pct(n['linked'], n['words']) if project.vocabs else None,
                     _pct(*n[f'field:{first_m}']) if first_m else None,
                     _pct(*n[f'field:{first_s}']) if first_s else None,
                     _pct(n['hapax'], n['words']), f'{n["ttr"]:.2f}']
            if times:
                t = times.get(did) or {}
                cells += [str(t.get('segments', 0)), clock(t['seconds']) if t else '',
                          clock(recs[did]) if did in recs else '']
            cells += [str((metas.get(did) or {}).get(k, '') or '') for k in project.document_metadata]
            lines.append('\t'.join(c for c in cells if c is not None))
        return truncate(_with_note(lines, clipped))

    key = next((k for k in project.document_metadata if k.lower() == by.lower()), None)
    if not key:
        raise ToolError('by must be "document" or a document metadata field: ' + ', '.join(project.document_metadata))
    groups: Dict[str, List[str]] = defaultdict(list)
    for did in rows:
        groups[str((metas.get(did) or {}).get(key, '') or '(none)')].append(did)
    for val, ids in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        describe(total(ids), len(ids), f'{key} = {val}', ids)
    return truncate(_with_note(lines, clipped))


def recordings(ws: Workspace, names: Dict[str, str]) -> Dict[str, Optional[float]]:
    """The documents among ``names`` that have a recording, each with its
    length in seconds as core stored it (None when unknown). One light read
    of each document not loaded this turn (media.py)."""
    out: Dict[str, Optional[float]] = {}
    for did in names:
        has, seconds = recording_of(ws, did)
        if has:
            out[did] = seconds
    return out


def time_line(times: Dict[str, Dict[str, float]], recs: Dict[str, Optional[float]], ids: List[str]) -> str:
    """``Time alignment: 1,030 segments in 3 documents, 18:02 transcribed
    (segment lengths summed); recordings: 3 documents, 1:02:13 in all.``"""
    held = [times[i] for i in ids if i in times]
    n = sum(t['segments'] for t in held)
    secs = sum(t['seconds'] for t in held)
    line = (f'Time alignment: {n:,} segment{"s" if n != 1 else ""} in {len(held)} document'
            f'{"s" if len(held) != 1 else ""}, {clock(secs)} transcribed (segment lengths summed)')
    have = [i for i in ids if i in recs]
    known = [recs[i] for i in have if recs[i] is not None]
    if have and not known:
        line += f'; recordings: {len(have)} document{"s" if len(have) != 1 else ""}, of unknown length'
    elif have:
        line += (f'; recordings: {len(have)} document{"s" if len(have) != 1 else ""}, {clock(sum(known))} in all'
                 + (f' ({len(have) - len(known)} of unknown length, left out)' if len(known) < len(have) else ''))
    else:
        line += '; no recordings'
    # Segments past the end of their recording (H16-IGT-TOOLS-7).
    past = [i for i in have if i in times and past_end(times[i]['last'], recs[i])]
    if past:
        line += (f'; in {len(past)} document{"s" if len(past) != 1 else ""} the segments run past the end '
                 'of the recording')
    return line + '.'


# --- frequency_list -----------------------------------------------------------------



def t_frequency_list(ws: Workspace, what: str = 'wordform', document: Optional[str] = None,
                     limit: Optional[int] = None, min_count: int = 1, where: Optional[dict] = None,
                     ngram: Optional[int] = None) -> str:
    """Counts with document dispersion for wordforms, morpheme forms, or a
    field's values. ``where`` counts only the words meeting one word's
    conditions (as a sequence_search step takes them) and the morphemes and
    values on them. ``ngram`` counts sequences of adjacent words in a
    sentence instead (their forms, or a word field's values), for word-order
    questions (survey item 8)."""
    from .bulk import condition_of
    limit = clamp_limit(limit, *READ_LIMITS['frequency_list'])
    min_count = read_int(min_count, 'min_count', 1, minimum=1)
    what_l = (what or 'wordform').lower()
    field = None
    if what_l not in ('wordform', 'word', 'morpheme'):
        field = ws.project.field(what)
    cond = condition_of(where)
    n = read_int(ngram, 'ngram', 1, minimum=1) if ngram is not None else 1
    if n > NGRAM_MAX:
        raise ToolError(f'ngram is at most {NGRAM_MAX}. For longer patterns use sequence_search.')
    if n > 1:
        if what_l == 'morpheme' or (field is not None and field.scope != 'Word'):
            raise ToolError('ngram counts sequences of words: what="wordform" or a word field '
                            '(' + (', '.join(f.name for f in ws.project.fields_by_scope('Word')) or 'none') + ').')
        if cond:
            raise ToolError('where and ngram do not combine. For sequences with conditions on their words use '
                            'sequence_search.')
    from .queries import q_frequency_list, q_ngrams
    with ws.corpus.within(document):
        if n > 1:
            items, spread = q_ngrams(ws, field, n)
            empty = None
        else:
            items, spread, empty = q_frequency_list(ws, what_l, field, limit, min_count, cond)
    if n > 1:
        items = [(k, c) for k, c in items if c >= min_count]
    noun = _freq_noun(field, what_l) if n == 1 else \
        f'{field.name if field else "word"} {"bigrams" if n == 2 else f"{n}-grams"}'
    # Forms are counted case folded, a field's values as stored, and the
    # header says which. A sequence's count is of its occurrences.
    return _frequency_lines(ws, items, spread, empty, field, what_l, limit,
                            ws.corpus.clipped_note(noun), noun=noun, held=condition_words_of(cond),
                            folded=field is None, unit='tokens' if n == 1 else 'occurrences')


def condition_words_of(cond) -> str:
    from .bulk import condition_words
    return condition_words(cond)


def _with_note(lines, clipped: str) -> str:
    """The clipped warning on the FIRST line, where `truncate` cannot cut it.
    Appended last it was the first thing lost on exactly the long report that
    had something to warn about."""
    if not clipped:
        return '\n'.join(lines)
    head = (lines[0] + clipped) if lines else clipped.lstrip()
    return '\n'.join([head] + list(lines[1:]))


def _freq_noun(field, what_l: str) -> str:
    return field.name + ' values' if field else ('wordforms' if what_l != 'morpheme' else 'morpheme forms')


def _frequency_lines(ws, items, spread, empty, field, what_l, limit, clipped: str = '', noun: Optional[str] = None,
                     held: str = '', folded: bool = False, unit: str = 'tokens') -> str:
    noun = noun or _freq_noun(field, what_l)
    ws.note_read(min(len(items), limit), 'row', of=len(items))
    lines = [f'{len(items)} {noun}' + (', case folded' if folded else '') + f'{held}, {sum(n for _, n in items)} {unit}'
             + (f', {empty} empty' if field and empty is not None else '')
             + (f' (showing {limit})' if len(items) > limit else '') + '. count\tdocuments\tform' + clipped]
    for k, n in sorted(items, key=lambda kv: (-kv[1], kv[0].casefold(), kv[0]))[:limit]:
        lines.append(f'  {n}\t{len(spread.get(k) or ())}\t{k}')
    return truncate('\n'.join(lines))


# --- worklist ----------------------------------------------------------------------

KINDS = ('unlinked', 'unglossed', 'unanalyzed', 'unverified', 'contributed')


def t_worklist(ws: Workspace, kind: str = 'unglossed', field: Optional[str] = None, level: Optional[str] = None,
               document: Optional[str] = None, limit: Optional[int] = None, user: Optional[str] = None) -> str:
    """The unfinished work grouped by form, most frequent first: forms that are
    unlinked, lack a field value, have no analysis at all, or carry
    annotations awaiting review (machine-made and unconfirmed, or a
    contributor's; ``contributed`` narrows to the latter, ``user`` to one
    contributor)."""
    kind = (kind or 'unglossed').lower()
    if kind not in KINDS:
        raise ToolError('kind must be one of: ' + ', '.join(KINDS))
    user = (user or '').strip() or None
    if user and kind != 'contributed':
        raise ToolError('user= goes with kind="contributed"')
    project = ws.project
    limit = clamp_limit(limit, *READ_LIMITS['worklist'])
    f = None
    if kind == 'unglossed':
        if field:
            f = project.field(field)
        else:
            f = project.gloss_field('Morpheme') or project.gloss_field('Word')
            if not f:
                raise ToolError('No word or morpheme field to check; name one with field=')
    lvl = (level or '').lower() or ('morpheme' if (project.morpheme_layer_id and kind in ('unlinked', 'unglossed')
                                                 and (f is None or f.scope == 'Morpheme')) else 'word')
    if f and f.scope == 'Word':
        lvl = 'word'
    if f and f.scope == 'Sentence':
        lvl = 'sentence'
    from .queries import q_worklist
    with ws.corpus.within(document) as held:
        # Three examples per form is enough to SEE what is unfinished across
        # a corpus, and they name documents. It is not enough to ACT on one
        # document: a form unglossed ten times gives three and no way to the
        # other seven but reading. So naming a document lists every reference,
        # which is the list to plan from.
        counts, examples = q_worklist(ws, kind, f, lvl, user, refs=bool(held))
    return _worklist_lines(ws, kind, f, lvl, limit, counts,
                           {k: v[:limit] for k, v in examples.items()}, user, ws.corpus.clipped_note(f'{lvl}s'))


def _worklist_lines(ws, kind, f, lvl, limit, counts: Dict[str, int], examples: Dict[str, List[str]],
                    user: Optional[str] = None, clipped: str = '') -> str:
    total = sum(counts.values())
    groups = counts
    ws.note_read(min(len(groups), limit), 'row', of=len(groups))
    what = {'unlinked': f'{lvl}s not linked to the lexicon',
            'unglossed': f'{lvl}s without a {f.name if f else ""} value' + (' (grouped by document)' if lvl == 'sentence' else ''),
            'unanalyzed': 'words with no analysis at all',
            'unverified': 'words with annotations awaiting review (machine-made and unconfirmed, or a contributor\'s)',
            'contributed': 'words with unreviewed contributions' + (f' by {user}' if user else '')}[kind]
    if not total:
        # A clipped read that came back empty is the most misleading of all:
        # "nothing to do" for a corpus that may be full of it.
        return f'Nothing to do: no {what}.' + clipped
    lines = [f'{total} {what} across {len(groups)} distinct forms' + (f' (showing {limit})' if len(groups) > limit else '')
             + '. count\tform\texamples' + clipped]
    for form, n in sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]:
        lines.append(f'  {n}\t{form}\t{", ".join(examples.get(form) or [])}')
    return truncate('\n'.join(lines))


# --- check_lexicon -------------------------------------------------------------------

def _strip_affix(form: str) -> str:
    return (form or '').strip('-=~ ').casefold()


def _note_stale(stale: Counter, item: dict, form: str) -> Optional[tuple]:
    """Count a link as stale when its entry's form is no longer contained in
    the linked form: containment, not equality, since a word may link to its
    stem's entry; a multi-word expression's linked form is its members'
    surfaces in text order. Keyed by (linked form, entry form), the key
    returned when it counted."""
    entry = item.get('form') or ''
    if _strip_affix(entry) not in _strip_affix(form):
        stale[(form, entry)] += 1
        return (form, entry)
    return None


LEXICON_SECTIONS = ('unused', 'fields', 'homographs', 'near', 'glosses', 'spread', 'stale', 'single', 'refs')


def t_check_lexicon(ws: Workspace, lexicon: Optional[str] = None, section: Optional[str] = None) -> str:
    """Lexicon hygiene: entries never linked, entries missing gloss or POS,
    homographs, near-duplicate forms, entries whose lexicon gloss disagrees
    with the corpus, links whose form no longer matches the entry, one corpus
    gloss spread over several entries, entries attested in a single document."""
    project = ws.project
    vocabs = [project.vocab(lexicon)] if lexicon else project.vocabs
    if not vocabs:
        ws.note_read(0, 'entry')
        return 'This project has no lexicon.'
    section = (section or 'all').lower()
    if section != 'all' and section not in LEXICON_SECTIONS:
        raise ToolError('section must be "all" or one of: ' + ', '.join(LEXICON_SECTIONS))
    only = None if section == 'all' else section
    cap = 200 if only else 12  # one section: generous; the overview: a taste of each
    want = lambda name: only is None or only == name  # noqa: E731
    items: Dict[str, dict] = {}
    item_vocab: Dict[str, str] = {}
    views = {v['id']: ws.view(v) for v in vocabs}
    for v in vocabs:
        for it in ws.lexicon(v):
            items[it['id']] = it
            item_vocab[it['id']] = v['id']

    def view_of(iid: str):
        return views.get(item_vocab.get(iid))

    def is_sense(iid: str) -> bool:
        vw = view_of(iid)
        return bool(vw and vw.is_sense(iid))

    def tree_uses(iid: str) -> int:
        """Links to an entry and to everything under it: a sense is attested
        through its entry, since the corpus links whichever the analyst chose."""
        vw = view_of(iid)
        if vw is None:
            return uses[iid]
        return uses[iid] + sum(uses[d['id']] for d in descendants_of(vw.tree, iid))

    ws.note_read(len(items), 'entry')
    n_docs = len(ws.documents())
    # The lexicon's own gloss and POS fields, by each lexicon's schema.
    lex_gloss = {v['id']: project.lexicon_field(v, 'gloss') for v in vocabs}
    lex_pos = {v['id']: project.lexicon_field(v, 'pos') for v in vocabs}

    def entry_gloss(it: dict) -> str:
        fld = lex_gloss.get(item_vocab.get(it['id']))
        return str((it.get('metadata') or {}).get(fld) or '').strip() if fld else ''
    from .queries import q_lexicon_usage
    uses, use_docs, corpus_gloss, gloss_items, stale, stale_docs = q_lexicon_usage(ws, vocabs, items)
    lines = [f'Lexicon check: {len(items)} entries in {", ".join(v["name"] for v in vocabs)}, {sum(uses.values())} links'
             + (f'; section "{only}"' if only else '; each section capped, ask for one section for the full list') + '.']

    def listing(title, forms, noun='entries'):
        forms = list(forms)
        lines.append(f'{len(forms)} {title}' + (': ' + ', '.join(forms[:cap]) + (f' … ({len(forms) - cap} more)' if len(forms) > cap else '') if forms else '.'))

    if want('unused'):
        listing('entries never linked from a text',
                (it.get('form') or '' for it in items.values()
                 if not is_sense(it['id']) and tree_uses(it['id']) == 0))
        # A sense of an attested entry is normal, not a defect: the corpus
        # links the entry the analyst picked, which is often the headword.
        loose = [it for it in items.values()
                 if is_sense(it['id']) and uses[it['id']] == 0 and tree_uses(view_of(it['id']).tree.root_of[it['id']])]
        # Stated at zero like every other count in this report, but only for a
        # lexicon that HAS senses: on a word list the line is about nothing.
        if any(is_sense(it['id']) for it in items.values()):
            lines.append(f'{len(loose)} senses not linked from a text themselves, '
                         'though their entry is attested.')
    def stands_over_senses(iid: str) -> bool:
        """A headword whose meanings are its senses. It is not missing a gloss:
        the senses under it carry them, and a FLEx import makes such a headword
        for every entry it read with more than one sense."""
        vw = view_of(iid)
        return bool(vw and vw.tree.children_of.get(iid))

    if want('fields'):
        for role, table in (('gloss', lex_gloss), ('pos', lex_pos)):
            names = sorted({f for f in table.values() if f})
            if not names:
                continue
            listing(f'entries without a {"/".join(names)}',
                    (it.get('form') or '' for it in items.values()
                     if table.get(item_vocab[it['id']])
                     and not (it.get('metadata') or {}).get(table[item_vocab[it['id']]])
                     and not stands_over_senses(it['id'])))

    by_form: Dict[str, List[dict]] = defaultdict(list)
    for it in items.values():
        by_form[_strip_affix(it.get('form'))].append(it)
    # Senses share their entry's headword, so grouping every item by form would
    # call each of them a homograph of the rest. Only entries are compared.
    by_entry_form: Dict[str, List[dict]] = defaultdict(list)
    for it in items.values():
        if not is_sense(it['id']):
            by_entry_form[_strip_affix(it.get('form'))].append(it)
    if want('homographs'):
        homographs = {k: v for k, v in by_entry_form.items() if len(v) > 1}
        if homographs:
            def same_gloss(its):
                gl = [entry_gloss(it).casefold() for it in its]
                return len(gl) - len(set(gl))
            ranked = sorted(homographs.items(), key=lambda kv: (-same_gloss(kv[1]), -len(kv[1])))
            dup = sum(1 for _, its in ranked if same_gloss(its))
            lines.append(f'{len(homographs)} homograph groups ({dup} with a repeated gloss, likely '
                         'duplicates; the rest are separate entries sharing a form):')
            for k, its in ranked[:cap]:
                lines.append('  ' + ' | '.join(
                    f'{entry_line(it, view_of(it["id"]))} ({tree_uses(it["id"])} links)' for it in its))
            if len(ranked) > cap:
                lines.append(f'  … {len(ranked) - cap} more groups')
        else:
            lines.append('No homographs.')

    forms = sorted(by_entry_form)
    near: List[str] = []
    buckets: Dict[tuple, List[str]] = defaultdict(list)
    for fm in forms:
        for L in (len(fm) - 1, len(fm), len(fm) + 1):
            buckets[(fm[:1], L)].append(fm)
    seen = set()
    for fm in forms:
        for other in buckets[(fm[:1], len(fm))]:
            if other <= fm or (fm, other) in seen:
                continue
            seen.add((fm, other))
            if abs(len(fm) - len(other)) <= 1 and difflib.SequenceMatcher(None, fm, other).ratio() >= 0.8 \
                    and sum(a != b for a, b in zip(fm, other)) + abs(len(fm) - len(other)) == 1:
                near.append(f'{fm} / {other}')
    if want('near'):
        listing('pairs of forms one character apart (possible variants or duplicates)', near, 'pairs')

    if want('refs'):
        # A reference that resolves to nothing: an entry deleted through the
        # API or by another app. The app clears these when a maintainer opens
        # the vocabulary, so this only reports them.
        dangling = []
        for v in vocabs:
            for f in validate_vocab_refs(ws.lexicon(v), v['fields'])[1]:
                dangling.append(f'  {f.get("form")}: ' + '; '.join(f['reasons']))
        if dangling:
            lines.append(f'{len(dangling)} entr{"y" if len(dangling) == 1 else "ies"} whose references point '
                         'nowhere (a maintainer opening the vocabulary clears them):')
            lines.extend(dangling[:cap])
            if len(dangling) > cap:
                lines.append(f'  … {len(dangling) - cap} more')
        else:
            lines.append('No references pointing nowhere.')

    disagree = []
    for iid, c in corpus_gloss.items():
        lex = entry_gloss(items[iid])
        top, n = c.most_common(1)[0]
        if lex and top.casefold() != lex.casefold():
            disagree.append(f'{items[iid].get("form")}: lexicon "{lex}", corpus mostly "{top}" ({n}/{sum(c.values())})')
    if want('glosses'):
        lines.append(f'{len(disagree)} entries whose gloss disagrees with the corpus' + (':\n  ' + '\n  '.join(disagree[:cap])
                     + (f'\n  … {len(disagree) - cap} more' if len(disagree) > cap else '') if disagree else '.'))
    if want('spread'):
        spread = {g: ids for g, ids in gloss_items.items() if len(ids) > 1}
        listing('corpus glosses linked to several entries', (f'{g} → {", ".join(items[i].get("form") or "" for i in ids)}' for g, ids in spread.items()))
    if want('stale'):
        # Spelled out which side is which: "he → "se"" was read backwards,
        # and the model looked up "he" as the entry (2026-10-12 survey).
        names = ws.corpus.doc_names() if stale else {}
        shown = [f'text "{form}" linked to entry "{entry}"' + (f' ×{n}' if n > 1 else '')
                 + (f' (e.g. in {ws.doc_label(stale_docs[(form, entry)], quote=True)})'
                    if stale_docs.get((form, entry)) and len(names) > 1 else '')
                 for (form, entry), n in sorted(stale.items(), key=lambda kv: (-kv[1], kv[0]))]
        lines.append(f'{sum(stale.values())} links whose form no longer contains the entry form'
                     + (': ' + '; '.join(shown[:cap]) + (' …' if len(shown) > cap else '') if shown else '.'))
    if want('single') and n_docs > 1:
        listing('entries attested in a single document', (items[i].get('form') or '' for i, ds in use_docs.items() if len(ds) == 1))
    # The sixth report, and the one with the widest grouping: one row per
    # link-token. Past the group limit "entries never linked" lists entries
    # whose links fell off the end of the read.
    return truncate(_with_note(lines, ws.corpus.clipped_note('links')))


# --- check_integrity ----------------------------------------------------------------

APOSTROPHES = "'’ʼ‘`´ʻ"


def t_check_integrity(ws: Workspace, document: Optional[str] = None) -> str:
    """Data-shape problems: segmentations that do not add up to the word,
    duplicate sentences, empty sentences, non-NFC text, mixed apostrophe
    characters, and the inventory of unusual characters in the baseline."""
    docs = _docs(ws, document)
    ws.note_read(len(docs), 'document')
    mismatch: List[str] = []
    mismatch_n = 0
    formless: List[str] = []
    formless_n = 0
    dups: Dict[str, List[str]] = defaultdict(list)
    empty: List[str] = []
    non_nfc: List[str] = []
    chars: Counter = Counter()
    apos: Counter = Counter()
    for d in docs:
        tag = _tag(ws, docs, d)
        if unicodedata.normalize('NFC', d.body) != d.body:
            non_nfc.append(ws.doc_label(d.id, quote=True))
        for c in d.body:
            if c in APOSTROPHES:
                apos[c] += 1
            cat = unicodedata.category(c)
            if c.isspace():
                continue
            if cat[0] in ('M', 'S', 'C') or (cat[0] == 'P' and c not in '.,;:!?-'):
                chars[c] += 1
        for s in d.sentences:
            if not s.words:
                empty.append(f'{tag}s{s.index}')
            dups[s.text.strip().casefold()].append(f'{tag}s{s.index}')
            for w in s.words:
                if any(m.form == '' for m in w.morphemes):
                    formless_n += 1
                    if len(formless) < 15:
                        formless.append(f'{tag}{word_ref(s, w)} {w.surface}')
                    continue
                if len(w.morphemes) > 1 or (w.morphemes and w.morphemes[0].form != w.surface):
                    joined = ''.join(m.form for m in w.morphemes)
                    if joined.replace('-', '').replace('=', '').casefold() != w.surface.replace('-', '').replace('=', '').casefold():
                        mismatch_n += 1
                        if len(mismatch) < 25:
                            mismatch.append(f'{tag}{word_ref(s, w)} {w.surface} ≠ {segmentation(w)}')
    lines = [f'Integrity check over {len(docs)} document{"s" if len(docs) != 1 else ""}.']
    lines.append(f'{formless_n} words with a morpheme that has no form (shown as ?)' + (': ' + '; '.join(formless) + (' …' if formless_n > len(formless) else '') if formless else '.'))
    lines.append(f'{mismatch_n} words whose morpheme forms do not add up to the surface (allomorphy or a slip)'
                 + (': ' + '; '.join(mismatch) + (' …' if mismatch_n > len(mismatch) else '') if mismatch else '.'))
    dd = {k: v for k, v in dups.items() if len(v) > 1 and k}
    lines.append(f'{len(dd)} sentences occurring more than once' + (': ' + '; '.join(f'{k[:40]} ({", ".join(v[:4])})' for k, v in list(dd.items())[:15]) if dd else '.'))
    lines.append(f'{len(empty)} sentences with no words' + (': ' + ', '.join(empty[:20]) if empty else '.'))
    lines.append(('Text not in NFC (combining marks where precomposed characters exist): ' + ', '.join(non_nfc)) if non_nfc else 'All text is NFC-normalized.')
    if len(apos) > 1:
        lines.append('Mixed apostrophe-like characters: ' + ', '.join(f'{c} U+{ord(c):04X} ({n})' for c, n in apos.most_common()))
    if chars:
        lines.append('Unusual characters in the baseline (symbols, marks, controls, rare punctuation): '
                     + ', '.join(f'{c!r} U+{ord(c):04X} {unicodedata.name(c, "?")} ({n})' for c, n in chars.most_common(25)))
    return truncate('\n'.join(lines))


# --- sequence_search ----------------------------------------------------------------

def t_sequence_search(ws: Workspace, sequence: list, adjacent: bool = True, document: Optional[str] = None,
                      regex: bool = False, limit: int = 40) -> str:
    """Sentences containing a sequence of words, each described by conditions
    on its form, morphemes, or field values (e.g. [{"POS": "v"}, {"POS": "n"}]).
    Conditions match whole values (case-insensitive) unless regex=true.
    adjacent=false allows other words in between, in order. One match per
    sentence is reported, so the count is sentences, not occurrences."""
    if not isinstance(sequence, list) or not sequence or not all(isinstance(c, dict) and c for c in sequence):
        raise ToolError('sequence must be a non-empty list of condition objects, e.g. [{"POS":"v"},{"Gloss":"PL"}]')
    limit = clamp_limit(limit, 40, 200)
    out: List[str] = []

    def show(tag, s, matches):
        idx = set(matches)
        shown = ' '.join(f'[{w.surface}]' if w.index in idx else w.surface for w in s.words)
        out.append(f'{tag}s{s.index} {shown}' + ''.join(
            f'\n    w{i} ' + render_word(s.words[i - 1], ws.project)[len(s.words[i - 1].ref) + 1:] for i in matches))
    from .queries import q_sequence
    with ws.corpus.within(document):
        found, total, shared = q_sequence(ws, sequence, bool(adjacent), bool(regex), limit)
    clipped = ws.corpus.clipped_note('matches')
    clipped += ''.join(f'\n("{k}" names a word field and a morpheme field, so a word matched when either holds the '
                       f'value.)' for k in shared)
    for d, s, word_ids in found:
        show(ws.corpus.tag(d.id), s, [w.index for w in s.words if w.id in word_ids])
    ws.note_read(len(out), 'match', of=total)
    if not total:
        return 'No sentence matches that sequence.' + clipped
    return truncate('\n'.join([f'{total} sentence{"s" if total != 1 else ""} match'
                                + (f' (showing {limit})' if total > limit else '') + ':' + clipped] + out))


