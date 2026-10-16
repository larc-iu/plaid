"""The corpus-wide reads: searching, counting, and the quality reports.

These go through the query engine (see :mod:`.corpus`) and load a document
only to print the hits it actually has.
"""

import re
from collections import defaultdict
from typing import Dict, List, Optional

from .corpus import RENDER_DOC_BUDGET, Corpus, rx
from ..core.history import doc_label
from .grew_syntax import grew_string
from .project import FEATURES, Sentence, UdDoc, Word, feats_order, kwic, word_ref
from ..core.corpus import spread
from ..core.java_regex import matcher
from ..core.tools import ToolError, truncate
from .tools import FIELDS, Workspace
from ..core.args import clamp_limit, read_int
from ..core.limits import GROUP_LIMIT, NGRAM_MAX, READ_LIMITS

SEARCHABLE = FIELDS + ('form', 'deprel')
COUNTABLE = ('form', 'lemma', 'upos', 'xpos', 'features', 'feature-bundles', 'deprel')


def _value(w: Word, field: str) -> str:
    return w.form if field == 'form' else (w.deprel or '' if field == 'deprel' else w.value(field))


def _named(ws, doc_id: str) -> str:
    """A document as these answers name it: quoted, with its id beside a
    name another document shares (``"Viaje" (ud2)``), as the headings do."""
    return doc_label(ws, doc_id, lambda name: f'"{name}"')


def _hit_line(doc: UdDoc, s: Sentence, w: Word, value: str) -> str:
    return f'  {word_ref(s, w)}  {value}   {kwic(doc, s, w)}'


def _spread(docs: List[tuple], limit: int):
    """This app's render budget, applied to :func:`core.corpus.spread`."""
    return spread(docs, limit, RENDER_DOC_BUDGET)


def _hits_in(doc: UdDoc, field: str, matches) -> List[tuple]:
    """[(sentence, word)] in one document whose ``field`` matches."""
    out = []
    for s in doc.sentences:
        for w in s.words:
            if matches(_value(w, field)):
                out.append((s, w))
    return out


def _awaiting_in(doc: UdDoc, field: str, state: str) -> List[tuple]:
    """[(sentence, word)] in one document whose ``field`` is unconfirmed and
    in this provenance state. `prov_state` folds "confirmed" into 'verified',
    so asking for 'machine' or 'contributed' already excludes what is done."""
    from plaid_client.provenance import prov_state
    out = []
    for s in doc.sentences:
        for w in s.words:
            if field == 'deprel':
                if w.relation_id and prov_state(w.relation_metadata) == state:
                    out.append((s, w))
                continue
            if any(prov_state(sp.metadata) == state for sp in w.spans(field)):
                out.append((s, w))
    return out


REGEX_NOTE = ('(note) The engine matched this pattern in {docs}, but nothing in them matched it '
              'here: those documents changed since, or hold characters newer than the engine\'s '
              'Unicode tables.')


