"""Proposed changes ("the plan") and their execution.

The assistant never writes during a chat turn. Its write tools append fully
resolved operations (ids, not positional references) to a plan that goes back
to the user with the turn; the user approves it in the UI, and the next
request carries the same operations back for :func:`execute_plan` to apply,
under one audit-log operation, with the requester's own client.

Every span, morpheme, and link the plan creates is stamped machine-made
(``stamp_inferred``), so it renders as unverified in the editor until a person
confirms it, the same as any other service's output.

Operation shapes (all keys snake_case, no id-keyed maps, so they survive the
wire's key recasing):

  set_span        {layer_id, token_id, span_id|null, value}
  set_analysis    {word_id, text_id, begin, end, morpheme_layer_id,
                   existing: [{id, span_ids: [..]}], morphemes: [{form, morph_type, fields: [{layer_id, value}]}]}
  set_orthography {word_id, key, value}
  respell         {text_id, begin, end, value}
  link            {token_id, item_id|null, new_entry_key|null, existing_link_id|null}
  unlink          {link_id}
  create_entry    {vocab_id, form, metadata, key}
  set_entry_field {item_id, field, value}
  set_doc_metadata {document_id, field, value}
  create_document {name, text, metadata}   (needs the project: text layer, token layers, ignored config)

Each also carries a human ``label`` for the approval UI.
"""

from collections import Counter
from typing import Any, Dict, List

from plaid_client.provenance import stamp_inferred

BATCH_OP_BUDGET = 800  # the server caps one atomic batch at 1000 ops


class Batcher:
    """Queue client calls into atomic batches of at most ``budget`` ops,
    flushing as the budget fills. ``add`` returns a GLOBAL result index valid
    after the next ``flush``; ``results`` accumulates across flushes."""

    def __init__(self, client, budget: int = BATCH_OP_BUDGET):
        self.client = client
        self.budget = budget
        self.results: List[Any] = []
        self._pending = 0
        self._open = False

    def add(self, fn) -> int:
        if not self._open:
            self.client.begin_batch()
            self._open = True
        fn()
        idx = len(self.results) + self._pending
        self._pending += 1
        if self._pending >= self.budget:
            self.flush()
        return idx

    def flush(self) -> None:
        if not self._open:
            return
        try:
            res = self.client.submit_batch()
        except BaseException:
            if self.client.is_batch_mode():
                self.client.abort_batch()
            raise
        finally:
            self._open = False
        self.results.extend(res or [])
        self._pending = 0


def _created_id(r):
    if isinstance(r, dict):
        body = r.get('body')
        if isinstance(body, dict):
            return body.get('id')
    return None


