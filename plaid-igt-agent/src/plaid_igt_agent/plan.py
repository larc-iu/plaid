"""Proposed changes ("the plan") and their execution.

The assistant never writes during a chat turn. Its write tools append fully
resolved operations (ids, not positional references) to a plan that goes back
to the user with the turn; the user approves it in the UI, and the next
request carries the same operations back for :func:`execute_plan` to apply,
under one audit-log operation, with the requester's own client.

Approval is a human decision, so what a plan writes is VERIFIED by default:
machine-made (``prov: inferred`` with the assistant as ``provSource``, so the
origin stays traceable) and confirmed (``provConfirmed: true``), exactly the
state a person reaches by checking a service's output in the editor. The user
may instead approve a plan as HUMAN-made (``stamp_mode='human'``): nothing is
stamped, and rewritten entities lose their machine keys.

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
  merge_entries   {keep_id, remove_id, links: [{link_id, token_id}]}
  delete_entry    {item_id, links: [link_id]}
  rename_entry    {item_id, form}
  rename_document {document_id, name}
  set_morpheme_form {morpheme_id, form}   (a respelling carried into a morpheme's own form; no restamp, as in Bulk Edit)
  split_word      {word_id, position, morpheme_ids}          (coincident morphemes deleted first, as the editor does)
  merge_words     {word_id, other_ids, morpheme_ids, spans: [{layer_id, keep_id, value|null, delete_ids}],
                   links: {keep_id, delete_ids}}              (sequential merges, then the lossless span/link dedup)
  delete_word     {word_id, morpheme_ids}
  split_sentence  {sentence_id, position}
  merge_sentences {sentence_id, other_id, spans: [...]}
  edit_text       {document_id, text_id|null, sentence_id|null, begin, end, old, new, word_ids, morpheme_ids}
                  (append or retype: the region is re-verified against the live body, the edit goes through the
                   server's diffing text update so unchanged words keep their tokens, then sentence boundaries at
                   line starts and word tokens for untokenized text in the region are created from the real result)
  confirm         {span_ids, token_ids, link_ids}   (provConfirmed on machine-made material, any producer)
  discard_analysis {word_id, link_ids, span_ids, morpheme_ids, reset_first_id|null, renumber: [{id, precedence}]}

Each also carries a human ``label`` for the approval UI.
"""

from collections import Counter
from typing import Any, Dict, List

from plaid_client.provenance import (confirmed_inferred, PROV_KEY, PROV_SOURCE_KEY, PROV_CONFIRMED_KEY,
                                     PROV_PROB_KEY, PROV_DETAIL_KEY)

STAMP_MODES = ('verified', 'human')
# patch semantics: a null value deletes the key
CLEAR_PROV = {PROV_KEY: None, PROV_SOURCE_KEY: None, PROV_CONFIRMED_KEY: None, PROV_PROB_KEY: None, PROV_DETAIL_KEY: None}
CONFIRM = {PROV_CONFIRMED_KEY: True}

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


class PlanError(Exception):
    """A plan failed part-way. ``applied`` says how many ops had already been
    committed (each atomic batch commits on its own; the operation label is
    only an audit grouping)."""

    def __init__(self, message: str, applied: int, total: int):
        super().__init__(message)
        self.applied = applied
        self.total = total


KINDS = ('set_span', 'set_analysis', 'set_orthography', 'respell', 'link', 'unlink', 'create_entry',
         'set_entry_field', 'set_doc_metadata', 'create_document', 'merge_entries', 'delete_entry',
         'rename_entry', 'rename_document', 'confirm', 'discard_analysis', 'set_morpheme_form',
         'split_word', 'merge_words', 'delete_word', 'split_sentence', 'merge_sentences', 'edit_text')
