"""Corpus-wide reads: numbers, worklists, lexicon and integrity reports, and
sequence search. All of these scan the loaded documents (cached per turn),
so a first call on a large project reads every document once."""

import difflib
import re
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

from plaid_client.provenance import prov_state, MACHINE, HUMAN, VERIFIED

from .project import IgtDoc, Sentence, Word, Morpheme, render_word, segmentation, word_ref
from .tools import Workspace, ToolError, _matcher, _truncate, entry_line


def _pct(n, d):
    return f'{(100.0 * n / d):.0f}%' if d else 'n/a'


def _docs(ws: Workspace, document: Optional[str]) -> List[IgtDoc]:
    return [ws.doc(document)] if document else ws.all_docs()


def _tag(docs, doc):
    return f'"{doc.name}" ' if len(docs) > 1 else ''


def _analyzed(w: Word) -> bool:
    """Has any analysis at all: a non-default segmentation, any field value,
    or any link."""
    if w.fields or w.link:
        return True
    if len(w.morphemes) > 1:
        return True
    for m in w.morphemes:
        if m.fields or m.link or m.morph_type or m.form != w.surface:
            return True
    return False


def _linked(w: Word) -> bool:
    return bool(w.link or any(m.link for m in w.morphemes))


# --- corpus_stats -----------------------------------------------------------------

def _doc_numbers(doc: IgtDoc, project) -> Dict[str, Any]:
    words = [w for s in doc.sentences for w in s.words]
    forms = Counter(w.surface.casefold() for w in words)
    morphs = [m for w in words for m in w.morphemes]
    mforms = Counter(m.form.casefold() for m in morphs)
    out: Dict[str, Any] = {
        'sentences': len(doc.sentences), 'words': len(words), 'forms': len(forms),
        'hapax': sum(1 for c in forms.values() if c == 1),
        'morphemes': len(morphs), 'morpheme_forms': len(mforms),
        'analyzed': sum(1 for w in words if _analyzed(w)),
        'linked': sum(1 for w in words if _linked(w)),
        'ttr': (len(forms) / len(words)) if words else 0.0,
        'longest': sorted(words, key=lambda w: -len(w.morphemes))[:3],
    }
    for f in project.fields.values():
        if f.scope == 'Sentence':
            out[f'field:{f.name}'] = (sum(1 for s in doc.sentences if s.fields.get(f.name) and s.fields[f.name].value != ''),
                                      len(doc.sentences))
        elif f.scope == 'Word':
            out[f'field:{f.name}'] = (sum(1 for w in words if w.fields.get(f.name) and w.fields[f.name].value != ''),
                                      len(words))
        else:
            out[f'field:{f.name}'] = (sum(1 for m in morphs if m.fields.get(f.name) and m.fields[f.name].value != ''),
                                      len(morphs))
    return out


def _sum_numbers(rows: List[Dict[str, Any]], project, docs: List[IgtDoc]) -> Dict[str, Any]:
    total: Dict[str, Any] = {}
    for k in ('sentences', 'words', 'morphemes', 'analyzed', 'linked'):
        total[k] = sum(r[k] for r in rows)
    words = [w for d in docs for s in d.sentences for w in s.words]
    forms = Counter(w.surface.casefold() for w in words)
    mforms = Counter(m.form.casefold() for w in words for m in w.morphemes)
    total['forms'] = len(forms)
    total['hapax'] = sum(1 for c in forms.values() if c == 1)
    total['morpheme_forms'] = len(mforms)
    total['morpheme_hapax'] = sum(1 for c in mforms.values() if c == 1)
    total['ttr'] = (len(forms) / len(words)) if words else 0.0
    total['longest'] = sorted(words, key=lambda w: -len(w.morphemes))[:5]
    for f in project.fields.values():
        k = f'field:{f.name}'
        total[k] = (sum(r[k][0] for r in rows), sum(r[k][1] for r in rows))
    return total