def t_search(ws: Workspace, field: str = None, pattern: str = None, document: str = None,
             whole: bool = False, regex: bool = False, limit: int = None, case_sensitive: bool = False) -> str:
    """Words whose field matches, each in its context."""
    if field not in SEARCHABLE:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(SEARCHABLE))
    if not pattern:
        raise ToolError('Give a pattern to search for.')
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    spec = rx(pattern, regex=regex, whole=whole, case_sensitive=bool(case_sensitive))
    # The server's reading of the pattern (rx already refused one it cannot use).
    found = matcher(pattern, literal=not regex, case_insensitive=not case_sensitive, whole=whole)
    matches = lambda v: bool(v) and found(v)  # noqa: E731

    if document:
        doc = ws.doc(document)
        hits = _hits_in(doc, field, matches)
        ws.note_read(min(len(hits), limit), 'match', of=len(hits))
        if not hits:
            return f'No {field} matches "{pattern}" in {_named(ws, doc.id)}.'
        out = [f'{len(hits)} match(es) for {field} "{pattern}" in {_named(ws, doc.id)}'
               + (f', showing {limit}' if len(hits) > limit else '') + ':']
        out += [_hit_line(doc, s, w, _value(w, field)) for s, w in hits[:limit]]
        return truncate('\n'.join(out))

    c = ws.corpus
    if field == 'form':
        docs = c.form_documents(spec)
    elif field == 'deprel':
        docs = c.documents_with([c.dep('?r', value=spec)], '?r')
    else:
        docs = c.documents_with([c.field(field, '?s', value=spec)], '?s')
    if not docs:
        ws.note_read(0, 'match')
        return f'No {field} matches "{pattern}".'
    total = sum(int(n or 0) for _, n in docs)
    out: List[str] = []
    shown = 0
    read = 0
    empty: List[str] = []
    for did, quota in _spread(docs, limit):
        if shown >= limit:
            break
        doc = ws.doc(did)
        read += 1
        hits = _hits_in(doc, field, matches)
        if not hits:
            empty.append(doc_label(ws, did, grew_string))
            continue
        out.append(f'{doc_label(ws, did, grew_string)} ({len(hits)})')
        for s, w in hits[:min(quota, limit - shown)]:
            out.append(_hit_line(doc, s, w, _value(w, field)))
            shown += 1
        if len(hits) > quota:
            out.append(f'  … {len(hits) - quota} more in this document (name it to see them all)')
    head = (f'{total} match(es) for {field} "{pattern}" in {len(docs)} document(s), showing '
            f'{shown} from {read - len(empty)}' + (' of them' if len(docs) > read else '') + ':')
    ws.note_read(shown, 'match', of=total)
    if not shown:
        return f'No {field} matches "{pattern}".\n' + REGEX_NOTE.format(docs=', '.join(empty))
    if empty:
        out.append(REGEX_NOTE.format(docs=', '.join(empty)))
    return truncate(head + '\n' + '\n'.join(out) + c.clipped_note('documents'))


def _split_features(rows: List[tuple]) -> List[tuple]:
    """Feature=Value pairs from bundle counts: a bundle "Case=Nom|Number=Sing"
    seen 40 times is Case=Nom 40 and Number=Sing 40."""
    counts: Dict[str, int] = defaultdict(int)
    for bundle, n in rows:
        for pair in (bundle or '').split('|'):
            if pair:
                counts[pair] += n
    return sorted(counts.items(), key=lambda kv: -kv[1])


def _doc_batches(per_doc: List[list]) -> List[List[str]]:
    """Documents, from ``[document id, rows]``, in batches whose rows stay
    under the group limit (one document a batch when it alone is over)."""
    out: List[List[str]] = []
    held, size = [], 0
    for doc, n in sorted(((r[0], r[-1]) for r in per_doc if r[0]), key=lambda r: -r[1]):
        if held and size + n > GROUP_LIMIT:
            out.append(held)
            held, size = [], 0
        held.append(doc)
        size += n
    if held:
        out.append(held)
    return out


def _bundles(c: Corpus, cond: List[list] = ()) -> List[tuple]:
    """Whole FEATS strings over the corpus, by how many words carry each. A
    feature is a span of its own, so a word's bundle is the join of its spans,
    sorted as the export sorts them."""
    where = [c.word('?t'), c.field('features', '?s'), c.on('?s'), *cond]
    clipped = c.clipped
    rows = c.group(where, ['?t', '?s.value'])
    if c.truncated:
        # Cut at the group limit, the rows end inside some word's features,
        # which would count a bundle that word does not have (REV-AGENT F6).
        # Read again a few documents at a time, each read under the limit,
        # and only a document over it alone is clipped.
        c._clipped = clipped
        rows = []
        for docs in _doc_batches(c.group(where, ['?t.doc'])):
            rows += c.group(where + [['in', '?t.doc', docs]], ['?t', '?s.value'])
    by_word: Dict[str, List[str]] = defaultdict(list)
    for word, value, _n in rows:
        if value:
            by_word[word].append(value)
    counts: Dict[str, int] = defaultdict(int)
    for values in by_word.values():
        counts['|'.join(sorted(values, key=feats_order))] += 1
    return sorted(counts.items(), key=lambda kv: -kv[1])