REQUIRED = {
    'set_span': ('layer_id', 'token_id'), 'set_analysis': ('word_id', 'text_id', 'begin', 'end', 'morpheme_layer_id', 'morphemes'),
    'set_orthography': ('word_id', 'key'), 'respell': ('text_id', 'begin', 'end', 'value'),
    'link': ('token_id',), 'unlink': ('link_id',), 'create_entry': ('vocab_id', 'form', 'key'),
    'set_entry_field': ('item_id', 'field'), 'set_doc_metadata': ('document_id', 'field'),
    'create_document': ('name', 'text'), 'merge_entries': ('keep_id', 'remove_id'), 'delete_entry': ('item_id',),
    'rename_entry': ('item_id', 'form'), 'rename_document': ('document_id', 'name'),
    'confirm': (), 'discard_analysis': ('word_id',), 'set_morpheme_form': ('morpheme_id', 'form'),
    'split_word': ('word_id', 'position'), 'merge_words': ('word_id', 'other_ids'), 'delete_word': ('word_id',),
    'split_sentence': ('sentence_id', 'position'), 'merge_sentences': ('sentence_id', 'other_id'),
    'edit_text': ('document_id', 'begin', 'end', 'new'),
}


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    for i, op in enumerate(ops):
        kind = op.get('kind') if isinstance(op, dict) else None
        if kind not in KINDS:
            raise ValueError(f'op {i + 1}: unknown kind {kind!r}')
        for k in REQUIRED[kind]:
            if op.get(k) in (None, '') and not (k in ('begin', 'end') and op.get(k) == 0):
                raise ValueError(f'op {i + 1} ({kind}): missing {k}')
        if kind == 'set_analysis' and (not isinstance(op['morphemes'], list) or not op['morphemes']
                                       or any(not (m.get('form') or '').strip() for m in op['morphemes'])):
            raise ValueError(f'op {i + 1} (set_analysis): morphemes must be a non-empty list with non-empty forms')
        if kind == 'link' and not (op.get('item_id') or op.get('new_entry_key')):
            raise ValueError(f'op {i + 1} (link): needs item_id or new_entry_key')
        if kind == 'confirm' and not any(op.get(k) for k in ('span_ids', 'token_ids', 'link_ids')):
            raise ValueError(f'op {i + 1} (confirm): nothing to confirm')
        if kind == 'merge_words' and not isinstance(op['other_ids'], list):
            raise ValueError(f'op {i + 1} (merge_words): other_ids must be a list')
        if kind == 'edit_text' and not (op['new'] or '').strip():
            raise ValueError(f'op {i + 1} (edit_text): the new text is empty')


def _dead_tokens(ops) -> set:
    """Tokens (words and morphemes) shape ops in the plan delete."""
    dead = set()
    for op in ops:
        k = op.get('kind')
        if k in ('split_word', 'merge_words', 'delete_word'):
            dead.update(op.get('morpheme_ids') or [])
        if k == 'delete_word':
            dead.add(op['word_id'])
        elif k == 'merge_words':
            dead.update(op.get('other_ids') or [])
        elif k == 'merge_sentences':
            dead.add(op['other_id'])
        elif k == 'edit_text':
            dead.update(op.get('word_ids') or [])
            dead.update(op.get('morpheme_ids') or [])
    return dead


_TOKEN_KEYS = {'set_span': 'token_id', 'set_analysis': 'word_id', 'set_orthography': 'word_id', 'link': 'token_id',
               'set_morpheme_form': 'morpheme_id', 'discard_analysis': 'word_id', 'split_word': 'word_id',
               'split_sentence': 'sentence_id'}


def _doomed_ids(ops) -> set:
    """Ids other ops in the plan delete, which a confirm must not touch (a
    patch of a deleted entity fails the whole batch)."""
    gone = set()
    for op in ops:
        k = op.get('kind')
        if k == 'set_span' and op.get('span_id') and (op.get('value') or '') == '':
            gone.add(op['span_id'])
        elif k == 'set_analysis':
            ex = op.get('existing') or []
            gone.update(m['id'] for m in ex[1:])
            if ex:
                gone.update(ex[0].get('span_ids') or [])
        elif k == 'unlink':
            gone.add(op['link_id'])
        elif k == 'link' and op.get('existing_link_id'):
            gone.add(op['existing_link_id'])
        elif k == 'merge_entries':
            gone.update(l['link_id'] for l in op.get('links') or [])
        elif k == 'delete_entry':
            gone.update(op.get('links') or [])
        elif k == 'discard_analysis':
            gone.update(op.get('link_ids') or [])
            gone.update(op.get('span_ids') or [])
            gone.update(op.get('morpheme_ids') or [])
        elif k in ('merge_words', 'merge_sentences'):
            for sp in op.get('spans') or []:
                gone.update(sp.get('delete_ids') or [])
            gone.update((op.get('links') or {}).get('delete_ids') or [])
    gone.update(_dead_tokens(ops))
    return gone