def t_corpus_stats(ws: Workspace, document: Optional[str] = None, by: Optional[str] = None) -> str:
    """Totals and coverage for the project or one document; with `by`, a
    per-document table (`by="document"`) or a breakdown by a document
    metadata field (`by="Genre"`)."""
    docs = _docs(ws, document)
    project = ws.project
    rows = {d.id: _doc_numbers(d, project) for d in docs}
    lines: List[str] = []

    def describe(n: Dict[str, Any], docs_n: int, head: str):
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
        if n['longest'] and n['longest'][0].morphemes and len(n['longest'][0].morphemes) > 1:
            lines.append('  Longest words: ' + ', '.join(f'{w.surface} ({len(w.morphemes)}: {segmentation(w)})'
                                                        for w in n['longest'] if len(w.morphemes) > 1))

    if by is None:
        describe(_sum_numbers(list(rows.values()), project, docs), len(docs),
                 f'Project "{project.name}"' if not document else f'Document "{docs[0].name}"')
        return _truncate('\n'.join(lines))

    if by.lower() == 'document':
        first_m = next((f.name for f in project.fields_by_scope('Morpheme')), None)
        first_s = next((f.name for f in project.fields_by_scope('Sentence')), None)
        head = ['document', 'sentences', 'words', 'analyzed', 'linked' if project.vocabs else None,
                f'{first_m}' if first_m else None, f'{first_s}' if first_s else None, 'hapax', 'TTR']
        head += project.document_metadata
        lines.append('\t'.join(h for h in head if h))
        for d in sorted(docs, key=lambda d: d.name.lower()):
            n = rows[d.id]
            cells = [d.name, str(n['sentences']), str(n['words']), _pct(n['analyzed'], n['words']),
                     _pct(n['linked'], n['words']) if project.vocabs else None,
                     _pct(*n[f'field:{first_m}']) if first_m else None,
                     _pct(*n[f'field:{first_s}']) if first_s else None,
                     _pct(n['hapax'], n['words']), f'{n["ttr"]:.2f}']
            cells += [str(d.metadata.get(k, '') or '') for k in project.document_metadata]
            lines.append('\t'.join(c for c in cells if c is not None))
        return _truncate('\n'.join(lines))

    key = next((k for k in project.document_metadata if k.lower() == by.lower()), None)
    if not key:
        raise ToolError(f'by must be "document" or a document metadata field: ' + ', '.join(project.document_metadata))
    groups: Dict[str, List[IgtDoc]] = defaultdict(list)
    for d in docs:
        groups[str(d.metadata.get(key, '') or '(none)')].append(d)
    for val, ds in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        describe(_sum_numbers([rows[d.id] for d in ds], project, ds), len(ds), f'{key} = {val}')
    return _truncate('\n'.join(lines))


# --- frequency_list -----------------------------------------------------------------