#: The columns a ``where`` condition names by name. Any other key is a
#: feature (Number, Case), matched as its Feature=Value span.
WHERE_COLUMNS = ('form', 'lemma', 'upos', 'xpos', 'deprel')
NGRAM_COLUMNS = ('form', 'lemma', 'upos', 'xpos', 'deprel')


def where_clauses(c: Corpus, where, word: str = '?t') -> tuple:
    """``(clauses, words)`` for one word's conditions, ``{column or feature:
    value}``, each a whole value: the query clauses on ``word``, and the
    conditions as a reply says them. ``({}, '')`` for none."""
    if where is None or where == {}:
        return [], ''
    if not isinstance(where, dict) or not all(isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip()
                                              for k, v in where.items()):
        raise ToolError('where is one word\'s conditions, column or feature to a whole value, e.g. '
                        '{"upos": "NOUN", "Number": "Plur"}. Columns: ' + ', '.join(WHERE_COLUMNS)
                        + '; any other key is a feature.')
    out: List[list] = []
    said: List[str] = []
    for i, (key, value) in enumerate(where.items()):
        key, value = key.strip(), value.strip()
        col = key.lower()
        v = f'?w{i}'
        if col == 'form':
            out.append(['or', [c.field('form', v, value=value), c.on(v, word)],
                        [['token', word, {'value': value}], ['not', c.field('form', v + 'x'), c.on(v + 'x', word)]]])
        elif col in ('lemma', 'upos', 'xpos'):
            out += [c.field(col, v, value=value), c.on(v, word)]
        elif col == 'deprel':
            out += [c.field('lemma', v), c.on(v, word), c.dep(v + 'r', target=v, value=value)]
        else:
            if not re.match(r'^[A-Za-z][A-Za-z0-9\[\]:_]*$', key) or '=' in value or '|' in value:
                raise ToolError(f'"{key}" is not a column or a feature. Columns: ' + ', '.join(WHERE_COLUMNS)
                                + '; a feature is written {"Number": "Plur"}.')
            out += [c.field(FEATURES, v, value=f'{key}={value}'), c.on(v, word)]
            col = key
        said.append(f'{col}={value}')
    return out, ', '.join(said)


def _column_rows(c: Corpus, column: str, cond: List[list]) -> List[tuple]:
    """[(value, count)] of one column over the words ``cond`` holds (all
    when it is empty), from grouped reads."""
    if column == 'form':
        if not cond:
            return [(r[0], r[-1]) for r in c.form_values()]
        surface = c.group([c.word('?t'), c.no_form_span('?t'), *cond], ['?t.value'])
        spans = c.group([c.word('?t'), c.field('form', '?f'), c.on('?f'), *cond], ['?f.value'])
        return [(r[0], r[-1]) for r in c._merged_groups(surface, spans)]
    if column == 'deprel':
        if not cond:
            return [(r[0], r[-1]) for r in c.group([c.dep('?r')], ['?r.value'])]
        return [(r[0], r[-1]) for r in c.group([c.word('?t'), c.field('lemma', '?l'), c.on('?l'),
                                                c.dep('?r', target='?l'), *cond], ['?r.value'])]
    if column == 'feature-bundles':
        return _bundles(c, cond)
    col = 'features' if column == 'features' else column
    if not cond:
        return [(r[0], r[-1]) for r in c.group([c.field(col, '?s')], ['?s.value'])]
    return [(r[0], r[-1]) for r in c.group([c.word('?t'), c.field(col, '?s'), c.on('?s'), *cond], ['?s.value'])]


