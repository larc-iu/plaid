"""The corpus-wide reads: searching, counting, and the quality reports.

These go through the query engine (see :mod:`.corpus`) and load a document
only to print the hits it actually has.
"""

from collections import defaultdict
from typing import Dict, List

from .corpus import RENDER_DOC_BUDGET, Corpus, rx
from .project import Sentence, UdDoc, Word, kwic, word_ref
from ..core.corpus import spread
from ..core.tools import ToolError, truncate
from .tools import FIELDS, Workspace
from ..core.args import clamp_limit
from ..core.limits import READ_LIMITS

SEARCHABLE = FIELDS + ('form', 'deprel')
COUNTABLE = ('form', 'lemma', 'upos', 'xpos', 'features', 'feature-bundles', 'deprel')


def _value(w: Word, field: str) -> str:
    return w.form if field == 'form' else (w.deprel or '' if field == 'deprel' else w.value(field))


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
            sp = w.fields.get(field)
            if sp and sp.value and prov_state(sp.metadata) == state:
                out.append((s, w))
    return out


REGEX_NOTE = ('(note) The engine matched this pattern in {docs}, but nothing in them matched it '
              'here: the engine reads Java regular expressions and this reads Python\'s, and they '
              'differ in places. A simpler pattern, or a literal with regex off, is read the same '
              'way by both.')


def t_search(ws: Workspace, field: str = None, pattern: str = None, document: str = None,
             whole: bool = False, regex: bool = False, limit: int = None, case_sensitive: bool = False) -> str:
    """Words whose field matches, each in its context."""
    if field not in SEARCHABLE:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(SEARCHABLE))
    if not pattern:
        raise ToolError('Give a pattern to search for.')
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    import re as _re
    spec = rx(pattern, regex=regex, whole=whole, case_sensitive=bool(case_sensitive))
    try:
        rgx = _re.compile(spec['regex'], _re.I if spec.get('flags') == 'i' else 0)
    except _re.error as e:
        raise ToolError(f'That is not a valid regular expression: {e}')
    matches = lambda v: bool(v) and bool(rgx.search(v))  # noqa: E731

    if document:
        doc = ws.doc(document)
        hits = _hits_in(doc, field, matches)
        if not hits:
            return f'No {field} matches "{pattern}" in "{doc.name}".'
        out = [f'{len(hits)} match(es) for {field} "{pattern}" in "{doc.name}"'
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
            empty.append(f'"{doc.name}"')
            continue
        out.append(f'"{doc.name}" ({len(hits)})')
        for s, w in hits[:min(quota, limit - shown)]:
            out.append(_hit_line(doc, s, w, _value(w, field)))
            shown += 1
        if len(hits) > quota:
            out.append(f'  … {len(hits) - quota} more in this document (name it to see them all)')
    head = (f'{total} match(es) for {field} "{pattern}" in {len(docs)} document(s), showing '
            f'{shown} from {read - len(empty)}' + (' of them' if len(docs) > read else '') + ':')
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


def t_frequency_list(ws: Workspace, what: str = 'lemma', document: str = None,
                     limit: int = None) -> str:
    """The commonest values of one column."""
    if what not in COUNTABLE:
        raise ToolError(f'Unknown column "{what}". One of: ' + ', '.join(COUNTABLE))
    limit = clamp_limit(limit, *READ_LIMITS['frequency_list'])
    column = 'features' if what == 'feature-bundles' else what
    clipped = ''
    if document:
        doc = ws.doc(document)
        counts: Dict[str, int] = defaultdict(int)
        for s in doc.sentences:
            for w in s.words:
                v = _value(w, column)
                if v:
                    counts[v] += 1
        rows = sorted(counts.items(), key=lambda kv: -kv[1])
        where = f' in "{doc.name}"'
    else:
        c = ws.corpus
        if what == 'form':
            rows = [(r[0], r[-1]) for r in c.form_values()]
        elif what == 'deprel':
            rows = [(r[0], r[-1]) for r in c.group([c.dep('?r')], ['?r.value'])]
        else:
            rows = [(r[0], r[-1]) for r in c.group([c.field(column, '?s')], ['?s.value'])]
        rows = [(v, n) for v, n in rows if v]
        clipped = c.clipped_note(f'{what} values')
        where = ' across the project'
    if what == 'features':
        rows = _split_features(rows)
    if not rows:
        # With the note: a clipped read that came back empty is the most
        # misleading of all, and this one says the column is unused.
        return f'Nothing has a {column} yet{where}.' + clipped
    total = sum(n for _, n in rows)
    unit = 'feature(s)' if what == 'features' else 'in all'
    out = [f'{what} by frequency{where}: {len(rows)} distinct value(s), {total} {unit}.' + clipped]
    for v, n in rows[:limit]:
        out.append(f'  {n:>7}  {v}')
    if len(rows) > limit:
        out.append(f'  … and {len(rows) - limit} more')
    return truncate('\n'.join(out))


CONSISTENCY = ('lemma-upos', 'form-lemma', 'rare-pairs')


def t_check_consistency(ws: Workspace, kind: str = None, limit: int = 25) -> str:
    """Places where the corpus disagrees with itself. Every one of these is a
    question, not a verdict: a lemma really can take two parts of speech."""
    kinds = [kind] if kind else list(CONSISTENCY)
    for k in kinds:
        if k not in CONSISTENCY:
            raise ToolError(f'Unknown check "{k}". One of: ' + ', '.join(CONSISTENCY))
    limit = clamp_limit(limit, 25, 100)
    c = ws.corpus
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
            out.append(f'  {lemma!r}: ' + ', '.join(f'{u} x{n}' for u, n in vs))
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
        out.append('')
        out.append(f'Forms with more than one lemma: {len(multi)}.')
        for form, vs in multi[:limit]:
            out.append(f'  {form!r}: ' + ', '.join(f'{l} x{n}' for l, n in vs))
        if len(multi) > limit:
            out.append(f'  … and {len(multi) - limit} more')

    if 'rare-pairs' in kinds:
        pairs = _deprel_upos_pairs(c)
        rare = [(d, u, n) for (d, u), n in sorted(pairs.items(), key=lambda kv: kv[1]) if n <= 2]
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
    """What is unfinished, by document, so a session has somewhere to start."""
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
                    out.append(f'{f}: none missing in "{doc.name}".')
                    continue
                out.append(f'{f}: {len(hits)} word(s) with none in "{doc.name}"')
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
            for did, n in docs[:limit]:
                out.append(f'    {n:>6}  "{c.doc_name(did)}"')
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
            out.append(f'{f}: {len(hits)} {word} value(s) in "{doc.name}"')
            for sent, w in hits[:limit]:
                out.append(_hit_line(doc, sent, w, _value(w, f)))
            if len(hits) > limit:
                out.append(f'  … and {len(hits) - limit} more (raise limit)')
        if not out:
            return f'Nothing is waiting for review in "{doc.name}" ({kind}).'
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
        for did, n in docs[:limit]:
            out.append(f'    {n:>6}  "{c.doc_name(did)}"')
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