def t_frequency_list(ws: Workspace, what: str = 'wordform', document: Optional[str] = None,
                     limit: int = 100, min_count: int = 1) -> str:
    """Counts with document dispersion for wordforms, morpheme forms, or a
    field's values."""
    docs = _docs(ws, document)
    limit = max(1, min(int(limit or 100), 1000))
    what_l = (what or 'wordform').lower()
    counts: Counter = Counter()
    spread: Dict[str, set] = defaultdict(set)
    field = None
    if what_l not in ('wordform', 'word', 'morpheme'):
        field = ws.project.field(what)
    for d in docs:
        for s in d.sentences:
            if field and field.scope == 'Sentence':
                sp = s.fields.get(field.name)
                if sp and sp.value != '':
                    counts[sp.value] += 1
                    spread[sp.value].add(d.id)
                continue
            for w in s.words:
                if what_l in ('wordform', 'word'):
                    k = w.surface.casefold()
                    counts[k] += 1
                    spread[k].add(d.id)
                elif what_l == 'morpheme':
                    for m in w.morphemes:
                        k = m.form.casefold()
                        counts[k] += 1
                        spread[k].add(d.id)
                elif field.scope == 'Word':
                    sp = w.fields.get(field.name)
                    if sp and sp.value != '':
                        counts[sp.value] += 1
                        spread[sp.value].add(d.id)
                else:
                    for m in w.morphemes:
                        sp = m.fields.get(field.name)
                        if sp and sp.value != '':
                            counts[sp.value] += 1
                            spread[sp.value].add(d.id)
    items = [(k, n) for k, n in counts.most_common() if n >= max(1, int(min_count or 1))]
    noun = field.name + ' values' if field else ('wordforms' if what_l != 'morpheme' else 'morpheme forms')
    lines = [f'{len(items)} {noun}, {sum(n for _, n in items)} tokens' + (f' (showing {limit})' if len(items) > limit else '')
             + '. count\tdocuments\tform']
    for k, n in items[:limit]:
        lines.append(f'  {n}\t{len(spread[k])}\t{k}')
    return _truncate('\n'.join(lines))


# --- worklist ----------------------------------------------------------------------

KINDS = ('unlinked', 'unglossed', 'unanalyzed', 'unverified')


def _prov_votes(w: Word) -> List[str]:
    votes = []
    for sp in w.fields.values():
        votes.append(prov_state(sp.metadata))
    if w.link:
        votes.append(HUMAN)  # links carry prov in metadata we did not keep; treat as human
    for m in w.morphemes:
        if len(w.morphemes) > 1 or m.morph_type or m.form != w.surface:
            votes.append(prov_state(m.metadata))
        for sp in m.fields.values():
            votes.append(prov_state(sp.metadata))
    return votes


def t_worklist(ws: Workspace, kind: str = 'unglossed', field: Optional[str] = None, level: Optional[str] = None,
               document: Optional[str] = None, limit: int = 50) -> str:
    """The unfinished work grouped by form, most frequent first: forms that are
    unlinked, lack a field value, have no analysis at all, or carry
    machine-made annotations nobody has confirmed."""
    kind = (kind or 'unglossed').lower()
    if kind not in KINDS:
        raise ToolError('kind must be one of: ' + ', '.join(KINDS))
    project = ws.project
    limit = max(1, min(int(limit or 50), 500))
    docs = _docs(ws, document)
    f = None
    if kind == 'unglossed':
        if field:
            f = project.field(field)
        else:
            f = next(iter(project.fields_by_scope('Morpheme')), None) or next(iter(project.fields_by_scope('Word')), None)
            if not f:
                raise ToolError('No word or morpheme field to check; name one with field=')
    lvl = (level or '').lower() or ('morpheme' if (project.morpheme_layer_id and kind in ('unlinked', 'unglossed')
                                                 and (f is None or f.scope == 'Morpheme')) else 'word')
    if f and f.scope == 'Word':
        lvl = 'word'
    groups: Dict[str, List[str]] = defaultdict(list)
    for d in docs:
        tag = _tag(docs, d)
        for s in d.sentences:
            for w in s.words:
                ref = f'{tag}{word_ref(s, w)}'
                if kind == 'unanalyzed':
                    if not _analyzed(w):
                        groups[w.surface.casefold()].append(ref)
                elif kind == 'unverified':
                    votes = _prov_votes(w)
                    if votes and any(v == MACHINE for v in votes):
                        groups[w.surface.casefold()].append(ref)
                elif lvl == 'word':
                    if kind == 'unlinked' and not _linked(w):
                        groups[w.surface.casefold()].append(ref)
                    elif kind == 'unglossed' and f and not (w.fields.get(f.name) and w.fields[f.name].value != ''):
                        groups[w.surface.casefold()].append(ref)
                else:
                    for m in w.morphemes:
                        if kind == 'unlinked' and not m.link and not w.link:
                            groups[m.form.casefold()].append(f'{ref}.m{m.index}')
                        elif kind == 'unglossed' and f and not (m.fields.get(f.name) and m.fields[f.name].value != ''):
                            groups[m.form.casefold()].append(f'{ref}.m{m.index}')
    total = sum(len(v) for v in groups.values())
    what = {'unlinked': f'{lvl}s not linked to the lexicon',
            'unglossed': f'{lvl}s without a {f.name if f else ""} value',
            'unanalyzed': 'words with no analysis at all',
            'unverified': 'words with machine-made annotations not yet confirmed'}[kind]
    if not total:
        return f'Nothing to do: no {what}.'
    lines = [f'{total} {what} across {len(groups)} distinct forms' + (f' (showing {limit})' if len(groups) > limit else '')
             + '. count\tform\texamples']
    for form, refs in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:limit]:
        lines.append(f'  {len(refs)}\t{form}\t{", ".join(refs[:3])}')
    return _truncate('\n'.join(lines))