def normalize_ops(ops: List[Dict[str, Any]]) -> tuple:
    """Resolve interactions between ops in one plan: drop links to entries the
    plan deletes or merges away, refuse a merge whose survivor is removed by
    another op, dedupe entry deletes, collapse repeated respells of one range
    (last wins) and refuse overlapping ones. Returns (ops, notes)."""
    notes: List[str] = []
    removed = {op['remove_id'] for op in ops if op.get('kind') == 'merge_entries'} | \
        {op['item_id'] for op in ops if op.get('kind') == 'delete_entry'}
    # Morphemes another op rewrites wholesale (set_analysis replaces the chain,
    # discard_analysis deletes or resets it): a form patch on them is moot.
    rewritten = set()
    for op in ops:
        if op.get('kind') == 'set_analysis':
            rewritten.update(m['id'] for m in op.get('existing') or [])
        elif op.get('kind') == 'discard_analysis':
            rewritten.update(op.get('morpheme_ids') or [])
            if op.get('reset_first_id'):
                rewritten.add(op['reset_first_id'])
    for op in ops:
        if op.get('kind') == 'merge_entries' and op['keep_id'] in removed:
            raise ValueError(f'merge into {op["keep_id"]}: that entry is deleted or merged away by another op in this plan')
    out: List[Dict[str, Any]] = []
    seen_delete = set()
    respell_at: Dict[tuple, int] = {}
    doomed = _doomed_ids(ops)
    dead = _dead_tokens(ops)
    for op in ops:
        k = op.get('kind')
        key = _TOKEN_KEYS.get(k)
        if key and op.get(key) in dead:
            raise ValueError(f'{op.get("label") or k}: that word or morpheme is deleted or merged away by another '
                             'op in this plan')
        if k == 'link' and op.get('item_id') in removed:
            notes.append(f'dropped: {op.get("label") or "a link"} (its entry is deleted in this plan)')
            continue
        if k == 'set_morpheme_form' and op['morpheme_id'] in rewritten:
            notes.append(f'dropped: {op.get("label") or "a morpheme form"} (that analysis is rewritten in this plan)')
            continue
        if k == 'confirm' and doomed:
            op = {**op, **{key: [i for i in (op.get(key) or []) if i not in doomed]
                           for key in ('span_ids', 'token_ids', 'link_ids')}}
            if not any(op[key] for key in ('span_ids', 'token_ids', 'link_ids')):
                notes.append(f'dropped: {op.get("label") or "a confirmation"} (everything it confirms is deleted in this plan)')
                continue
        if k == 'delete_entry':
            if op['item_id'] in seen_delete:
                continue
            seen_delete.add(op['item_id'])
        if k == 'respell':
            key = (op['text_id'], op['begin'], op['end'])
            for (t, b, e), idx in respell_at.items():
                if t == op['text_id'] and (b, e) != (op['begin'], op['end']) and b < op['end'] and op['begin'] < e:
                    raise ValueError(f'respellings overlap in one text ({b}-{e} and {op["begin"]}-{op["end"]})')
            if key in respell_at:
                out[respell_at[key]] = op  # last wins
                continue
            respell_at[key] = len(out)
        out.append(op)
    return out, notes