def execute_plan(client, ops: List[Dict[str, Any]], *, source: str, label: str, project=None) -> Dict[str, int]:
    """Apply ``ops`` with ``client`` under one operation labelled ``label``.
    Returns per-kind counts of what was applied. ``project`` (an IgtProject)
    is needed only by document-creating ops."""
    counts: Counter = Counter()
    new_docs = []

    def stamp():
        return stamp_inferred(source)

    with client.operation(label):
        b = Batcher(client)
        pending_spans = []   # (result idx of the created morpheme, layer_id, value)
        pending_links = []   # (token_id, new_entry_key)
        entry_idx: Dict[str, int] = {}
        respells: Dict[str, List[tuple]] = {}

        for op in ops:
            kind = op.get('kind')
            if kind == 'set_span':
                span_id, value = op.get('span_id'), op.get('value') or ''
                if span_id and value == '':
                    b.add(lambda sid=span_id: client.spans.delete(sid))
                elif span_id:
                    b.add(lambda sid=span_id, v=value: client.spans.update(sid, v))
                    b.add(lambda sid=span_id: client.spans.patch_metadata(sid, stamp()))
                elif value != '':
                    b.add(lambda o=op, v=value: client.spans.create(o['layer_id'], [o['token_id']], v, stamp()))
                counts['field values'] += 1

            elif kind == 'set_analysis':
                existing = op.get('existing') or []
                morphemes = op.get('morphemes') or []
                layer, text_id = op['morpheme_layer_id'], op['text_id']
                begin, end = op['begin'], op['end']
                if existing:
                    m0 = existing[0]
                    for m in existing[1:]:
                        b.add(lambda mid=m['id']: client.tokens.delete(mid))  # cascades spans + links
                    for sid in m0.get('span_ids') or []:
                        b.add(lambda s=sid: client.spans.delete(s))
                    first = morphemes[0]
                    b.add(lambda mid=m0['id'], f=first: client.tokens.patch_metadata(
                        mid, {'form': f['form'], 'morphType': f.get('morph_type'), **stamp()}))
                    for fv in first.get('fields') or []:
                        if fv.get('value') not in (None, ''):
                            b.add(lambda mid=m0['id'], fv=fv: client.spans.create(fv['layer_id'], [mid], fv['value'], stamp()))
                    rest = list(enumerate(morphemes))[1:]
                else:
                    rest = list(enumerate(morphemes))
                for j, m in rest:
                    meta = {'form': m['form'], **stamp()}
                    if m.get('morph_type'):
                        meta['morphType'] = m['morph_type']
                    idx = b.add(lambda j=j, meta=meta: client.tokens.create(
                        layer, text_id, begin, end, precedence=j + 1, metadata=meta))
                    for fv in m.get('fields') or []:
                        if fv.get('value') not in (None, ''):
                            pending_spans.append((idx, fv['layer_id'], fv['value']))
                counts['analyses'] += 1

            elif kind == 'set_orthography':
                b.add(lambda o=op: client.tokens.patch_metadata(o['word_id'], {o['key']: o.get('value') or None}))
                counts['orthography values'] += 1

            elif kind == 'respell':
                respells.setdefault(op['text_id'], []).append((op['begin'], op['end'], op['value']))
                counts['respellings'] += 1

            elif kind == 'link':
                if op.get('existing_link_id'):
                    b.add(lambda lid=op['existing_link_id']: client.vocab_links.delete(lid))
                if op.get('item_id'):
                    b.add(lambda o=op: client.vocab_links.create(o['item_id'], [o['token_id']], stamp()))
                elif op.get('new_entry_key'):
                    pending_links.append((op['token_id'], op['new_entry_key']))
                counts['links'] += 1

            elif kind == 'unlink':
                b.add(lambda lid=op['link_id']: client.vocab_links.delete(lid))
                counts['unlinks'] += 1

            elif kind == 'create_entry':
                entry_idx[op['key']] = b.add(lambda o=op: client.vocab_items.create(
                    o['vocab_id'], o['form'], {**(o.get('metadata') or {}), **stamp()}))
                counts['lexicon entries'] += 1

            elif kind == 'set_entry_field':
                b.add(lambda o=op: client.vocab_items.patch_metadata(o['item_id'], {o['field']: o.get('value') or None}))
                counts['entry fields'] += 1

            elif kind == 'set_doc_metadata':
                b.add(lambda o=op: client.documents.patch_metadata(o['document_id'], {o['field']: o.get('value') or None}))
                counts['document metadata values'] += 1

            elif kind == 'create_document':
                new_docs.append(op)  # after the batches: several dependent calls
                counts['new documents'] += 1

            else:
                raise ValueError(f'Unknown plan operation kind: {kind}')

        b.flush()

        # Second pass: things that need ids minted above.
        for idx, layer_id, value in pending_spans:
            mid = _created_id(b.results[idx] if idx < len(b.results) else None)
            if mid:
                b.add(lambda l=layer_id, m=mid, v=value: client.spans.create(l, [m], v, stamp()))
        for token_id, key in pending_links:
            i = entry_idx.get(key)
            iid = _created_id(b.results[i]) if i is not None and i < len(b.results) else None
            if iid:
                b.add(lambda i=iid, t=token_id: client.vocab_links.create(i, [t], stamp()))
        b.flush()

        # Text edits last: whole-token replaces keep the token (and its
        # morphemes, which share its extent) and shift everything after it,
        # so they must not precede ops that carry pre-edit offsets.
        for text_id, edits in respells.items():
            edits.sort(key=lambda e: -e[0])
            client.texts.update(text_id, [{'type': 'replace', 'index': bg, 'length': en - bg, 'value': v}
                                          for bg, en, v in edits])

        for op in new_docs:
            if project is None:
                raise ValueError('create_document needs the project')
            create_document(client, project, op['name'], op['text'], op.get('metadata') or {})
    return dict(counts)


def create_document(client, project, name: str, text: str, metadata: Dict[str, Any]):
    """Document + baseline text + sentence and word tokens, tokenized as the
    editor would (one sentence per line, words split on whitespace and
    punctuation). Returns the new document id."""
    from .tools import split_sentences, split_words
    doc = client.documents.create(project.id, name, metadata or None)
    doc_id = doc['id']
    t = client.texts.create(project.text_layer_id, doc_id, text)
    text_id = t['id']
    sents = split_sentences(text)
    body = [{'token_layer_id': project.sentence_layer_id, 'text': text_id, 'begin': b, 'end': e} for b, e in sents]
    for b, e in sents:
        body.extend({'token_layer_id': project.word_layer_id, 'text': text_id, 'begin': wb, 'end': we}
                    for wb, we in split_words(text, b, e, project.ignored_cfg))
    if body:
        client.tokens.bulk_create(body)
    return doc_id


def summarize(ops: List[Dict[str, Any]]) -> str:
    counts = Counter(op.get('kind') for op in ops)
    names = {'set_span': ('field value', 'field values'), 'set_analysis': ('analysis', 'analyses'),
             'set_orthography': ('orthography value', 'orthography values'), 'respell': ('respelling', 'respellings'),
             'link': ('lexicon link', 'lexicon links'), 'unlink': ('unlink', 'unlinks'),
             'create_entry': ('new lexicon entry', 'new lexicon entries'), 'set_entry_field': ('entry field', 'entry fields'),
             'set_doc_metadata': ('document metadata value', 'document metadata values'),
             'create_document': ('new document', 'new documents')}
    parts = []
    for kind, n in counts.items():
        one, many = names.get(kind, (kind, kind))
        parts.append(f'{n} {one if n == 1 else many}')
    return ', '.join(parts) if parts else 'no changes'
