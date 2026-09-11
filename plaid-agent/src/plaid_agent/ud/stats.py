"""The corpus-wide reads: searching, counting, and the quality reports.

These go through the query engine (see :mod:`.corpus`) and load a document
only to print the hits it actually has.
"""

from collections import defaultdict
from typing import Any, Dict, List, Optional

from .corpus import DOCS_PER_SEARCH, Corpus, rx
from .project import Sentence, UdDoc, Word, word_ref
from .tools import FIELDS, ToolError, Workspace, _truncate

SEARCHABLE = FIELDS + ('form', 'deprel')
COUNTABLE = ('form', 'lemma', 'upos', 'xpos', 'features', 'deprel')


def _corpus(ws: Workspace) -> Corpus:
    if getattr(ws, '_corpus', None) is None:
        ws._corpus = Corpus(ws)
    return ws._corpus


def _value(w: Word, field: str) -> str:
    return w.form if field == 'form' else (w.deprel or '' if field == 'deprel' else w.value(field))


def _enough_for(docs: List[tuple], limit: int) -> List[tuple]:
    """Only as many documents as the hit limit can possibly need.

    The engine already said how many hits each document has, and loading one
    is a round trip over a whole document's tokens, spans and relations.
    Taking twelve of them to print thirty hits is what made a corpus-wide
    question take minutes against EWT.
    """
    out, got = [], 0
    for entry in docs:
        if got >= limit or len(out) >= DOCS_PER_SEARCH:
            break
        out.append(entry)
        got += entry[1] or 1
    return out


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
            sp = w.fields.get(field)
            if sp and sp.value and prov_state(sp.metadata) == state:
                out.append((s, w))
    return out


def t_search(ws: Workspace, field: str = None, pattern: str = None, document: str = None,
             whole: bool = False, regex: bool = False, limit: int = 30) -> str:
    """Words whose field matches, with the sentence each sits in."""
    if field not in SEARCHABLE:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(SEARCHABLE))
    if not pattern:
        raise ToolError('Give a pattern to search for.')
    limit = max(1, min(int(limit or 30), 200))
    import re as _re
    spec = rx(pattern, regex=regex, whole=whole)
    try:
        rgx = _re.compile(spec['regex'], _re.I if spec.get('flags') == 'i' else 0)
    except _re.error as e:
        raise ToolError(f'That is not a valid regular expression: {e}')
    matches = lambda v: bool(v) and bool(rgx.search(v))  # noqa: E731

    total_docs = None
    if document:
        docs = [(ws.resolve_document_id(document), None)]
    else:
        c = _corpus(ws)
        if field == 'form':
            # A form is the token's own text unless a Form span overrides it,
            # so the engine cannot answer this one: fall back to the documents
            # the project has, newest first, and say what was covered.
            docs = [(d['id'], None) for d in ws.documents()[:DOCS_PER_SEARCH]]
        elif field == 'deprel':
            docs = c.documents_with([c.dep('?r', value=spec)], '?r')
        else:
            docs = c.documents_with([c.field(field, '?s', value=spec)], '?s')
        total_docs = len(docs)
        docs = _enough_for(docs, limit)
    if not docs:
        return f'No {field} matches "{pattern}".'

    out: List[str] = []
    shown = 0
    for did, _n in docs:
        if shown >= limit:
            break
        doc = ws.doc(did)
        hits = _hits_in(doc, field, matches)
        if not hits:
            continue
        out.append(f'"{doc.name}"')
        for s, w in hits:
            if shown >= limit:
                out.append('  … more in this document')
                break
            out.append(f'  {word_ref(s, w)}  {_value(w, field)}   {s.text[:90]}')
            shown += 1
    if not shown:
        return f'No {field} matches "{pattern}".'
    head = f'{shown} match(es) for {field} "{pattern}"'
    if total_docs is not None and total_docs > len(docs):
        head += f' (from {len(docs)} of the {total_docs} documents that have them)'
    return _truncate(head + ':\n' + '\n'.join(out))