# --- check_lexicon -------------------------------------------------------------------

def _strip_affix(form: str) -> str:
    return (form or '').strip('-=~ ').casefold()


def t_check_lexicon(ws: Workspace, lexicon: Optional[str] = None) -> str:
    """Lexicon hygiene: entries never linked, entries missing gloss or POS,
    homographs, near-duplicate forms, entries whose lexicon gloss disagrees
    with the corpus, links whose form no longer matches the entry, one corpus
    gloss spread over several entries, entries attested in a single document."""
    project = ws.project
    vocabs = [project.vocab(lexicon)] if lexicon else project.vocabs
    if not vocabs:
        return 'This project has no lexicon.'
    items: Dict[str, dict] = {}
    for v in vocabs:
        for it in ws.lexicon(v):
            items[it['id']] = it
    docs = ws.all_docs()
    first_m = next((f.name for f in project.fields_by_scope('Morpheme')), None)
    first_w = next((f.name for f in project.fields_by_scope('Word')), None)
    uses: Dict[str, int] = Counter()
    use_docs: Dict[str, set] = defaultdict(set)
    corpus_gloss: Dict[str, Counter] = defaultdict(Counter)   # item -> corpus gloss values
    gloss_items: Dict[str, set] = defaultdict(set)            # corpus gloss -> items
    stale: List[str] = []
    for d in docs:
        tag = _tag(docs, d)
        for s in d.sentences:
            for w in s.words:
                units = [(w, w.surface, first_w, f'{tag}{word_ref(s, w)}')] + \
                    [(m, m.form, first_m, f'{tag}{word_ref(s, w)}.m{m.index}') for m in w.morphemes]
                for u, form, fname, ref in units:
                    if not u.link or u.link.item_id not in items:
                        continue
                    iid = u.link.item_id
                    uses[iid] += 1
                    use_docs[iid].add(d.id)
                    if fname:
                        sp = u.fields.get(fname)
                        if sp and sp.value != '':
                            corpus_gloss[iid][sp.value] += 1
                            gloss_items[sp.value].add(iid)
                    # A word may link to its stem's entry, so the entry form
                    # only has to be contained in the linked form.
                    if _strip_affix(items[iid].get('form')) not in _strip_affix(form):
                        if len(stale) < 15:
                            stale.append(f'{ref} {form} → "{items[iid].get("form")}"')
                        else:
                            stale.append('')
    lines = [f'Lexicon check: {len(items)} entries in {", ".join(v["name"] for v in vocabs)}, {sum(uses.values())} links.']

    unused = [it for it in items.values() if uses[it['id']] == 0]
    lines.append(f'{len(unused)} entries never linked from a text' + (': ' + ', '.join(it.get('form') or '' for it in unused[:40])
                                                                       + (' …' if len(unused) > 40 else '') if unused else '.'))
    no_gloss = [it for it in items.values() if not (it.get('metadata') or {}).get('gloss')]
    no_pos = [it for it in items.values() if not (it.get('metadata') or {}).get('pos')]
    lines.append(f'{len(no_gloss)} entries without a gloss' + (': ' + ', '.join(it.get('form') or '' for it in no_gloss[:30]) + (' …' if len(no_gloss) > 30 else '') if no_gloss else '.'))
    lines.append(f'{len(no_pos)} entries without a pos' + (': ' + ', '.join(it.get('form') or '' for it in no_pos[:30]) + (' …' if len(no_pos) > 30 else '') if no_pos else '.'))

    by_form: Dict[str, List[dict]] = defaultdict(list)
    for it in items.values():
        by_form[_strip_affix(it.get('form'))].append(it)
    homographs = {k: v for k, v in by_form.items() if len(v) > 1}
    if homographs:
        lines.append(f'{len(homographs)} homograph groups:')
        for k, its in sorted(homographs.items(), key=lambda kv: -len(kv[1]))[:30]:
            lines.append('  ' + ' | '.join(f'{entry_line(it)} ({uses[it["id"]]} links)' for it in its))
    else:
        lines.append('No homographs.')

    forms = sorted(by_form)
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
    if near:
        lines.append(f'{len(near)} pairs of forms one character apart (possible variants or duplicates): '
                     + ', '.join(near[:30]) + (' …' if len(near) > 30 else ''))

    disagree = []
    for iid, c in corpus_gloss.items():
        lex = ((items[iid].get('metadata') or {}).get('gloss') or '').strip()
        top, n = c.most_common(1)[0]
        if lex and top.casefold() != lex.casefold():
            disagree.append(f'{items[iid].get("form")}: lexicon "{lex}", corpus mostly "{top}" ({n}/{sum(c.values())})')
    lines.append(f'{len(disagree)} entries whose gloss disagrees with the corpus' + (':\n  ' + '\n  '.join(disagree[:30]) if disagree else '.'))

    spread = {g: ids for g, ids in gloss_items.items() if len(ids) > 1}
    if spread:
        lines.append(f'{len(spread)} corpus glosses linked to several entries: '
                     + '; '.join(f'{g} → {", ".join(items[i].get("form") or "" for i in ids)}' for g, ids in list(spread.items())[:20]))
    real_stale = [s for s in stale if s]
    lines.append(f'{len(real_stale) + (len(stale) - len(real_stale))} links whose form no longer matches the entry'
                 + (': ' + '; '.join(real_stale) + (' …' if len(stale) > len(real_stale) else '') if real_stale else '.'))
    single = [items[i].get('form') or '' for i, ds in use_docs.items() if len(ds) == 1 and len(docs) > 1]
    if len(docs) > 1:
        lines.append(f'{len(single)} entries attested in a single document' + (': ' + ', '.join(single[:40]) + (' …' if len(single) > 40 else '') if single else '.'))
    return _truncate('\n'.join(lines))