def execute_plan(client, ops: List[Dict[str, Any]], *, source: str, label: str, project=None,
                 stamp_mode: str = 'verified') -> Dict[str, int]:
    """Apply ``ops`` with ``client`` under one operation labelled ``label``.
    Returns per-kind counts of what was applied (plus ``notes`` for anything
    dropped). ``project`` (an IgtProject) is needed only by document-creating
    ops. ``stamp_mode`` is ``'verified'`` (machine-made, human-confirmed: the
    default) or ``'human'`` (no provenance keys at all). Raises
    :class:`PlanError` with the applied count if a later batch fails: batches
    are atomic individually, the plan as a whole is not."""
    if stamp_mode not in STAMP_MODES:
        raise ValueError(f'stamp_mode must be one of {STAMP_MODES}')
    validate_ops(ops)
    ops, notes = normalize_ops(ops)
    counts: Counter = Counter()
    try:
        return _execute(client, ops, source=source, label=label, project=project, counts=counts, notes=notes,
                        stamp_mode=stamp_mode)
    except PlanError:
        raise
    except Exception as e:
        applied = getattr(e, '_applied', None)
        raise PlanError(f'{type(e).__name__}: {e}', applied if applied is not None else 0, len(ops)) from e


def _execute(client, ops, *, source, label, project, counts, notes, stamp_mode) -> Dict[str, int]:
    new_docs = []
    human = stamp_mode == 'human'

    def stamp():
        """Metadata merged into everything the plan creates (empty when there is nothing to stamp)."""
        return {} if human else confirmed_inferred(source)

    def restamp():
        """Metadata patched onto an entity the plan rewrites: the new value is
        this plan's, whatever the entity was before."""
        return CLEAR_PROV if human else confirmed_inferred(source)

    applied = [0]

    class _Tracker(Batcher):
        def flush(self):
            n = self._pending
            try:
                super().flush()
            except Exception as e:
                e._applied = applied[0]
                raise
            applied[0] += n

    with client.operation(label):
        b = _Tracker(client)
        pending_spans = []   # (result idx of the created morpheme, layer_id, value)
        pending_links = []   # (token_id, new_entry_key)
        entry_idx: Dict[str, int] = {}
        respells: Dict[str, List[tuple]] = {}
        pending_deletes: List[str] = []  # entries to delete once their links are gone
        text_edits: List[Dict[str, Any]] = []

        for op in ops:
            kind = op.get('kind')
            if kind == 'set_span':
                span_id, value = op.get('span_id'), op.get('value') or ''
                if span_id and value == '':
                    b.add(lambda sid=span_id: client.spans.delete(sid))
                elif span_id:
                    b.add(lambda sid=span_id, v=value: client.spans.update(sid, v))
                    b.add(lambda sid=span_id: client.spans.patch_metadata(sid, restamp()))
                elif value != '':
                    b.add(lambda o=op, v=value: client.spans.create(o['layer_id'], [o['token_id']], v, stamp()))
                else:
                    continue  # nothing to clear
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
                        mid, {'form': f['form'], 'morphType': f.get('morph_type'), **restamp()}))
                    # Keep the chain's numbering contiguous from 1 whatever the
                    # first morpheme's precedence was before.
                    b.add(lambda mid=m0['id']: client.tokens.update(mid, precedence=1))
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

            elif kind == 'merge_entries':
                for l in op.get('links') or []:
                    b.add(lambda lid=l['link_id']: client.vocab_links.delete(lid))
                    b.add(lambda o=op, t=l['token_id']: client.vocab_links.create(o['keep_id'], [t], stamp()))
                pending_deletes.append(op['remove_id'])
                counts['merged entries'] += 1

            elif kind == 'delete_entry':
                for lid in op.get('links') or []:
                    b.add(lambda lid=lid: client.vocab_links.delete(lid))
                pending_deletes.append(op['item_id'])
                counts['deleted entries'] += 1

            elif kind == 'rename_entry':
                b.add(lambda o=op: client.vocab_items.update(o['item_id'], o['form']))
                counts['renamed entries'] += 1

            elif kind == 'rename_document':
                b.add(lambda o=op: client.documents.update(o['document_id'], o['name']))
                counts['renamed documents'] += 1

            elif kind == 'set_morpheme_form':
                b.add(lambda o=op: client.tokens.patch_metadata(o['morpheme_id'], {'form': o['form']}))
                counts['morpheme forms'] += 1

            elif kind == 'split_word':
                if op.get('morpheme_ids'):
                    b.add(lambda o=op: client.tokens.bulk_delete(list(o['morpheme_ids'])))
                b.add(lambda o=op: client.tokens.split(o['word_id'], o['position']))
                counts['split words'] += 1

            elif kind in ('merge_words', 'merge_sentences'):
                if op.get('morpheme_ids'):
                    b.add(lambda o=op: client.tokens.bulk_delete(list(o['morpheme_ids'])))
                others = op['other_ids'] if kind == 'merge_words' else [op['other_id']]
                key = 'word_id' if kind == 'merge_words' else 'sentence_id'
                # Sequential merges into the survivor: the server runs batch ops
                # in order, so each merge sees the widened extent. The dedup
                # ops after them see the reparented spans and links.
                for oid in others:
                    b.add(lambda o=op, x=oid, key=key: client.tokens.merge(o[key], x))
                for sp in op.get('spans') or []:
                    if sp.get('value') is not None:
                        b.add(lambda sp=sp: client.spans.update(sp['keep_id'], sp['value']))
                    for sid in sp.get('delete_ids') or []:
                        b.add(lambda i=sid: client.spans.delete(i))
                for lid in (op.get('links') or {}).get('delete_ids') or []:
                    b.add(lambda i=lid: client.vocab_links.delete(i))
                counts['merged words' if kind == 'merge_words' else 'merged sentences'] += 1

            elif kind == 'delete_word':
                b.add(lambda o=op: client.tokens.delete(o['word_id']))  # cascades morphemes, spans, links
                counts['deleted words'] += 1

            elif kind == 'split_sentence':
                b.add(lambda o=op: client.tokens.split(o['sentence_id'], o['position']))
                counts['split sentences'] += 1

            elif kind == 'edit_text':
                text_edits.append(op)  # after the batches: several dependent calls
                counts['text edits'] += 1

            elif kind == 'confirm':
                for tid in op.get('token_ids') or []:
                    b.add(lambda i=tid: client.tokens.patch_metadata(i, CONFIRM))
                for lid in op.get('link_ids') or []:
                    b.add(lambda i=lid: client.vocab_links.patch_metadata(i, CONFIRM))
                for sid in op.get('span_ids') or []:
                    b.add(lambda i=sid: client.spans.patch_metadata(i, CONFIRM))
                counts['confirmed annotations'] += (len(op.get('token_ids') or []) + len(op.get('link_ids') or [])
                                                    + len(op.get('span_ids') or []))

            elif kind == 'discard_analysis':
                # The editor's discardWordAnalysis: machine links and spans go,
                # machine morphemes after the first go (their spans and links
                # cascade server-side, so they are not deleted separately), a
                # machine first morpheme is reset to the healed default, and
                # survivors are renumbered gap-free.
                for lid in op.get('link_ids') or []:
                    b.add(lambda i=lid: client.vocab_links.delete(i))
                for sid in op.get('span_ids') or []:
                    b.add(lambda i=sid: client.spans.delete(i))
                for mid in op.get('morpheme_ids') or []:
                    b.add(lambda i=mid: client.tokens.delete(i))
                if op.get('reset_first_id'):
                    b.add(lambda i=op['reset_first_id']: client.tokens.patch_metadata(
                        i, {'form': None, 'morphType': None, **CLEAR_PROV}))
                for r in op.get('renumber') or []:
                    b.add(lambda r=r: client.tokens.update(r['id'], precedence=r['precedence']))
                counts['discarded analyses'] += 1

            else:
                raise ValueError(f'Unknown plan operation kind: {kind}')  # unreachable after validate_ops

        b.flush()

        # Second pass: things that need ids minted above.
        for idx, layer_id, value in pending_spans:
            mid = _created_id(b.results[idx] if idx < len(b.results) else None)
            if not mid:
                raise RuntimeError('a created morpheme came back without an id; its gloss was not written')
            b.add(lambda l=layer_id, m=mid, v=value: client.spans.create(l, [m], v, stamp()))
        for token_id, key in pending_links:
            i = entry_idx.get(key)
            iid = _created_id(b.results[i]) if i is not None and i < len(b.results) else None
            if not iid:
                raise RuntimeError('a created lexicon entry came back without an id; a link to it was not written')
            b.add(lambda i=iid, t=token_id: client.vocab_links.create(i, [t], stamp()))
        for iid in pending_deletes:
            b.add(lambda i=iid: client.vocab_items.delete(i))
        b.flush()

        # Text edits after the batches (which carry pre-edit offsets).
        # Region edits first, highest region first: each is re-verified
        # against the live body, and the tools only let a region sit after
        # every respelling of the same text, so the respellings' offsets
        # still hold afterwards.
        for op in sorted(text_edits, key=lambda o: -o['begin']):
            if project is None:
                raise ValueError('edit_text needs the project')
            _apply_text_edit(client, project, op)
        # Whole-token replaces keep the token (and its morphemes, which share
        # its extent) and shift everything after it.
        for text_id, edits in respells.items():
            edits.sort(key=lambda e: -e[0])
            client.texts.update(text_id, [{'type': 'replace', 'index': bg, 'length': en - bg, 'value': v}
                                          for bg, en, v in edits])

        for op in new_docs:
            if project is None:
                raise ValueError('create_document needs the project')
            create_document(client, project, op['name'], op['text'], op.get('metadata') or {})
    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