def _ngram_rows(c: Corpus, column: str, n: int) -> List[tuple]:
    """[(values joined by spaces, count)] for every run of ``n`` adjacent words
    inside one sentence: their forms (case folded), or their values of
    ``column``. A form is a Form span or the word's text, so every mix of the
    two is its own grouped read, summed."""
    import itertools
    gv = [f'?g{i}' for i in range(n)]
    base: List[list] = [['seq', {'layer': c.p.word_layer_id}, *[['token', {}, 'as', v] for v in gv]],
                        ['token', '?gs', {'layer': c.p.sentence_layer_id}]]
    base += [['within', v, '?gs'] for v in gv]
    reads: List[tuple] = []
    if column == 'form':
        for spans in itertools.product((False, True), repeat=n):
            where, keys = list(base), []
            for i, (v, span) in enumerate(zip(gv, spans)):
                if span:
                    where += [c.field('form', f'?gf{i}'), c.on(f'?gf{i}', v)]
                    keys.append(f'?gf{i}.value')
                else:
                    where.append(c.no_form_span(v))
                    keys.append(f'{v}.value')
            reads.append((where, keys))
    else:
        where, keys = list(base), []
        for i, v in enumerate(gv):
            if column == 'deprel':
                where += [c.field('lemma', f'?gl{i}'), c.on(f'?gl{i}', v), c.dep(f'?gv{i}', target=f'?gl{i}')]
            else:
                where += [c.field(column, f'?gv{i}'), c.on(f'?gv{i}', v)]
            keys.append(f'?gv{i}.value')
        reads.append((where, keys))
    counts: Dict[str, int] = defaultdict(int)
    for where, keys in reads:
        for row in c.group(where, keys):
            values = row[:n]
            if any(x in (None, '') for x in values):
                continue
            if column == 'form':
                values = [x.casefold() for x in values]
            counts[' '.join(values)] += int(row[-1] or 0)
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def t_frequency_list(ws: Workspace, what: str = 'lemma', document: str = None,
                     limit: int = None, where: dict = None, ngram: int = None) -> str:
    """The commonest values of one column, of the words meeting ``where``, or
    of runs of ``ngram`` adjacent words (survey item 8: word-order questions).
    Grouped reads, held to the document or documents named."""
    if what not in COUNTABLE:
        raise ToolError(f'Unknown column "{what}". One of: ' + ', '.join(COUNTABLE))
    limit = clamp_limit(limit, *READ_LIMITS['frequency_list'])
    n = read_int(ngram, 'ngram', 1, minimum=1) if ngram is not None else 1
    if n > NGRAM_MAX:
        raise ToolError(f'ngram is at most {NGRAM_MAX}. For longer patterns use grew_search.')
    if n > 1 and what not in NGRAM_COLUMNS:
        raise ToolError('ngram counts runs of words by one column: what is one of ' + ', '.join(NGRAM_COLUMNS) + '.')
    if n > 1 and where:
        raise ToolError('where and ngram do not combine. For runs of words with conditions use grew_search '
                        '(X < Y is the next word).')
    column = 'features' if what == 'feature-bundles' else what
    c = ws.corpus
    cond, said = where_clauses(c, where)
    noun = f'{what} {"bigrams" if n == 2 else f"{n}-grams"}' if n > 1 else f'{what} values'
    if document and n == 1 and not cond:
        # One document's plain count, off the parsed document: the same
        # values the grouped reads give (a Form span, else the word's text).
        doc = ws.doc(document)
        counts: Dict[str, int] = defaultdict(int)
        for s in doc.sentences:
            for w in s.words:
                v = _value(w, column)
                if v:
                    counts[v] += 1
        rows = sorted(counts.items(), key=lambda kv: -kv[1])
        clipped, place = '', f' in {_named(ws, doc.id)}'
    else:
        with c.within(document) as held:
            c.forget_clipping()
            rows = _ngram_rows(c, what, n) if n > 1 else _column_rows(c, what, cond)
            rows = [(v, k) for v, k in rows if v]
            clipped = c.clipped_note(noun)
            place = (f' in {_named(ws, held)}' if held
                     else '' if c.held_documents() else ' across the project')
    of = f' of the words with {said}' if said else ''
    if what == 'features':
        rows = _split_features(rows)
    ws.note_read(min(len(rows), limit), 'row', of=len(rows))
    if not rows:
        # With the note: a clipped read that came back empty is the most
        # misleading of all, and this one says the column is unused.
        if said:
            return f'No word with {said} has a {column}{place}.' + clipped
        return f'Nothing has a {column} yet{place}.' + clipped
    total = sum(k for _, k in rows)
    unit = 'feature(s)' if what == 'features' else 'in all'
    # A form is counted as written, a run of forms case folded ("de la" counts
    # "De la"), and the header says which, so two counts are never compared
    # as if they were one kind.
    if what == 'form':
        head = (f'{noun}, case folded, by frequency{place}' if n > 1
                else f'{what}, case sensitive, by frequency{of}{place}')
    else:
        head = (f'{noun} by frequency{place}' if n > 1 else f'{what} by frequency{of}{place}')
    out = [f'{head}: {len(rows)} distinct value(s), {total} {unit}.' + clipped]
    for v, k in rows[:limit]:
        out.append(f'  {k:>7}  {v}')
    if len(rows) > limit:
        out.append(f'  … and {len(rows) - limit} more')
    return truncate('\n'.join(out))