# --- check_integrity ----------------------------------------------------------------

APOSTROPHES = "'’ʼ‘`´ʻ"


def t_check_integrity(ws: Workspace, document: Optional[str] = None) -> str:
    """Data-shape problems: segmentations that do not add up to the word,
    duplicate sentences, empty sentences, non-NFC text, mixed apostrophe
    characters, and the inventory of unusual characters in the baseline."""
    docs = _docs(ws, document)
    mismatch: List[str] = []
    mismatch_n = 0
    dups: Dict[str, List[str]] = defaultdict(list)
    empty: List[str] = []
    non_nfc: List[str] = []
    chars: Counter = Counter()
    apos: Counter = Counter()
    for d in docs:
        tag = _tag(docs, d)
        if unicodedata.normalize('NFC', d.body) != d.body:
            non_nfc.append(d.name)
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
                if len(w.morphemes) > 1 or (w.morphemes and w.morphemes[0].form != w.surface):
                    joined = ''.join(m.form for m in w.morphemes)
                    if joined.replace('-', '').replace('=', '').casefold() != w.surface.replace('-', '').replace('=', '').casefold():
                        mismatch_n += 1
                        if len(mismatch) < 25:
                            mismatch.append(f'{tag}{word_ref(s, w)} {w.surface} ≠ {segmentation(w)}')
    lines = [f'Integrity check over {len(docs)} document{"s" if len(docs) != 1 else ""}.']
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
    return _truncate('\n'.join(lines))