def create_document(client, project, name: str, text: str, metadata: Dict[str, Any]):
    """Document + baseline text + sentence and word tokens, tokenized as the
    editor would (one sentence per line, words split on whitespace and
    punctuation). Returns the new document id."""
    doc = client.documents.create(project.id, name, metadata or None)
    doc_id = doc['id']
    try:
        _seed_text(client, project, doc_id, text)
    except Exception:
        # No orphan half-document: best effort, the original error is what matters.
        try:
            client.documents.delete(doc_id)
        except Exception:
            pass
        raise
    return doc_id


def _seed_text(client, project, doc_id: str, text: str) -> str:
    """A document's first text, with sentence and word tokens. Returns the text id."""
    from .tools import split_sentences, split_words
    t = client.texts.create(project.text_layer_id, doc_id, text)
    text_id = t['id']
    sents = split_sentences(text)
    body = [{'token_layer_id': project.sentence_layer_id, 'text': text_id, 'begin': b, 'end': e} for b, e in sents]
    for b, e in sents:
        body.extend({'token_layer_id': project.word_layer_id, 'text': text_id, 'begin': wb, 'end': we}
                    for wb, we in split_words(text, b, e, project.ignored_cfg))
    if body:
        client.tokens.bulk_create(body)
    return text_id


def _line_starts(body: str, begin: int, end: int) -> List[int]:
    """Where sentences should begin inside body[begin:end): the region's
    first non-blank position and the one after every newline in it (leading
    whitespace stays with the sentence before, as the server's gap-fill
    leaves it)."""
    i = begin
    while i < end and body[i].isspace():
        i += 1
    out = [i]
    while i < end:
        if body[i] == '\n':
            j = i + 1
            while j < end and body[j].isspace():
                j += 1
            if j < end:
                out.append(j)
            i = j
        else:
            i += 1
    return out