CONSISTENCY = ('lemma-upos', 'form-lemma', 'form-upos', 'rare-pairs')


def t_check_consistency(ws: Workspace, kind: str = None, limit: int = 25, document: str = None) -> str:
    """Places where the corpus disagrees with itself. Every one of these is a
    question, not a verdict: a lemma really can take two parts of speech.
    Over the project, or held to a document (or several, scope.py)."""
    kinds = [kind] if kind else list(CONSISTENCY)
    for k in kinds:
        if k not in CONSISTENCY:
            raise ToolError(f'Unknown check "{k}". One of: ' + ', '.join(CONSISTENCY))
    limit = clamp_limit(limit, 25, 100)
    c = ws.corpus
    with c.within(document) as held:
        ws.note_read(len(c.held_documents() or ws.documents()), 'document')
        out = _consistency(c, kinds, limit)
    return (f'In {doc_label(ws, held, grew_string)}:\n' if held else '') + out


def _consistency(c: Corpus, kinds: List[str], limit: int) -> str:
    out: List[str] = []
    # Every check here states a count as a fact, so a clipped read has to be
    # said out loud: the engine's row limit makes "the commonest" the top of an
    # arbitrary prefix. Asked once at the end, of every read the tool made.

    if 'lemma-upos' in kinds:
        rows = c.group([c.word('?t'), c.field('lemma', '?l'), c.on('?l'),
                        c.field('upos', '?u'), c.on('?u')], ['?l.value', '?u.value'])
        by = defaultdict(list)
        for lemma, upos, n in rows:
            if lemma and upos:
                by[lemma].append((upos, n))
        multi = [(k, sorted(v, key=lambda x: -x[1])) for k, v in by.items() if len(v) > 1]
        multi.sort(key=lambda kv: -sum(n for _, n in kv[1]))
        out.append(f'Lemmas with more than one UPOS: {len(multi)}.')
        out.append('  A rare tag beside a common one is usually the error.')
        for lemma, vs in multi[:limit]:
            out.append(f'  {grew_string(lemma)}: ' + ', '.join(f'{u} x{n}' for u, n in vs))
        if len(multi) > limit:
            out.append(f'  … and {len(multi) - limit} more')

    if 'form-lemma' in kinds:
        rows = c.form_lemma_pairs()
        by = defaultdict(list)
        for form, lemma, n in rows:
            if form and lemma:
                by[form].append((lemma, n))
        multi = [(k, sorted(v, key=lambda x: -x[1])) for k, v in by.items() if len(v) > 1]
        multi.sort(key=lambda kv: -sum(n for _, n in kv[1]))
        if out:
            out.append('')
        out.append(f'Forms with more than one lemma: {len(multi)}.')
        for form, vs in multi[:limit]:
            out.append(f'  {grew_string(form)}: ' + ', '.join(f'{l} x{n}' for l, n in vs))
        if len(multi) > limit:
            out.append(f'  … and {len(multi) - limit} more')

    if 'form-upos' in kinds:
        by = defaultdict(list)
        for form, upos, n in c.form_pairs('upos'):
            if form and upos:
                by[form].append((upos, n))
        multi = [(k, sorted(v, key=lambda x: (-x[1], x[0]))) for k, v in by.items() if len(v) > 1]
        # The most one-sided first: a form tagged one way 735 times and
        # another way 9 times is where a slip hides.
        multi.sort(key=lambda kv: (-kv[1][0][1] / sum(n for _, n in kv[1]), -sum(n for _, n in kv[1]), kv[0]))
        if out:
            out.append('')
        if not multi:
            out.append('No form has more than one UPOS.')
        else:
            out.append(f'Forms with more than one UPOS: {len(multi)}, the most one-sided first.')
            out.append('  The rarer tags of a one-sided form are where to look: grew_search with '
                       '[form="...", upos=...] lists those words.')
        for form, vs in multi[:limit]:
            total = sum(n for _, n in vs)
            out.append(f'  {grew_string(form)}: {vs[0][0]} x{vs[0][1]} ({round(100 * vs[0][1] / total)}%), '
                       + ', '.join(f'{u} x{n}' for u, n in vs[1:]))
        if len(multi) > limit:
            out.append(f'  … and {len(multi) - limit} more')

    if 'rare-pairs' in kinds:
        pairs = _deprel_upos_pairs(c)
        rare = [(d, u, n) for (d, u), n in sorted(pairs.items(), key=lambda kv: kv[1]) if n <= 2]
        if out:
            out.append('')
        out.append(f'deprel and UPOS pairs seen once or twice: {len(rare)}.')
        out.append('  Each is either a genuine rarity or a slip.')
        for d, u, n in rare[:limit]:
            out.append(f'  {d} on {u}: {n}')
        if len(rare) > limit:
            out.append(f'  … and {len(rare) - limit} more')
    return truncate('\n'.join(out) + c.clipped_note('counts'))