def t_frequency_list(ws: Workspace, what: str = 'lemma', document: str = None,
                     limit: int = 30) -> str:
    """The commonest values of one column."""
    if what not in COUNTABLE:
        raise ToolError(f'Unknown column "{what}". One of: ' + ', '.join(COUNTABLE))
    limit = max(1, min(int(limit or 30), 200))
    if what == 'form' or document:
        # The engine does not know a form (a Form span overrides the token's
        # text), and one document is cheap to read outright.
        counts: Dict[str, int] = defaultdict(int)
        docs = [ws.doc(document)] if document else [ws.doc(d['id']) for d in ws.documents()[:DOCS_PER_SEARCH]]
        for doc in docs:
            for s in doc.sentences:
                for w in s.words:
                    v = _value(w, what)
                    if v:
                        counts[v] += 1
        rows = sorted(counts.items(), key=lambda kv: -kv[1])
        where = f' in "{docs[0].name}"' if document else f' (the first {len(docs)} documents)'
    else:
        c = _corpus(ws)
        if what == 'deprel':
            rows = [(r[0], r[-1]) for r in c.group([c.dep('?r')], ['?r.value'])]
        else:
            rows = [(r[0], r[-1]) for r in c.group([c.field(what, '?s')], ['?s.value'])]
        rows = [(v, n) for v, n in rows if v]
        where = ' across the project'
    if not rows:
        return f'Nothing has a {what} yet{where}.'
    total = sum(n for _, n in rows)
    out = [f'{what} by frequency{where}: {len(rows)} distinct value(s), {total} in all.']
    for v, n in rows[:limit]:
        out.append(f'  {n:>7}  {v}')
    if len(rows) > limit:
        out.append(f'  … and {len(rows) - limit} more')
    return _truncate('\n'.join(out))


CONSISTENCY = ('lemma-upos', 'form-lemma', 'rare-pairs')


def t_check_consistency(ws: Workspace, kind: str = None, limit: int = 25) -> str:
    """Places where the corpus disagrees with itself. Every one of these is a
    question, not a verdict: a lemma really can take two parts of speech."""
    kinds = [kind] if kind else list(CONSISTENCY)
    for k in kinds:
        if k not in CONSISTENCY:
            raise ToolError(f'Unknown check "{k}". One of: ' + ', '.join(CONSISTENCY))
    limit = max(1, min(int(limit or 25), 100))
    c = _corpus(ws)
    out: List[str] = []

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
        rows = c.group([c.word('?t'), c.field('lemma', '?l'), c.on('?l'),
                        c.field('form', '?f'), c.on('?f')], ['?f.value', '?l.value'])
        by = defaultdict(list)
        for form, lemma, n in rows:
            if form and lemma:
                by[form].append((lemma, n))
        multi = [(k, sorted(v, key=lambda x: -x[1])) for k, v in by.items() if len(v) > 1]
        multi.sort(key=lambda kv: -sum(n for _, n in kv[1]))
        out.append('')
        out.append(f'Forms with more than one lemma (only where a Form span is set): {len(multi)}.')
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
    return _truncate('\n'.join(out))


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
               document: str = None, limit: int = 20) -> str:
    """What is unfinished, by document, so a session has somewhere to start."""
    if kind not in WORKLIST_KINDS:
        raise ToolError(f'Unknown kind "{kind}". One of: ' + ', '.join(WORKLIST_KINDS))
    limit = max(1, min(int(limit or 20), 100))
    c = _corpus(ws)
    fields = [field] if field else list(FIELDS)
    for f in fields:
        if f not in FIELDS:
            raise ToolError(f'Unknown field "{f}". One of: ' + ', '.join(FIELDS))
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
                    out.append(f'  {word_ref(sent, w)}  {w.form}   {sent.text[:90]}')
                if len(hits) > limit:
                    out.append(f'  … and {len(hits) - limit} more (raise limit)')
            return _truncate('\n'.join(out))

        for f in fields:
            where = [c.word('?t'),
                     ['not', ['span', '?s', {'layer': c.p.layer(f)}], c.on('?s')]]
            docs = c.documents_with(where, '?t')
            total = sum(n for _, n in docs)
            out.append(f'{f}: {total} word(s) with none, in {len(docs)} document(s)')
            for did, n in docs[:limit]:
                out.append(f'    {n:>6}  "{c.doc_name(did)}"')
            if len(docs) > limit:
                out.append(f'    … and {len(docs) - limit} more documents')
        return _truncate('\n'.join(out) or 'Nothing is missing.')

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
                out.append(f'{f}: none waiting in "{doc.name}".')
                continue
            out.append(f'{f}: {len(hits)} {word} value(s) in "{doc.name}"')
            for sent, w in hits[:limit]:
                out.append(f'  {word_ref(sent, w)}  {_value(w, f)}   {sent.text[:90]}')
            if len(hits) > limit:
                out.append(f'  … and {len(hits) - limit} more (raise limit)')
        if not out:
            return f'Nothing is waiting for review in "{doc.name}" ({kind}).'
        out.append('')
        out.append('confirm marks these as reviewed; discard_predictions throws the machine ones away.')
        return _truncate('\n'.join(out))

    for f in fields:
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
    if not out:
        return f'Nothing is waiting for review ({kind}).'
    out.append('')
    out.append('confirm marks these as reviewed; discard_predictions throws the machine ones away.')
    return _truncate('\n'.join(out))