def _gaps(ranges: List[tuple], begin: int, end: int) -> List[tuple]:
    """Sub-ranges of [begin, end) no range in ``ranges`` covers."""
    out = []
    cur = begin
    for b, e in sorted(ranges):
        if e <= cur:
            continue
        if b >= end:
            break
        if b > cur:
            out.append((cur, b))
        cur = max(cur, e)
    if cur < end:
        out.append((cur, end))
    return out


def _apply_text_edit(client, project, op: Dict[str, Any]) -> None:
    """Replace body[begin:end] (verified to still read ``old``) with ``new``
    through the server's diffing text update, then give the edited region
    the sentence boundaries its line starts call for and word tokens for
    whatever text in it is untokenized, as the editor's baseline save plus
    its tokenizer would."""
    from .project import _find_layer
    from .tools import split_words
    doc_id, text_id, new = op['document_id'], op.get('text_id'), op['new']
    if not text_id:
        _seed_text(client, project, doc_id, new)
        return
    raw = client.documents.get(doc_id, include_body=True)
    tl, _ = _find_layer(raw.get('text_layers'), project.word_layer_id)
    body = ((tl or {}).get('text') or {}).get('body') or ''
    b, e = op['begin'], op['end']
    if body[b:e] != op['old']:
        raise ValueError(f'the text no longer reads "{op["old"][:40]}" at {b}-{e}; the document changed since the plan was made')
    new_body = body[:b] + new + body[e:]
    client.texts.update(text_id, new_body)
    region_end = b + len(new)

    raw = client.documents.get(doc_id, include_body=True)
    _, sent_layer = _find_layer(raw.get('text_layers'), project.sentence_layer_id)
    _, word_layer = _find_layer(raw.get('text_layers'), project.word_layer_id)
    sents = sorted((t['begin'], t['end'], t['id']) for t in (sent_layer or {}).get('tokens') or [])
    if not sents and new_body:
        r = client.tokens.create(project.sentence_layer_id, text_id, 0, len(new_body))
        sents = [(0, len(new_body), r['id'])]
    for p in _line_starts(new_body, b, region_end):
        hit = next((s for s in sents if s[0] < p < s[1]), None)
        # Only a boundary that leaves text on both sides: never a blank sentence.
        if hit is None or not new_body[hit[0]:p].strip() or not new_body[p:hit[1]].strip():
            continue
        sb, se, sid = hit
        r = client.tokens.split(sid, p)
        sents.remove(hit)
        sents.extend([(sb, p, sid), (p, se, r['id'])])
        sents.sort()
    words = [(t['begin'], t['end']) for t in (word_layer or {}).get('tokens') or []]
    creates = []
    for gb, ge in _gaps(words, b, region_end):
        # A gap never straddles a sentence boundary (those sit after whitespace).
        creates.extend({'token_layer_id': project.word_layer_id, 'text': text_id, 'begin': wb, 'end': we}
                       for wb, we in split_words(new_body, gb, ge, project.ignored_cfg))
    if creates:
        client.tokens.bulk_create(creates)