def _deprel_upos_pairs(c: Corpus) -> Dict[tuple, int]:
    """(deprel, UPOS) counts, by reading both off the same word: the deprel
    from the relation that lands on its lemma span, the UPOS from its own."""
    rows = c.group([c.word('?t'),
                    c.field('lemma', '?l'), c.on('?l'),
                    c.dep('?r', target='?l'),
                    c.field('upos', '?u'), c.on('?u')],
                   ['?r.value', '?u.value'])
    out: Dict[tuple, int] = {}
    for deprel, upos, n in rows:
        if deprel and upos:
            out[(deprel, upos)] = out.get((deprel, upos), 0) + n
    return out


WORKLIST_KINDS = ('unverified', 'contributed', 'missing')


def t_worklist(ws: Workspace, kind: str = 'unverified', field: str = None,
               document: str = None, limit: int = None) -> str:
    """What is unfinished, by document, so a session has somewhere to start.
    The words it lists (in one document) or the rows (one per document and
    column, project-wide) are noted, of all there were."""
    listed = [0, 0]
    out = _worklist(ws, kind, field, document, limit, listed)
    ws.note_read(listed[0], 'word' if document else 'row', of=listed[1])
    return out


def _worklist(ws: Workspace, kind: str, field: Optional[str], document: Optional[str],
              limit: Optional[int], listed: List[int]) -> str:
    """:func:`t_worklist`, adding what it shows and what there was to ``listed``."""
    if kind not in WORKLIST_KINDS:
        raise ToolError(f'Unknown kind "{kind}". One of: ' + ', '.join(WORKLIST_KINDS))
    limit = clamp_limit(limit, *READ_LIMITS['worklist'])
    c = ws.corpus
    # A per-document count read from a clipped result is the top of a prefix,
    # and this is the tool a session starts from. Asked once per branch, of
    # every read that branch made.
    # deprel is the tree: the column the parser is least reliable on, and the
    # one this tool could not see until it was added here.
    fields = [field] if field else list(FIELDS) + ['deprel']
    for f in fields:
        if f not in FIELDS + ('deprel',):
            raise ToolError(f'Unknown field "{f}". One of: ' + ', '.join(FIELDS + ('deprel',)))
    out: List[str] = []

    if kind == 'missing':
        # Naming a document answers WHICH words, which is what planning needs.
        # Without it the answer is only how many and where, and a model that
        # then has to find them has nothing to go on: one paged a
        # 112-sentence document nine times, another ran nine blind searches,
        # and neither staged anything.
        if document:
            doc = ws.doc(document)
            for f in fields:
                hits = _hits_in(doc, f, lambda v: not v)
                if not hits:
                    out.append(f'{f}: none missing in {_named(ws, doc.id)}.')
                    continue
                out.append(f'{f}: {len(hits)} word(s) with none in {_named(ws, doc.id)}')
                listed[0] += min(len(hits), limit)
                listed[1] += len(hits)
                for sent, w in hits[:limit]:
                    out.append(_hit_line(doc, sent, w, w.form))
                if len(hits) > limit:
                    out.append(f'  … and {len(hits) - limit} more (raise limit)')
            return truncate('\n'.join(out))

        for f in fields:
            if f == 'deprel':
                # A word with no head: no relation lands on its lemma span (a
                # word with no lemma span has no head either).
                where = [c.word('?t'), ['not', c.field('lemma', '?l'), c.on('?l'), c.dep('?r', target='?l')]]
            else:
                where = [c.word('?t'),
                         ['not', ['span', '?s', {'layer': c.p.layer(f)}], c.on('?s')]]
            docs = c.documents_with(where, '?t')
            total = sum(n for _, n in docs)
            out.append(f'{f}: {total} word(s) with none, in {len(docs)} document(s)')
            listed[0] += min(len(docs), limit)
            listed[1] += len(docs)
            for did, n in docs[:limit]:
                out.append(f'    {n:>6}  {_named(ws, did)}')
            if len(docs) > limit:
                out.append(f'    … and {len(docs) - limit} more documents')
        return truncate(('\n'.join(out) + c.clipped_note('documents')) or 'Nothing is missing.')

    stamp = {'prov': 'contributed'} if kind == 'contributed' else {'prov': 'inferred'}
    word = 'a contributor\'s unreviewed' if kind == 'contributed' else 'unconfirmed machine'
    # Naming a document answers WHICH values, the same way `missing` does.
    # Counting a document the model already named leaves it nothing to act on.
    if document:
        doc = ws.doc(document)
        state = 'contributed' if kind == 'contributed' else 'machine'
        for f in fields:
            hits = _awaiting_in(doc, f, state)
            if not hits:
                # No line at all, so the "nothing is waiting" reply below is
                # reachable. Appending "none waiting" per field made it dead,
                # and a clean document was told to go and confirm things.
                continue
            out.append(f'{f}: {len(hits)} {word} value(s) in {_named(ws, doc.id)}')
            listed[0] += min(len(hits), limit)
            listed[1] += len(hits)
            for sent, w in hits[:limit]:
                out.append(_hit_line(doc, sent, w, _value(w, f)))
            if len(hits) > limit:
                out.append(f'  … and {len(hits) - limit} more (raise limit)')
        if not out:
            return f'Nothing is waiting for review in {_named(ws, doc.id)} ({kind}).'
        out.append('')
        out.append('confirm marks these as reviewed; discard_predictions throws the machine ones away. '
                   'Without refs, either covers the whole document as one planned change.')
        return truncate('\n'.join(out))

    for f in fields:
        if f == 'deprel':
            where = [c.dep('?r', metadata=stamp),
                     ['not', ['relation', '?r', {'metadata': {'provConfirmed': True}}]]]
            docs = c.documents_with(where, '?r')
        else:
            where = [c.field(f, '?s', metadata=stamp), c.unconfirmed('?s')]
            docs = c.documents_with(where, '?s')
        total = sum(n for _, n in docs)
        if not total:
            continue
        out.append(f'{f}: {total} {word} value(s), in {len(docs)} document(s)')
        listed[0] += min(len(docs), limit)
        listed[1] += len(docs)
        for did, n in docs[:limit]:
            out.append(f'    {n:>6}  {_named(ws, did)}')
        if len(docs) > limit:
            out.append(f'    … and {len(docs) - limit} more documents')
    clipped = c.clipped_note('documents')
    if not out:
        # A clipped read that found nothing is exactly the one that must say
        # so: "nothing is waiting" for a corpus that may be full of it.
        return f'Nothing is waiting for review ({kind}).' + clipped
    out.append('')
    out.append('confirm marks these as reviewed; discard_predictions throws the machine ones away.')
    return truncate('\n'.join(out) + clipped)


# --- history and comments --------------------------------------------------------
# `recent_changes` is `core.history`'s: nothing in reading the audit log is
# this app's, and it used to be written out here, in plaid-umr and in plaid-igt.