# --- history and comments --------------------------------------------------------

AUDIT_WINDOWS_DAYS = (7, 30, 180, None)


def t_recent_changes(ws: Workspace, document: str = None, limit: int = 20,
                     since: str = None, user: str = None) -> str:
    """Who changed what, when, under which operation label. The assistant's
    own applied plans appear here like anyone else's work."""
    import datetime
    import re as _re
    limit = max(1, min(int(limit or 20), 100))
    ws.on_progress('Reading the change history…')
    u = (user or '').casefold()

    def keep(e):
        who = e.get('user') or {}
        return not u or u in (who.get('display_name') or '').casefold() \
            or u in (who.get('id') or '').casefold()

    def fetch(start):
        kw = {'start_time': start} if start else {}
        try:
            if document:
                entries = ws.client.documents.audit(ws.resolve_document_id(document), **kw)
            else:
                entries = ws.client.projects.audit(ws.project.id, **kw)
        except Exception as e:  # noqa: BLE001 - the model reads the server's complaint
            raise ToolError(f'The change history could not be read: {e}')
        return [e for e in (entries or []) if keep(e)]

    if since:
        start = since.strip()
        if _re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
            start += 'T00:00:00Z'
        entries = fetch(start)
    else:
        now = datetime.datetime.now(datetime.timezone.utc)
        entries = []
        for days in AUDIT_WINDOWS_DAYS:
            start = (now - datetime.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ') if days else None
            entries = fetch(start)
            if len(entries) >= limit:
                break
    entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        return 'Nothing has changed here in the window read.'
    out = [f'{len(entries)} change(s), newest first. as_of is the instant to restore to.']
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])) or 'the project'
        what = e.get('message') or ', '.join(
            sorted({(o.get('type') or '').split('/')[0] for o in (e.get('ops') or [])})) or 'changes'
        out.append(f'  {e.get("time")}  {who}  {docs}: {what} ({len(e.get("ops") or [])} op(s))')
        out.append(f'      as_of={e.get("time")}')
    return _truncate('\n'.join(out))


def t_comments(ws: Workspace, document: str = None, ref: str = None, limit: int = 30) -> str:
    """What people have written to each other on a sentence or a document.
    These are notes between annotators, never annotation."""
    from .project import Sentence as _S
    limit = max(1, min(int(limit or 30), 100))
    doc = ws.doc(document)
    kw = {'document_id': doc.id}
    if ref:
        thing = ws.word(document, ref)
        if not isinstance(thing, _S):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence or on the document.')
        kw = {'entity_type': 'sentence', 'entity_id': thing.id}
    try:
        got = ws.client.comments.list(ws.project.id, **kw) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's complaint
        raise ToolError(f'The comments could not be read: {e}')
    if not got:
        return f'No comments on {ref}.' if ref else f'No comments in "{doc.name}".'
    # A comment names the entity it is anchored to; turn that back into the
    # positional reference the rest of the tools speak.
    where = {}
    for sn in doc.sentences:
        where[sn.id] = f's{sn.index}'
    out = []
    for cm in got[:limit]:
        who = (cm.get('user') or {}).get('display_name') or (cm.get('user') or {}).get('id') or '?'
        at = where.get(cm.get('entity_id'), doc.name)
        out.append(f'  {at}  {who} ({(cm.get("time") or "")[:10]}): {cm.get("body") or ""}')
    head = f'{len(got)} comment(s) in "{doc.name}"' + (f' on {ref}' if ref else '')
    if len(got) > limit:
        head += f', showing {limit}'
    return _truncate(head + ':\n' + '\n'.join(out))