def summarize(ops: List[Dict[str, Any]]) -> str:
    counts = Counter(op.get('kind') for op in ops)
    names = {'set_span': ('field value', 'field values'), 'set_analysis': ('analysis', 'analyses'),
             'set_orthography': ('orthography value', 'orthography values'), 'respell': ('respelling', 'respellings'),
             'link': ('lexicon link', 'lexicon links'), 'unlink': ('unlink', 'unlinks'),
             'create_entry': ('new lexicon entry', 'new lexicon entries'), 'set_entry_field': ('entry field', 'entry fields'),
             'set_doc_metadata': ('document metadata value', 'document metadata values'),
             'create_document': ('new document', 'new documents'),
             'merge_entries': ('merged entry', 'merged entries'), 'delete_entry': ('deleted entry', 'deleted entries'),
             'rename_entry': ('renamed entry', 'renamed entries'), 'rename_document': ('renamed document', 'renamed documents'),
             'confirm': ('confirmation', 'confirmations'), 'discard_analysis': ('discarded analysis', 'discarded analyses'),
             'set_morpheme_form': ('morpheme form', 'morpheme forms'),
             'split_word': ('split word', 'split words'), 'merge_words': ('word merge', 'word merges'),
             'delete_word': ('deleted word', 'deleted words'), 'split_sentence': ('split sentence', 'split sentences'),
             'merge_sentences': ('sentence merge', 'sentence merges'), 'edit_text': ('text edit', 'text edits')}
    parts = []
    for kind, n in counts.items():
        one, many = names.get(kind, (kind, kind))
        parts.append(f'{n} {one if n == 1 else many}')
    return ', '.join(parts) if parts else 'no changes'