# --- sequence_search ----------------------------------------------------------------

def _word_matches(w: Word, cond: Dict[str, Any], project, regex: bool) -> bool:
    for key, pat in cond.items():
        m = _matcher(str(pat), regex)
        k = (key or '').lower()
        if k in ('form', 'word', 'baseline'):
            if not m(w.surface):
                return False
        elif k == 'morpheme':
            if not any(m(x.form) for x in w.morphemes):
                return False
        elif k == 'type':
            if not any(m(x.morph_type or '') for x in w.morphemes):
                return False
        else:
            f = project.field(key)
            if f.scope == 'Word':
                sp = w.fields.get(f.name)
                if not (sp and m(sp.value)):
                    return False
            elif f.scope == 'Morpheme':
                if not any(m(x.fields[f.name].value) for x in w.morphemes if f.name in x.fields):
                    return False
            else:
                raise ToolError(f'"{f.name}" is a sentence field; sequence conditions are per word')
    return True


def t_sequence_search(ws: Workspace, sequence: list, adjacent: bool = True, document: Optional[str] = None,
                      regex: bool = False, limit: int = 40) -> str:
    """Sentences containing a sequence of words, each described by conditions
    on its form, morphemes, or field values (e.g. [{"POS": "v"}, {"POS": "n"}]).
    adjacent=false allows other words in between, in order."""
    if not isinstance(sequence, list) or not sequence or not all(isinstance(c, dict) and c for c in sequence):
        raise ToolError('sequence must be a non-empty list of condition objects, e.g. [{"POS":"v"},{"Gloss":"PL"}]')
    limit = max(1, min(int(limit or 40), 200))
    docs = _docs(ws, document)
    out: List[str] = []
    total = 0
    for d in docs:
        tag = _tag(docs, d)
        for s in d.sentences:
            matches = _find_sequence(s, sequence, adjacent, ws.project, regex)
            if not matches:
                continue
            total += 1
            if len(out) < limit:
                idx = set(matches)
                shown = ' '.join(f'[{w.surface}]' if w.index in idx else w.surface for w in s.words)
                out.append(f'{tag}s{s.index} {shown}' + ''.join(
                    f'\n    w{i} ' + render_word(s.words[i - 1], ws.project)[len(s.words[i - 1].ref) + 1:] for i in matches))
    if not total:
        return 'No sentence matches that sequence.'
    return _truncate('\n'.join([f'{total} sentence{"s" if total != 1 else ""} match' + (f' (showing {limit})' if total > limit else '') + ':'] + out))


def _find_sequence(s: Sentence, seq: List[Dict[str, Any]], adjacent: bool, project, regex: bool) -> List[int]:
    """Word indexes (1-based) of the first match, or []."""
    n = len(s.words)
    for start in range(n):
        if not _word_matches(s.words[start], seq[0], project, regex):
            continue
        picked = [start]
        pos = start + 1
        ok = True
        for cond in seq[1:]:
            if adjacent:
                if pos < n and _word_matches(s.words[pos], cond, project, regex):
                    picked.append(pos)
                    pos += 1
                else:
                    ok = False
                    break
            else:
                while pos < n and not _word_matches(s.words[pos], cond, project, regex):
                    pos += 1
                if pos >= n:
                    ok = False
                    break
                picked.append(pos)
                pos += 1
        if ok:
            return [i + 1 for i in picked]
    return []
