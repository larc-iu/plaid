"""Proposed changes ("the plan") and their execution.

The assistant never writes during a chat turn. Its write tools append fully
resolved operations (ids, not positional references) to a plan that goes back
to the user with the turn. The user approves it in the UI, and the next
request carries the same operations back for :func:`execute_plan` to apply,
under one audit-log operation, with the requester's own client.

Approval is a human decision, so what a plan writes is VERIFIED by default:
machine-made (``prov: inferred`` with the assistant as ``provSource``, so the
origin stays traceable) and confirmed (``provConfirmed: true``), exactly the
state a person reaches by checking a service's output in the editor. The user
may instead approve a plan as HUMAN-made (``stamp_mode='human'``): nothing is
stamped, and rewritten entities lose their machine keys. When the approver is
a CONTRIBUTOR (a writer whose work the project reviews), their approval is a
contribution, not a verification: ``stamp_mode='contributed'`` with the
approver's ``contributor`` id stamps everything contributed, and rewritten
entities lose any earlier confirmation.

**Every kind is declared once**, in :data:`KIND` below: its required keys, the
noun the user reads, what applies it (or, for a scope, what it resolves into at
approval), what it writes to, what it deletes, whether it reshapes the text, and
how like operations fold into one stored operation.
``RESHAPES``, ``SCOPES``, ``EXCLUSIVE_KINDS``, the compaction spec,
the executor's dispatch and the approval card's tables are all read off it (see
:mod:`plaid_agent.core.opkind`), so adding a kind is one declaration.

Operation shapes (all keys snake_case, no id-keyed maps, so they survive the
wire's key recasing):

  set_span        {layer_id, token_id, span_id|null, value}
  set_analysis    {word_id, text_id, begin, end, morpheme_layer_id,
                   existing: [{id, span_ids: [..]}], morphemes: [{form, morph_type, fields: [{layer_id, value}]}]}
  set_orthography {word_id, key, value}
  respell         {text_id, begin, end, value}
  link            {token_id, item_id|null, new_entry_key|null, existing_link_id|null, entry_form}
                  or, for a morpheme of an analysis a set_analysis in the same plan writes, token_id null and
                  {analysis_word_id, morpheme_index (from 1), morpheme_form, reuses_morpheme_id|null}: written
                  when the plan is applied, once that analysis has minted its morphemes (see `planned_morpheme`).
                  reuses_morpheme_id is the stored first morpheme an analysis keeps as its first, at index 1.
                  entry_form is the entry's headword as the plan read it, for a refusal naming an entry gone
  unlink          {link_id}
  create_entry    {vocab_id, form, metadata, key}
  set_entry_field {item_id, field, value}
  set_entry_metadata {item_id, patch}   (reserved keys on an entry: the sense tree, promoted examples, and the
                   reference repair a delete or merge carries, and a null in the patch deletes that key)
  set_doc_metadata {document_id, field, value}
  create_document {name, text, metadata}   (needs the project: text layer, token layers, ignored config)
  merge_entries   {keep_id, remove_id, links: [{link_id, token_id}]}
  delete_entry    {item_id, links: [link_id]}
  rename_entry    {item_id, form}
  rename_document {document_id, name}
  set_morpheme_form {morpheme_id, form, restamp?}   (a respelling carried into a morpheme's own form, with no restamp, as in
                   Bulk Edit, or with restamp true a direct correction of one morpheme, stamped as every rewrite is)
  split_word      {word_id, position, morpheme_ids}          (coincident morphemes deleted first, as the editor does)
  merge_words     {word_id, other_ids, morpheme_ids, spans: [{layer_id, keep_id, value|null, delete_ids}],
                   links: {keep_id, delete_ids}, mwe_ids}     (the collapsed expressions' links deleted, then
                   sequential merges. spans and links say what the server's layer rules join and drop in
                   the merge's own transaction, for the card and the guards, and are not written)
  delete_word     {word_id, morpheme_ids}
  split_sentence  {sentence_id, position}
  merge_sentences {sentence_id, other_id, spans: [...]}
  edit_text       {document_id, text_id|null, sentence_id|null, begin, end, old, new, word_ids, morpheme_ids}
                  (append or retype: the region is re-verified against the live body, the edit goes through the
                   server's diffing text update so unchanged words keep their tokens, then sentence boundaries at
                   line starts and word tokens for untokenized text in the region are created from the real result)
  confirm         {span_ids, token_ids, link_ids, on: {id: token_id}, named}   (provConfirmed on material
                  awaiting review, any origin. `on` says which token each span and link sits on. `named` marks
                  one the model named by reference, which writes to what it names; without it the op covers
                  whatever a document has awaiting review, and what the plan deletes is left out at approval)
  discard_analysis {word_id, link_ids, span_ids, morpheme_ids, reset_first_id|null, renumber: [{id, precedence}]}
  link_phrase     {token_ids: [word ids], item_id|null, new_entry_key|null, existing_link_id|null}
                  (a multi-word expression: one link over two or more words, and unlink with token_ids is one too)
  set_morph_type  {morpheme_id, morph_type|null}   (stamped as every rewrite is)
  add_comment     {entity_type, entity_id, body, anchor_label, document_id}   (unaudited, as every comment)
  restore_document {document_id, as_of}   (the server's own restore, always a plan of its own)
  delete_word may carry link_ids: multi-word expressions the deletion would leave with one member.
  merge_entries links are [{link_id, token_ids}] so a moved multi-word expression keeps every member.
  They are what the card shows. The write is the core's merge, which moves every link the removed entry
  has when it runs.

Each also carries a human ``label`` for the approval UI.
"""

from collections import Counter
from typing import Any, Dict, List, Optional

from ..core import guidelines as _guidelines
from ..core import opkind as ok
from ..core.opkind import OpKind
from plaid_client import PlaidAPIError, metadata_ops, uuid7

from plaid_client.service import requester_message

from ..core.plan import (CLEAR_PROV, Minter, PlanError, PlanOutOfDate, Stamps,  # noqa: F401 - PlanError is re-exported
                         TrackingBatcher, apply_add_comment, apply_restore_document, applying,
                         check_reach, confirm_note, ConfirmRows, expand_ops)
from .project import is_virtual, virtual_morpheme_id
from .vocab import parent_of

# How a kind tags what it does to the shape of the text. RESHAPES is every
# kind tagged with one of these, so the four tools that reason about "does
# this plan already reshape that document" ask the registry rather than a
# list.
WORD_SHAPE = 'word_shape'        # a word's boundaries move
SENTENCE_SHAPE = 'sentence_shape'  # a sentence boundary moves
TEXT_SHAPE = 'text_shape'        # the baseline text itself is rewritten
ANALYSIS = 'analysis'            # a word's morpheme chain is replaced

# What the approval card places a change at, when it is not the document.
TOKEN = 'token'                  # a sentence, a word, a morpheme, or a value on one
ENTRY = 'entry'                  # a lexicon entry

# The passes of the executor, which is the whole list a kind may be staged
# for. IGT has one: everything it applies, it applies in the same loop. A kind
# declared for any other pass would be applied by none of them, so the plan
# refuses before the first batch opens (`core.opkind.check_applicable`).
STAGES = (ok.BATCH,)


# --- the executor's shared state -------------------------------------------------

class Context:
    """What one run of the executor carries between operations: the batcher,
    the provenance stamps, and the work each pass defers to the next."""

    def __init__(self, client, project, stamps: Stamps, counts: Counter, notes: List[str], b: TrackingBatcher):
        self.client = client
        self.project = project
        self.stamps = stamps
        self.stamp = stamps.stamp
        self.restamp = stamps.restamp
        self.counts = counts
        self.notes = notes
        self.b = b
        self.pending_links: List[tuple] = []   # ([token_id, ...], new_entry_key, document)
        # Each analysed word's new chain: the id of each of its morphemes, the
        # reused first one's or the one the plan creates. A link to a morpheme
        # the plan creates is written from it.
        self.chains: Dict[str, List[str]] = {}
        self.planned_links: List[Dict[str, Any]] = []
        # The id of each entry the plan creates, by its key.
        self.entry_ids: Dict[str, str] = {}
        self.respells: Dict[str, List[tuple]] = {}
        self.pending_deletes: List[Dict[str, Any]] = []  # delete_entry ops, once their links are gone
        self.pending_merges: List[tuple] = []  # (kept entry, entry merged into it), after the links
        # Ops with writes after the first pass, by the pass that ends them, so
        # each is finished (TrackingBatcher.finish) only once those stand.
        self.later: Dict[str, List[Dict[str, Any]]] = {}
        self.dead_tokens: set = set()          # tokens the plan certainly deletes
        self.text_edits: List[Dict[str, Any]] = []
        self.restores: List[Dict[str, Any]] = []
        self.new_docs: List[Dict[str, Any]] = []
        # Once per entity, whichever ops name it. The server accepts a
        # `bulk_delete` of ids that are already gone, but a SINGLE delete of
        # one 404s, and the batch it shares is atomic: an unlink beside the
        # word deletion that takes the same link, a cleared field beside the
        # discard that deletes the same span, a merge beside a delete of the
        # same entry. Each pair is a whole plan refused after approval.
        self.gone: set = set()
        # A contributor's approval of confirmations: pieces made their own
        # contribution, and another contributor's work left for a reviewer.
        self.confirm_accepted = 0
        self.confirm_left = 0
        self.confirm_rows = ConfirmRows()
        # The morpheme made for each unsegmented word's derived one, by the
        # derived id, so every write naming it names the one token.
        self.materialized: Dict[str, str] = {}
        # The morph type each analysed word's new chain gives each morpheme.
        self.chain_types: Dict[str, List[Optional[str]]] = {}

    def defer(self, op, when: str = 'second') -> None:
        self.later.setdefault(when, []).append(op)

    def deferred(self, op) -> bool:
        return any(o is op for ops in self.later.values() for o in ops)

    def drop(self, resource: str, entity_id) -> None:
        if not entity_id or (resource, entity_id) in self.gone:
            return
        self.gone.add((resource, entity_id))
        self.b.add(lambda batch, i=entity_id: getattr(batch, resource).delete(i))


# --- what each kind does -----------------------------------------------------------

def _token(ctx: Context, op, token_id: str, metadata: Optional[Dict[str, Any]] = None) -> str:
    """The token a write names: a stored one as it is, and the derived
    morpheme of an unsegmented word (``virtual:<word id>``) made first, in
    the write's own batch, as the editor makes it (``_planMorphemes``): the
    word's extent, first in its chain, with ``metadata`` (a form or a type
    the write gives it) and the plan's stamp. Made once, however many writes
    name it. ``op['virtual_at']`` is the word's extent, noted as the op was
    staged."""
    if not is_virtual(token_id):
        return token_id
    if token_id in ctx.materialized:
        return ctx.materialized[token_id]
    at = op.get('virtual_at')
    if not at:
        raise ValueError(f'{op.get("label") or op.get("kind")}: names the morpheme of an unsegmented word '
                         'without the word it is made on')
    made = ctx.materialized[token_id] = ctx.b.new_id()
    meta = {**(metadata or {}), **ctx.stamp()}
    ctx.b.add(lambda batch: batch.tokens.create(at['layer_id'], at['text_id'], at['begin'], at['end'],
                                                precedence=1, metadata=meta or None, id=made))
    return made


def _apply_set_span(ctx: Context, op) -> int:
    span_id, value = op.get('span_id'), op.get('value') or ''
    if span_id and value == '':
        ctx.drop('spans', span_id)
    elif span_id:
        ctx.b.update('spans', span_id, value=value, metadata=metadata_ops(ctx.restamp()))
    elif value != '':
        token = _token(ctx, op, op['token_id'])
        ctx.b.add(lambda batch, o=op, v=value: batch.spans.create(o['layer_id'], [token], v, ctx.stamp(),
                                                                  id=ctx.b.new_id()))
    else:
        return 0  # nothing to clear
    return 1


def _apply_set_analysis(ctx: Context, op) -> int:
    # An unsegmented word's derived morpheme is stored nowhere: the analysis
    # makes its whole chain.
    existing = [m for m in op.get('existing') or [] if not is_virtual(m.get('id'))]
    morphemes = op.get('morphemes') or []
    layer, text_id = op['morpheme_layer_id'], op['text_id']
    begin, end = op['begin'], op['end']
    b = ctx.b
    if existing:
        m0 = existing[0]
        for m in existing[1:]:
            ctx.drop('tokens', m['id'])  # cascades spans + links
        for sid in m0.get('span_ids') or []:
            ctx.drop('spans', sid)
        first = morphemes[0]
        slots = [m0['id']]
        b.add(lambda batch, mid=m0['id'], f=first: batch.tokens.patch_metadata(
            mid, metadata_ops({'form': f['form'], 'morphType': f.get('morph_type'), **ctx.restamp()})))
        # Keep the chain's numbering contiguous from 1 whatever the
        # first morpheme's precedence was before.
        b.add(lambda batch, mid=m0['id']: batch.tokens.update(mid, precedence=1))
        for fv in first.get('fields') or []:
            if fv.get('value') not in (None, ''):
                b.add(lambda batch, mid=m0['id'], fv=fv: batch.spans.create(
                    fv['layer_id'], [mid], fv['value'], ctx.stamp(), id=b.new_id()))
        rest = list(enumerate(morphemes))[1:]
    else:
        slots = []
        rest = list(enumerate(morphemes))
    for j, m in rest:
        meta = {'form': m['form'], **ctx.stamp()}
        if m.get('morph_type'):
            meta['morphType'] = m['morph_type']
        made = b.new_id()
        b.add(lambda batch, j=j, meta=meta, i=made: batch.tokens.create(
            layer, text_id, begin, end, precedence=j + 1, metadata=meta, id=i))
        slots.append(made)
        # Its glosses name it, in the same batch: the analysis is one change,
        # written whole or not at all.
        for fv in m.get('fields') or []:
            if fv.get('value') not in (None, ''):
                b.add(lambda batch, i=made, fv=fv: batch.spans.create(
                    fv['layer_id'], [i], fv['value'], ctx.stamp(), id=b.new_id()))
    ctx.chains[op['word_id']] = slots
    ctx.chain_types[op['word_id']] = [m.get('morph_type') for m in morphemes]
    return 1


def _apply_set_orthography(ctx: Context, op) -> int:
    ctx.b.update('tokens', op['word_id'], metadata=metadata_ops({op['key']: op.get('value') or None}))
    return 1


def _apply_respell(ctx: Context, op) -> int:
    ctx.respells.setdefault(op['text_id'], []).append((op['begin'], op['end'], op['value']))
    ctx.defer(op, f'respell:{op["text_id"]}')
    return 1


def _link_new_entry(ctx: Context, tokens: List[str], key: str) -> None:
    ctx.b.add(lambda batch, e=ctx.entry_ids[key], t=tokens: batch.vocab_links.create(
        e, t, ctx.stamp(), id=ctx.b.new_id()))


def _link(ctx: Context, op, tokens: List[str]) -> int:
    if op.get('existing_link_id'):
        ctx.drop('vocab_links', op['existing_link_id'])
    if op.get('item_id'):
        ctx.b.add(lambda batch, o=op, t=tokens: batch.vocab_links.create(o['item_id'], t, ctx.stamp(),
                                                                          id=ctx.b.new_id()))
    elif op.get('new_entry_key') in ctx.entry_ids:
        # The entry is an earlier change of the plan, named by its id.
        _link_new_entry(ctx, tokens, op['new_entry_key'])
    elif op.get('new_entry_key'):
        # A later one: written in the second pass, once it is queued.
        ctx.pending_links.append((tokens, op['new_entry_key'], ctx.b.document))
        ctx.defer(op)
    return 1


def _link_planned_morpheme(ctx: Context, op) -> None:
    """A link to a morpheme the plan's own analysis creates. The link it
    replaces (the kept first morpheme's) goes in the same batch, so a batch
    that fails leaves the stored link where it was."""
    slots = ctx.chains.get(op['analysis_word_id']) or []
    k = op['morpheme_index']
    if not 1 <= k <= len(slots):
        raise RuntimeError('a link names a morpheme its analysis did not create, so it was not written')
    entry = op.get('item_id') or ctx.entry_ids[op['new_entry_key']]
    ctx.drop('vocab_links', op.get('existing_link_id'))
    ctx.b.add(lambda batch, e=entry, m=slots[k - 1]: batch.vocab_links.create(
        e, [m], ctx.stamp(), id=ctx.b.new_id()))
    types = ctx.chain_types.get(op['analysis_word_id']) or []
    if op.get('morph_type') and (types[k - 1] if k <= len(types) else None) != op['morph_type']:
        _cache_morph_type(ctx, slots[k - 1], op['morph_type'])


def _cache_morph_type(ctx: Context, morpheme_id: str, morph_type: str) -> None:
    """The morpheme's cached type, written with the link that gives it, so
    nothing is left for a repair on the next open (``morph_type``, noted at
    staging)."""
    ctx.b.update('tokens', morpheme_id, metadata=metadata_ops({'morphType': morph_type}))


def _apply_link(ctx: Context, op) -> int:
    if op.get('analysis_word_id'):
        # A morpheme the plan's own analysis creates. Its analysis and the
        # entry it names are earlier changes: written now, naming their ids.
        # Otherwise in the second pass, once they are queued.
        if (op['analysis_word_id'] in ctx.chains
                and (op.get('item_id') or op.get('new_entry_key') in ctx.entry_ids)):
            _link_planned_morpheme(ctx, op)
        else:
            ctx.planned_links.append(op)
            ctx.defer(op)
        return 1
    t = op.get('morph_type')
    if is_virtual(op['token_id']) and op['token_id'] not in ctx.materialized:
        # Made with the type, as the editor's _planLinkMany makes it.
        return _link(ctx, op, [_token(ctx, op, op['token_id'], {'morphType': t} if t else None)])
    token = _token(ctx, op, op['token_id'])
    n = _link(ctx, op, [token])
    if t:
        _cache_morph_type(ctx, token, t)
    return n


def _apply_link_phrase(ctx: Context, op) -> int:
    return _link(ctx, op, list(op['token_ids']))


def _apply_unlink(ctx: Context, op) -> int:
    # A link on a token the plan deletes goes with the token (a morpheme a
    # word change or a new analysis deletes), and the server refuses a delete
    # of a link it no longer has. A multi-word expression's link goes only
    # with the last of its words.
    on = op.get('token_ids') or ([op['token_id_hint']] if op.get('token_id_hint') else [])
    if on and all(t in ctx.dead_tokens for t in on):
        return 1
    ctx.drop('vocab_links', op['link_id'])
    return 1


def _apply_set_morph_type(ctx: Context, op) -> int:
    # Only a direct correction stages one (set_morpheme), so it is stamped as
    # the editor's setMorphemeType stamps it: the approved type is reviewed
    # work, and a re-analysis without Overwrite leaves it alone.
    morph_type = op.get('morph_type') or None
    mid = op['morpheme_id']
    if is_virtual(mid) and mid not in ctx.materialized:
        _token(ctx, op, mid, {'morphType': morph_type} if morph_type else None)
        return 1
    ctx.b.update('tokens', _token(ctx, op, mid),
                 metadata=metadata_ops({'morphType': morph_type, **ctx.restamp()}))
    return 1


def _apply_create_entry(ctx: Context, op) -> int:
    made = ctx.entry_ids[op['key']] = ctx.b.new_id()
    ctx.b.add(lambda batch, o=op, i=made: batch.vocab_items.create(
        o['vocab_id'], o['form'], {**(o.get('metadata') or {}), **ctx.stamp()}, id=i))
    return 1


def _apply_set_entry_field(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, o=op: batch.vocab_items.patch_metadata(
        o['item_id'], metadata_ops({o['field']: o.get('value') or None})))
    return 1


def _apply_set_entry_metadata(ctx: Context, op) -> int:
    # A patch, so a null clears that key and the rest of the entry's metadata
    # is left alone.
    ctx.b.add(lambda batch, o=op: batch.vocab_items.patch_metadata(o['item_id'], metadata_ops(o['patch'])))
    return 1


def _apply_set_doc_metadata(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, o=op: batch.documents.patch_metadata(
        o['document_id'], metadata_ops({o['field']: o.get('value') or None})))
    return 1


def _apply_create_document(ctx: Context, op) -> int:
    ctx.new_docs.append(op)  # after the batches: several dependent calls
    ctx.defer(op, 'direct')
    return 1


def _apply_merge_entries(ctx: Context, op) -> int:
    # The core's merge, once the plan's own link changes are made: it moves
    # every link the removed entry has by then, one made since the plan was
    # read included, and deletes it. Moved one by one from the links the plan
    # read, a link made in between was deleted with the entry. The op's
    # `links` are what the card shows.
    ctx.pending_merges.append((op['keep_id'], op['remove_id']))
    ctx.defer(op)
    return 1


def _apply_delete_entry(ctx: Context, op) -> int:
    # The entry's delete takes every link to it along, so its links are not
    # deleted by id. One of them can be gone already: on a morpheme a new
    # analysis or a word change in the same batch deletes, which the server
    # takes with the morpheme and then refuses to delete again. The op still
    # lists them, for what the plan removes, and for the count the delete
    # claims (`_entry_links_now`).
    ctx.pending_deletes.append(op)
    ctx.defer(op)
    return 1


def _apply_rename_entry(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, o=op: batch.vocab_items.update(o['item_id'], o['form']))
    return 1


def _apply_rename_document(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, o=op: batch.documents.update(o['document_id'], o['name']))
    return 1


def _apply_set_morpheme_form(ctx: Context, op) -> int:
    # A respelling carried into a morpheme's form changes no analysis and is
    # not stamped, as in Bulk Edit. A direct correction of one morpheme
    # (``restamp``, set_morpheme) is, as the editor's updateMorphemeForm
    # stamps it.
    mid = op['morpheme_id']
    if is_virtual(mid) and mid not in ctx.materialized:
        _token(ctx, op, mid, {'form': op['form']})
        return 1
    stamp = ctx.restamp() if op.get('restamp') else {}
    ctx.b.update('tokens', _token(ctx, op, mid), metadata=metadata_ops({'form': op['form'], **stamp}))
    return 1


def _stored(ids) -> List[str]:
    """The morphemes among ``ids`` that are stored: an unsegmented word's
    derived one is named by the guards and deleted by no one."""
    return [i for i in ids or [] if not is_virtual(i)]


def _apply_split_word(ctx: Context, op) -> int:
    if _stored(op.get('morpheme_ids')):
        ctx.b.add(lambda batch, o=op: batch.tokens.bulk_delete(_stored(o['morpheme_ids'])))
    ctx.b.add(lambda batch, o=op: batch.tokens.split(o['word_id'], o['position'], id=ctx.b.new_id()))
    return 1


def _merge(ctx: Context, op, key: str, others: List[str]) -> int:
    if _stored(op.get('morpheme_ids')):
        ctx.b.add(lambda batch, o=op: batch.tokens.bulk_delete(_stored(o['morpheme_ids'])))
    # A multi-word expression made only of the merged words would sit on one
    # word after the merge, which is no expression: it goes first.
    for lid in op.get('mwe_ids') or []:
        ctx.drop('vocab_links', lid)
    # Sequential merges into the survivor: the server runs batch ops in order,
    # so each merge sees the widened extent. Nothing follows them: the layer
    # rules igt declares make the server join the values of the spans the
    # merge gathers on the survivor and drop the extra links, in the same
    # transaction (``spans`` and ``links`` are what the card says it does).
    for oid in others:
        ctx.b.add(lambda batch, o=op, x=oid, k=key: batch.tokens.merge(o[k], x))
    return 1


def _apply_merge_words(ctx: Context, op) -> int:
    return _merge(ctx, op, 'word_id', list(op['other_ids']))


def _apply_merge_sentences(ctx: Context, op) -> int:
    return _merge(ctx, op, 'sentence_id', [op['other_id']])


def _apply_delete_word(ctx: Context, op) -> int:
    # A multi-word expression the deletion would leave with one member goes
    # first. The server only trims links otherwise.
    for lid in op.get('link_ids') or []:
        ctx.drop('vocab_links', lid)
    ctx.drop('tokens', op['word_id'])  # cascades morphemes, spans, links
    return 1


def _apply_split_sentence(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, o=op: batch.tokens.split(o['sentence_id'], o['position'], id=ctx.b.new_id()))
    return 1


def _apply_edit_text(ctx: Context, op) -> int:
    ctx.text_edits.append(op)  # after the batches: several dependent calls
    ctx.defer(op, 'direct')
    return 1


def _apply_confirm(ctx: Context, op) -> int:
    # What each piece gets is the approver's to say (`Stamps.confirm`): a
    # contributor's approval makes a machine proposal their own contribution
    # and leaves a contributor's work (`contributed`, read as the plan was
    # made) for a reviewer.
    theirs = set(op.get('contributed') or [])
    written = 0

    def stamp_of(i):
        nonlocal written
        frag = ctx.stamps.confirm(i in theirs)
        if frag is None:
            ctx.confirm_left += 1
            return None
        written += 1
        if ctx.stamps.contributed:
            ctx.confirm_accepted += 1
        return frag

    for tid in op.get('token_ids') or []:
        frag = stamp_of(tid)
        if frag is not None:
            ctx.b.update('tokens', tid, metadata=metadata_ops(frag))
    for lid in op.get('link_ids') or []:
        frag = stamp_of(lid)
        if frag is not None:
            ctx.b.add(lambda batch, i=lid, f=frag: batch.vocab_links.patch_metadata(i, metadata_ops(f)))
    for sid in op.get('span_ids') or []:
        frag = stamp_of(sid)
        if frag is not None:
            ctx.b.update('spans', sid, metadata=metadata_ops(frag))
    ctx.confirm_rows.add(op, written)
    return written


def _apply_discard_analysis(ctx: Context, op) -> int:
    # The editor's discardWordAnalysis: machine links and spans go, machine
    # morphemes after the first go (their spans and links cascade
    # server-side, so they are not deleted separately), a machine first
    # morpheme is reset to the healed default, and survivors are renumbered
    # gap-free.
    for lid in op.get('link_ids') or []:
        ctx.drop('vocab_links', lid)
    for sid in op.get('span_ids') or []:
        ctx.drop('spans', sid)
    for mid in op.get('morpheme_ids') or []:
        ctx.drop('tokens', mid)
    if op.get('reset_first_id'):
        ctx.b.add(lambda batch, i=op['reset_first_id']: batch.tokens.patch_metadata(
            i, metadata_ops({'form': None, 'morphType': None, **CLEAR_PROV})))
    for r in op.get('renumber') or []:
        ctx.b.add(lambda batch, r=r: batch.tokens.update(r['id'], precedence=r['precedence']))
    return 1


# --- what each kind deletes ---------------------------------------------------------

def _set_span_deletes(op):
    return [op['span_id']] if op.get('span_id') and (op.get('value') or '') == '' else []


def _set_analysis_deletes(op):
    # The survivor's spans are deleted outright and the rest ride morphemes
    # that go with them. Both are gone by the end.
    return [sid for m in (op.get('existing') or []) for sid in (m.get('span_ids') or [])]


def _set_analysis_deletes_tokens(op):
    return [m['id'] for m in (op.get('existing') or [])[1:]]


def _merge_deletes(op):
    return ([sid for sp in (op.get('spans') or []) for sid in (sp.get('delete_ids') or [])]
            + list((op.get('links') or {}).get('delete_ids') or [])
            + list(op.get('mwe_ids') or []))


def _discard_analysis_deletes(op):
    return list(op.get('link_ids') or []) + list(op.get('span_ids') or [])


# --- what a kind writes to that no key of its own names ------------------------------

def _create_entry_writes(op):
    """A new sense hangs off the entry it is a sense of, which is named inside
    the metadata it carries rather than by a key of the op. A plan that deletes
    that entry would leave the sense hanging off an id that resolves to
    nothing."""
    return [parent_of({'metadata': op.get('metadata') or {}})]


def _sense_moved_under(op):
    """The entry a structure change puts a sense under, named inside the
    patch it writes."""
    return [parent_of({'metadata': op.get('patch') or {}})]


def _confirm_writes(op):
    """What a confirmation the model NAMED writes to: the ids it confirms, and
    the tokens they sit on, since a span or a link whose token is deleted goes
    with it without being named anywhere.

    A confirmation over a scope (a whole document, several documents) writes to
    nothing here: the model named none of this material, it stands for whatever
    in that document awaits review, and what the plan deletes is left out of it
    when the plan is applied."""
    if not op.get('named'):
        return []
    return ([i for key in ('span_ids', 'token_ids', 'link_ids') for i in (op.get(key) or [])]
            + list((op.get('on') or {}).values()))


# --- what each scope stands for ------------------------------------------------------
#
# A scope is stored as the tool and the arguments the model gave, and resolved
# to per-span ops at approval by the same function that previewed it. The kind
# declares its resolver beside everything else it declares, and
# `resolve_scopes` runs it without naming it.

class Resolution:
    """What the scopes of one plan resolve with: a workspace over the project
    the plan is being applied to, built once however many scopes it holds."""

    def __init__(self, client, project, requester=None):
        from .workspace import Workspace
        self.client = client
        self.project = project
        self.ws = Workspace(client, project)
        self.ws.requester_id = requester


def _resolve_bulk_scope(res: Resolution, op):
    from .bulk import CANDIDATE_MAX, SCOPED
    from ..core.tools import ToolError
    fn = SCOPED.get(op.get('tool'))
    if fn is None:
        raise ValueError(f'unknown corpus-wide tool {op.get("tool")!r}')
    try:
        found = fn(res.ws, dict(op.get('args') or {}), CANDIDATE_MAX)
        # Rebuilt now, outside add_op: held to the layers' lists as staged.
        for o in found:
            res.ws.refuse_off_list(o)
        return found
    except ToolError as e:
        raise ValueError(str(e)) from e


# --- the registry -------------------------------------------------------------------

def _bulk_scope_summary(op, n):
    # A stored replacement stands for `count` changes of several kinds. A kind
    # the registry does not know shows its identifier, as `ok.summarize` does
    # for an op of one: leaving a change out of the line the user approves is
    # worse than an ugly word in it.
    return [(KIND[k].noun if k in KIND else (k, k), int(v)) for k, v in (op.get('counts') or {}).items()]


KIND = ok.registry([
    # The project's annotation manual. Shared with the other app: a
    # guideline has the same shape whatever the project annotates.
    *_guidelines.kinds(OpKind),
    OpKind('set_span', ('field value', 'field values'), required=('layer_id', 'token_id'),
           apply=_apply_set_span, target=lambda op: ('span', op.get('layer_id'), op.get('token_id')),
           at=('token_id',), at_kind=TOKEN, token_keys=('token_id',), deletes=_set_span_deletes,
           compact_each=('token_id', 'span_id', 'value', 'doc', 'virtual_at')),
    OpKind('set_analysis', ('analysis', 'analyses'),
           required=('word_id', 'text_id', 'begin', 'end', 'morpheme_layer_id', 'morphemes'),
           apply=_apply_set_analysis, target=lambda op: ('analysis', op.get('word_id')),
           at=('word_id',), at_kind=TOKEN, token_keys=('word_id',), shape=ANALYSIS,
           deletes=_set_analysis_deletes, deletes_tokens=_set_analysis_deletes_tokens),
    OpKind('set_orthography', ('orthography value', 'orthography values'), required=('word_id', 'key'),
           apply=_apply_set_orthography, target=lambda op: ('orth', op.get('word_id'), op.get('key')),
           at=('word_id',), at_kind=TOKEN, token_keys=('word_id',),
           compact_each=('word_id', 'value', 'doc')),
    OpKind('respell', ('respelling', 'respellings'), required=('text_id', 'begin', 'end', 'value'),
           apply=_apply_respell, shape=TEXT_SHAPE,
           target=lambda op: ('respell', op.get('text_id'), op.get('begin'), op.get('end')),
           compact_each=('text_id', 'begin', 'end', 'value', 'doc')),
    # `token_id`, or a morpheme a planned analysis writes, named by its word
    # and place (`planned_morpheme`). validate_ops asks for one or the other.
    # The first morpheme of a word analysed before is the stored one the
    # analysis keeps, so a link to it by place and a link to it by id are one
    # target, and the later replaces the earlier.
    OpKind('link', ('lexicon link', 'lexicon links'),
           apply=_apply_link, target=lambda op: ('link', op.get('token_id') or op.get('reuses_morpheme_id') or (
               'planned', op.get('analysis_word_id'), op.get('morpheme_index'))),
           # The entry as well as the word: a link to an entry the plan removes
           # is written and then taken away with it.
           at=('token_id',), at_kind=TOKEN, token_keys=('token_id', 'analysis_word_id', 'item_id'),
           deletes=lambda op: [op.get('existing_link_id')], extra={'names_entry': ('item_id',)}),
    OpKind('unlink', ('unlink', 'unlinks'), required=('link_id',), apply=_apply_unlink,
           # A multi-word expression's link is its own target: unlinking it
           # never displaces a member word's own link.
           target=lambda op: (('mwe_link', op.get('link_id')) if op.get('token_ids')
                              else ('link', op.get('token_id_hint'))),
           at=('token_id_hint', 'token_ids'), at_kind=TOKEN, deletes=lambda op: [op['link_id']]),
    OpKind('link_phrase', ('multi-word expression', 'multi-word expressions'), required=('token_ids',),
           apply=_apply_link_phrase, target=lambda op: ('mwe', tuple(op.get('token_ids') or [])),
           at=('token_ids',), at_kind=TOKEN, token_keys=('token_ids', 'item_id'),
           deletes=lambda op: [op.get('existing_link_id')], extra={'names_entry': ('item_id',)}),
    OpKind('create_entry', ('new lexicon entry', 'new lexicon entries'), required=('vocab_id', 'form', 'key'),
           apply=_apply_create_entry, writes=_create_entry_writes, extra={'hangs_off': _create_entry_writes}),
    OpKind('set_entry_field', ('entry field', 'entry fields'), required=('item_id', 'field'),
           apply=_apply_set_entry_field, at=('item_id',), at_kind=ENTRY, token_keys=('item_id',),
           target=lambda op: ('entry_field', op.get('item_id'), op.get('field')),
           extra={'names_entry': ('item_id',)}),
    OpKind('set_entry_metadata', ('entry structure change', 'entry structure changes'),
           required=('item_id', 'patch'), apply=_apply_set_entry_metadata, at=('item_id',), at_kind=ENTRY,
           token_keys=('item_id',), extra={'names_entry': ('item_id',), 'hangs_off': _sense_moved_under},
           # Keyed by the keys it writes, so renumbering a sense and promoting
           # an example on one entry are two changes rather than one replacing
           # the other.
           target=lambda op: ('entry_meta', op.get('item_id'), tuple(sorted((op.get('patch') or {}).keys())))),
    OpKind('set_doc_metadata', ('document metadata value', 'document metadata values'),
           required=('document_id', 'field'), apply=_apply_set_doc_metadata,
           target=lambda op: ('doc_meta', op.get('document_id'), op.get('field'))),
    OpKind('create_document', ('new document', 'new documents'), required=('name', 'text'),
           apply=_apply_create_document, target=lambda op: ('create_document', op.get('name'))),
    OpKind('merge_entries', ('merged entry', 'merged entries'), required=('keep_id', 'remove_id'),
           apply=_apply_merge_entries, at=('keep_id',), at_kind=ENTRY,
           deletes=lambda op: [op['remove_id']] + [l['link_id'] for l in op.get('links') or []],
           extra={'removes_entry': ('remove_id',), 'names_entry': ('keep_id', 'remove_id')}),
    OpKind('delete_entry', ('deleted entry', 'deleted entries'), required=('item_id',),
           apply=_apply_delete_entry, at=('item_id',), at_kind=ENTRY,
           target=lambda op: ('delete_entry', op.get('item_id')),
           deletes=lambda op: [op['item_id']] + list(op.get('links') or []),
           extra={'removes_entry': ('item_id',), 'names_entry': ('item_id',)}),
    OpKind('rename_entry', ('renamed entry', 'renamed entries'), required=('item_id', 'form'),
           apply=_apply_rename_entry, at=('item_id',), at_kind=ENTRY, token_keys=('item_id',),
           target=lambda op: ('rename_entry', op.get('item_id')),
           compact_each=('item_id', 'form'), extra={'names_entry': ('item_id',)}),
    OpKind('rename_document', ('renamed document', 'renamed documents'), required=('document_id', 'name'),
           apply=_apply_rename_document, target=lambda op: ('rename_document', op.get('document_id'))),
    # A confirmation the model NAMED (refs) is a write to what it names, and a
    # change deleting any of it is refused in both orders like every other
    # named write. One over a scope names nothing of its own, so it keeps no
    # token keys: it is resolved when the plan is applied, leaving out what the
    # plan deletes, and the applied message says how many it left out.
    OpKind('confirm', ('confirmation', 'confirmations'), apply=_apply_confirm, writes=_confirm_writes,
           # The exact material it confirms. Confirming the same thing twice
           # in a turn (the model retrying, two tools reaching the same
           # document) used to stage two ops, and the reply counted both, so
           # the card promised twice the confirmations it would make. Two
           # confirmations that cover DIFFERENT material have different id
           # lists and both stand.
           target=lambda op: ('confirm', op.get('doc'), tuple(op.get('span_ids') or []),
                              tuple(op.get('token_ids') or []), tuple(op.get('link_ids') or []))),
    OpKind('discard_analysis', ('discarded analysis', 'discarded analyses'), required=('word_id',),
           apply=_apply_discard_analysis, target=lambda op: ('analysis', op.get('word_id')),
           at=('word_id',), at_kind=TOKEN, token_keys=('word_id',), shape=ANALYSIS,
           deletes=_discard_analysis_deletes, deletes_tokens=lambda op: list(op.get('morpheme_ids') or [])),
    OpKind('set_morpheme_form', ('morpheme form', 'morpheme forms'), required=('morpheme_id', 'form'),
           apply=_apply_set_morpheme_form, target=lambda op: ('morph_form', op.get('morpheme_id')),
           at=('morpheme_id',), at_kind=TOKEN, token_keys=('morpheme_id',),
           compact_each=('morpheme_id', 'form', 'doc', 'virtual_at')),
    OpKind('set_morph_type', ('morpheme type', 'morpheme types'), required=('morpheme_id',),
           apply=_apply_set_morph_type, target=lambda op: ('morph_type', op.get('morpheme_id')),
           at=('morpheme_id',), at_kind=TOKEN, token_keys=('morpheme_id',)),
    OpKind('split_word', ('split word', 'split words'), required=('word_id', 'position'),
           apply=_apply_split_word, target=lambda op: ('word_shape', op.get('word_id')),
           at=('word_id',), at_kind=TOKEN, token_keys=('word_id',), shape=WORD_SHAPE,
           deletes_tokens=lambda op: list(op.get('morpheme_ids') or []),
           extra={'bulk_deleted': ('morpheme_ids',), 'reshapes': ('word_id',)}),
    OpKind('merge_words', ('word merge', 'word merges'), required=('word_id', 'other_ids'),
           apply=_apply_merge_words, target=lambda op: ('word_shape', op.get('word_id')),
           shape=WORD_SHAPE, deletes=_merge_deletes,
           deletes_tokens=lambda op: list(op.get('morpheme_ids') or []) + list(op.get('other_ids') or []),
           extra={'bulk_deleted': ('morpheme_ids',), 'reshapes': ('word_id', 'other_ids'), 'merge': True}),
    OpKind('delete_word', ('deleted word', 'deleted words'), required=('word_id',),
           apply=_apply_delete_word, target=lambda op: ('word_shape', op.get('word_id')),
           at=('word_id',), at_kind=TOKEN, shape=WORD_SHAPE,
           deletes=lambda op: list(op.get('link_ids') or []),
           deletes_tokens=lambda op: list(op.get('morpheme_ids') or []) + [op['word_id']],
           extra={'bulk_deleted': ('morpheme_ids',), 'reshapes': ('word_id',)}),
    OpKind('split_sentence', ('split sentence', 'split sentences'), required=('sentence_id', 'position'),
           apply=_apply_split_sentence, target=lambda op: ('sentence_shape', op.get('sentence_id')),
           at=('sentence_id',), at_kind=TOKEN, token_keys=('sentence_id',), shape=SENTENCE_SHAPE,
           extra={'reshapes': ('sentence_id',)}),
    OpKind('merge_sentences', ('sentence merge', 'sentence merges'), required=('sentence_id', 'other_id'),
           apply=_apply_merge_sentences, target=lambda op: ('sentence_shape', op.get('sentence_id')),
           at=('sentence_id',), at_kind=TOKEN, shape=SENTENCE_SHAPE, deletes=_merge_deletes,
           deletes_tokens=lambda op: [op['other_id']],
           extra={'reshapes': ('sentence_id', 'other_id'), 'merge': True}),
    # The only kind whose deletions are a GUESS: the server diffs the text, so
    # a word the edit names may survive with its analysis intact. Every guard
    # treats the ids as gone, but a change naming one is dropped when the plan
    # is applied rather than refused as it is built.
    OpKind('edit_text', ('text edit', 'text edits'), required=('document_id', 'begin', 'end', 'new'),
           apply=_apply_edit_text, at=('sentence_id',), at_kind=TOKEN, shape=TEXT_SHAPE,
           target=lambda op: ('edit_text', op.get('text_id'), op.get('begin'), op.get('end')),
           deletes_tokens=lambda op: list(op.get('word_ids') or []) + list(op.get('morpheme_ids') or []),
           # Only the sentence: the WORDS a text edit names are a guess, so a
           # split or a merge of one is dropped at approval rather than refused
           # here (see `certain`).
           certain=False, extra={'reshapes': ('sentence_id',)}),
    OpKind('add_comment', ('comment', 'comments'), required=('entity_type', 'entity_id', 'body'),
           apply=apply_add_comment, at=('entity_id',), at_kind=TOKEN, token_keys=('entity_id',)),
    OpKind('restore_document', ('document restore', 'document restores'), required=('document_id', 'as_of'),
           apply=apply_restore_document, shape=ok.EXCLUSIVE,
           target=lambda op: ('restore', op.get('document_id'))),
    # Resolved to the ops it stands for at approval, so the executor never
    # sees one. The summary counts what it stands for.
    OpKind('bulk_scope', ('corpus-wide change', 'corpus-wide changes'), required=('tool', 'args', 'counts'),
           stage=ok.RESOLVED, shape=ok.SCOPE, resolve=_resolve_bulk_scope,
           summary=_bulk_scope_summary),
])

# Every table below is the registry read a different way. None of them is
# maintained beside it.
# The kinds that move a word's boundaries, a sentence boundary, the baseline
# text, or a morpheme chain. Nothing corpus-wide may share a plan with one.
RESHAPES = ok.shaped(KIND, WORD_SHAPE, SENTENCE_SHAPE, TEXT_SHAPE, ANALYSIS)
# Kinds resolved to the ops they stand for at approval, and kinds that own
# their whole plan. A scope is a kind that says how to resolve itself, and an
# exclusive kind is the registry's tag, so a second one of either joins by
# being declared.
SCOPES = ok.scopes(KIND)
EXCLUSIVE_KINDS = ok.shaped(KIND, ok.EXCLUSIVE)
# The kinds that write to a morpheme by id, so a plan that rewrites the chain
# those morphemes belong to knows which of its other ops are now moot.
MORPHEME_KEY = 'morpheme_id'
MORPHEME_WRITERS = tuple(name for name, keys in ok.token_keys(KIND).items() if MORPHEME_KEY in keys)


def reshaped_subjects(ops: List[Dict[str, Any]], *shapes: str, merges_only: bool = False) -> set:
    """The words and sentences the plan's shape ops re-cut, by the keys each
    kind declares (``extra['reshapes']``).

    ``shapes`` narrows it to kinds of one shape; ``merges_only`` to the kinds
    that fold two things into one. Both are the registry's own tags, so a new
    shape kind joins every rule built on this by being declared rather than by
    being added to a list beside each of them.
    """
    out: set = set()
    for op in ops:
        spec = KIND.get(op.get('kind'))
        if spec is None or (shapes and spec.shape not in shapes):
            continue
        if merges_only and not spec.extra.get('merge'):
            continue
        for key in spec.extra.get('reshapes') or ():
            value = op.get(key)
            out.update(value if isinstance(value, (list, tuple)) else ([value] if value else []))
    return out


def removed_entries(ops: List[Dict[str, Any]]) -> frozenset:
    """Lexicon entries the plan deletes or merges away. One reader, because
    the tools refuse a write to one of these and the executor refuses a merge
    into one, and the two have to mean the same set."""
    out: set = set()
    for op in ops:
        spec = KIND.get(op.get('kind'))
        for key in ((spec.extra.get('removes_entry') if spec else None) or ()):
            if op.get(key):
                out.add(op[key])
    return frozenset(out)


def named_entries(ops: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """The stored lexicon entries the plan's changes name (a link's entry,
    both entries of a merge, an entry whose field, structure or headword a
    change sets, one it deletes, one a new or moved sense hangs off), each
    with the first change naming it. An entry the plan creates is named by
    its key and is never here. The keys are each kind's own
    (``extra['names_entry']``), and the entry a sense hangs off is named in
    the metadata it writes (``extra['hangs_off']``)."""
    created = {op.get('key') for op in ops if op.get('kind') == 'create_entry'} - {None}
    out: Dict[str, Dict[str, Any]] = {}
    for op in ops:
        spec = KIND.get(op.get('kind'))
        if spec is None:
            continue
        named = [op.get(key) for key in (spec.extra.get('names_entry') or ())]
        named += list((spec.extra['hangs_off'](op) if 'hangs_off' in spec.extra else None) or [])
        for iid in named:
            if iid and iid not in created:
                out.setdefault(iid, op)
    return out


def _entry_named(op: Dict[str, Any]) -> str:
    """An entry the way a refusal names it: its headword as the plan read it,
    or, for a change that does not carry one, the change the user saw."""
    if op.get('entry_form'):
        return f'the lexicon entry "{op["entry_form"]}"'
    return f'a lexicon entry this plan names ("{op.get("label") or op.get("kind")}")'


#: Up to this many entries a plan names are read one by one at approval. Past
#: it, each lexicon of the project is read once, whole: a respelling carried
#: into the headwords names every entry it renames, and one read each cost
#: about 6 ms against a core on the same machine (20 s for 3000), with every
#: document of the plan held locked meanwhile.
ENTRY_READS_ONE_BY_ONE = 20


def _gone(op: Dict[str, Any], by_lexicon: bool = False) -> str:
    if by_lexicon:
        return (f"{_entry_named(op)} no longer exists in this project's lexicons (deleted, merged away or its "
                'lexicon taken out of the project since the plan was made)')
    return f'{_entry_named(op)} no longer exists (deleted or merged away since the plan was made)'


def check_entries(client, ops: List[Dict[str, Any]], project=None) -> None:
    """Refuse the plan, before anything is written, when an entry it names is
    gone from the server.

    An entry deleted or merged away since the plan was made, where no
    document the plan pins links it, moved no version the staleness check
    reads. A link to it failed its batch: the second one, for a link to a
    morpheme the plan's own analysis creates, after the analysis had been
    written.

    A few entries are read by id. The server answers an id it no longer has
    with a 404 to an administrator, and with a 403 to anyone else and to any
    delegated token, which is also its answer for an entry in a lexicon the
    reader cannot reach. So a 403 is settled by the project's lexicons
    (``project.vocabs``): an entry none of them holds is gone, and a lexicon
    that cannot be read is a failure to read, never a deletion. Many entries
    are settled by those lexicons directly, one read each. Without a project
    a 403 counts as gone."""
    named = named_entries(ops)
    if not named:
        return
    vocab_ids = [v['id'] for v in (getattr(project, 'vocabs', None) or []) if v.get('id')]
    reasons = []
    unsure: Dict[str, Dict[str, Any]] = {}
    if vocab_ids and len(named) > ENTRY_READS_ONE_BY_ONE:
        unsure = dict(named)
    else:
        for item_id, op in named.items():
            try:
                client.vocab_items.get(item_id)
            except Exception as e:  # noqa: BLE001 - gone or unreadable: the plan cannot apply
                status = getattr(e, 'status', None)
                if status == 404 or (status == 403 and not vocab_ids):
                    reasons.append(_gone(op))
                elif status == 403:
                    unsure[item_id] = op
                else:
                    reasons.append(f'{_entry_named(op)} could not be read ({requester_message(e)})')
    if unsure:
        held = set()
        for vid in vocab_ids:
            try:
                layer = client.vocab_layers.get(vid, include_items=True)
            except Exception as e:  # noqa: BLE001 - the entries cannot be checked: the plan cannot apply
                name = next((v.get('name') for v in project.vocabs if v.get('id') == vid), None)
                where = f'the lexicon "{name}"' if name else 'a lexicon of this project'
                raise PlanOutOfDate(reasons + [f'{where} could not be read to check the entries this plan names '
                                               f'({requester_message(e)})']) from e
            held.update(it.get('id') for it in layer.get('items') or [])
        reasons.extend(_gone(op, by_lexicon=True) for item_id, op in unsure.items() if item_id not in held)
    if reasons:
        raise PlanOutOfDate(reasons)


def move_phrase(n: int) -> str:
    """How a merge's label counts the links it moves."""
    return f'move {n} link{"s" if n != 1 else ""}'


def settle_merges(ops: List[Dict[str, Any]]) -> tuple:
    """Each merge with the moves another change in the plan takes out of its
    hands, and what was taken: ``(ops, [(merge, link, taker)])``.

    A merge moves every link of the entry it removes onto the one it keeps,
    by the ids it read. A link the plan also replaces (a link of the same
    word or morpheme to another entry), unlinks or deletes belongs to that
    change: moving it as well wrote a second link on the word or morpheme,
    or undid the unlink. A link on a token the plan deletes (a morpheme a new
    analysis replaces) has nothing to be moved onto, and a multi-word
    expression keeps the members that stay.

    Worked out from the plan as it stands, so dropping the change that took a
    link gives the merge its move back. The staged op keeps every link it
    read, and the card and the executor read what this leaves."""
    out: List[Dict[str, Any]] = []
    taken_from: List[tuple] = []
    for i, op in enumerate(ops):
        if op.get('kind') != 'merge_entries' or not op.get('links'):
            out.append(op)
            continue
        # The other changes, less one removing the same entry (a delete of
        # it, which `normalize_ops` drops beside the merge).
        others = [o for j, o in enumerate(ops) if j != i and op.get('remove_id') not in removed_entries([o])]
        gone = ok.removed_ids(KIND, others, only_certain=True)
        moves = []
        for link in op['links']:
            tokens = list(link.get('token_ids') or [])
            kept = [t for t in tokens if t not in gone]
            if link.get('link_id') in gone or (kept != tokens and (len(tokens) == 1 or len(kept) < 2)):
                taker = next((o for o in others if {link.get('link_id'), *tokens}
                              & ok.removed_ids(KIND, [o], only_certain=True)), None)
                taken_from.append((op, link, taker))
            else:
                moves.append(link if kept == tokens else {**link, 'token_ids': kept})
        if len(moves) != len(op['links']):
            label = op.get('label') or ''
            at = label.rfind(move_phrase(len(op['links'])))
            if at >= 0:
                label = label[:at] + move_phrase(len(moves)) + label[at + len(move_phrase(len(op['links']))):]
            op = {**op, 'links': moves, 'label': label}
        out.append(op)
    return out, taken_from


def refuse_two_links(ops: List[Dict[str, Any]]) -> None:
    """Refuse a plan that would write two own links on one word or morpheme,
    whichever changes they come from (links, and the links a merge moves). A
    multi-word expression is a link of its own and never counts."""
    seen: Dict[Any, Dict[str, Any]] = {}
    for op in ops:
        if op.get('kind') == 'link':
            keys = [KIND['link'].target(op)]
        elif op.get('kind') == 'merge_entries':
            keys = [('link', l['token_ids'][0]) for l in op.get('links') or [] if len(l.get('token_ids') or []) == 1]
        else:
            continue
        for key in keys:
            if key in seen:
                raise ValueError(f'{op.get("label") or op["kind"]} and {seen[key].get("label") or seen[key]["kind"]} '
                                 'would write two lexicon links on one word or morpheme')
            seen[key] = op


def analysed_morphemes(ops: List[Dict[str, Any]]) -> set:
    """The morphemes the plan's analyses rewrite: an analysis keeps the first
    of its word's stored chain, with the values and type it gives it, and
    deletes the rest. Of a word nobody had segmented, it replaces the derived
    morpheme (``virtual:<word id>``). A change of its own to any of them is
    moot."""
    out = set()
    for op in ops:
        if op.get('kind') != 'set_analysis':
            continue
        existing = op.get('existing') or []
        out.update(m.get('id') for m in existing)
        if not existing and op.get('word_id'):
            out.add(virtual_morpheme_id(op['word_id']))
    return out - {None}


def planned_morpheme(ops: List[Dict[str, Any]], link: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The morpheme a link names by its word and place, in the analysis
    ``ops`` plan for that word, or None when they plan none, or none with a
    morpheme there spelt as the link read it. The spelling is the check that
    the analysis is still the one the link was made against: a later analysis
    of the same word replaces the first, and its second morpheme may be
    another morpheme altogether."""
    k = link.get('morpheme_index')
    if not isinstance(k, int) or isinstance(k, bool) or k < 1:
        return None
    for op in ops:
        if op.get('kind') == 'set_analysis' and op.get('word_id') == link.get('analysis_word_id'):
            chain = op.get('morphemes') or []
            if not (k <= len(chain) and chain[k - 1].get('form') == link.get('morpheme_form')):
                return None
            # At the first place, the stored morpheme the analysis keeps is the
            # one the link replaces the link of, so it must be the one the
            # link was made against.
            kept = ((op.get('existing') or [{}])[0] or {}).get('id') if k == 1 else None
            return chain[k - 1] if link.get('reuses_morpheme_id') == kept else None
    return None


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    reach = {d for op in ops if op.get('kind') in SCOPES for d in (op.get('documents') or [])}
    if reach:
        for op in ops:
            if op.get('kind') in RESHAPES and (not op.get('doc') or op['doc'] in reach):
                raise ValueError('this plan holds a corpus-wide change and reshapes a document it reaches; '
                                 'the two would meet for the first time in the batch')
    # A link to an entry the plan creates is written once that entry has an
    # id, in the executor's second pass, so one naming no entry of the plan
    # would fail there with the first batch already written.
    new_keys = {op.get('key') for op in ops if op.get('kind') == 'create_entry'}
    for i, op in enumerate(ops):
        spec = ok.kind_of(KIND, op, index=i + 1)
        kind = spec.name
        for k in spec.required:
            if op.get(k) in (None, '') and not (k in ('begin', 'end') and op.get(k) == 0):
                raise ValueError(f'op {i + 1} ({kind}): missing {k}')
        if kind == 'set_analysis' and (not isinstance(op['morphemes'], list) or not op['morphemes']
                                       or any(not (m.get('form') or '').strip() for m in op['morphemes'])):
            raise ValueError(f'op {i + 1} (set_analysis): morphemes must be a non-empty list with non-empty forms')
        if kind == 'link' and not op.get('token_id'):
            if not op.get('analysis_word_id'):
                raise ValueError(f'op {i + 1} (link): missing token_id')
            if planned_morpheme(ops, op) is None:
                raise ValueError(f'op {i + 1} (link): names morpheme {op.get("morpheme_index")} of an analysis '
                                 'this plan does not hold')
        if kind in ('link', 'link_phrase') and not (op.get('item_id') or op.get('new_entry_key')):
            raise ValueError(f'op {i + 1} ({kind}): needs item_id or new_entry_key')
        if kind in ('link', 'link_phrase') and not op.get('item_id') and op.get('new_entry_key') not in new_keys:
            raise ValueError(f'op {i + 1} ({kind}): links to an entry this plan does not create')
        if kind == 'link_phrase' and (not isinstance(op['token_ids'], list) or len(op['token_ids']) < 2):
            raise ValueError(f'op {i + 1} (link_phrase): token_ids must list two or more words')
        if kind == 'confirm' and not any(op.get(k) for k in ('span_ids', 'token_ids', 'link_ids')):
            raise ValueError(f'op {i + 1} (confirm): nothing to confirm')
        if kind == 'merge_words' and not isinstance(op['other_ids'], list):
            raise ValueError(f'op {i + 1} (merge_words): other_ids must be a list')
        if kind == 'edit_text' and not (op['new'] or '').strip():
            raise ValueError(f'op {i + 1} (edit_text): the new text is empty')
        if spec.shape == ok.EXCLUSIVE and len(ops) > 1:
            raise ValueError(f'op {i + 1} ({kind}): a {spec.noun[0]} must be the only op in its plan')


def _bulk_gone(ops) -> set:
    """Tokens that go without a `delete` call of their own: taken by a
    `bulk_delete`, or cascaded by the delete of the word above them. A single
    delete of one 404s and the batch it shares is atomic, while the bulk
    tolerates ids already gone, so the single delete is the one to skip."""
    out = set()
    for op in ops:
        spec = KIND.get(op.get('kind'))
        for key in ((spec.extra.get('bulk_deleted') if spec else None) or ()):
            out.update(op.get(key) or [])
    return out


def _dead_tokens(ops) -> set:
    """Tokens (words and morphemes) the plan deletes.

    An analysis op removes morphemes too. Nothing else in the plan may
    annotate or confirm one of those: the patch lands after the delete in the
    same atomic batch and takes the whole plan down with it."""
    return ok.removed_tokens(KIND, ops)


def _doomed_ids(ops) -> set:
    """Ids other ops in the plan delete, which a confirm must not touch (a
    patch of a deleted entity fails the whole batch)."""
    return ok.removed_ids(KIND, ops)


def normalize_ops(ops: List[Dict[str, Any]]) -> tuple:
    """Resolve interactions between ops in one plan: drop links to entries the
    plan deletes or merges away, refuse a merge whose survivor is removed by
    another op, dedupe entry deletes, collapse repeated respells of one range
    (last wins) and refuse overlapping ones. Returns (ops, notes)."""
    notes: List[str] = []
    removed = removed_entries(ops)
    # Morphemes another op rewrites wholesale (set_analysis replaces the chain,
    # discard_analysis deletes or resets it): a form patch on them is moot.
    rewritten = set(analysed_morphemes(ops))
    for op in ops:
        if op.get('kind') == 'discard_analysis':
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
    analysed = analysed_morphemes(ops)
    certainly_doomed = ok.doomed_writes(KIND, ops)
    maybe_doomed = ok.doomed_writes(KIND, ops, only_certain=False)
    for op, certain, maybe in zip(ops, certainly_doomed, maybe_doomed):
        k = op.get('kind')
        # What this op writes to and the OTHER ops delete: the word a change
        # sits on, the entry a link points at, the span a comment is anchored
        # to, the material a confirmation the model NAMED confirms.
        # `ok.doomed_writes` is the one home of that rule, shared with ud and
        # umr, and it leaves out what this op itself removes.
        #
        # A CERTAIN delete is refused as the plan is built, in both orders, so
        # a card never promises a change that will not happen. Reaching here
        # with one means the plan was built some way the staging guard does not
        # cover, and refusing the whole plan says so rather than applying most
        # of it.
        if certain:
            raise ValueError(f'{op.get("label") or k}: what it names is deleted or merged away by '
                             'another change in this plan')
        # A text edit's word ids are a GUESS (the server diffs the text and
        # may keep the word), so the op is dropped rather than refused: it
        # is moot if the word goes, and the plan was already approved. A
        # confirmation covers several things and keeps the ones that survive,
        # below.
        if maybe and k != 'confirm':
            notes.append(f'dropped: {op.get("label") or k} '
                         '(what it names is deleted or merged away in this plan)')
            continue
        # `.get`: the set of kinds is the registry's now, so this reads an op
        # of whatever kind declares the key rather than the two that were
        # named here, and one missing it is a plan refused by `validate_ops`
        # rather than a KeyError from three steps further on.
        if k in MORPHEME_WRITERS and op.get(MORPHEME_KEY) in rewritten:
            notes.append(f'dropped: {op.get("label") or "a morpheme change"} (that analysis is rewritten in this plan)')
            continue
        # A value on a morpheme an analysis rewrites: the analysis deletes the
        # spans the value was read from and writes its own. The tools never
        # stage one (the planned analysis takes the value), so this is a plan
        # built some other way, and the analysis's value is the one written.
        if k == 'set_span' and op.get('token_id') in analysed:
            notes.append(f'dropped: {op.get("label") or "a field value"} (that analysis is rewritten in this plan)')
            continue
        if k == 'confirm' and (doomed or dead):
            # A confirmation over a scope stands for the material awaiting
            # review in a document, which the model never named: what the plan
            # deletes is left out of it here, and the note says how much. One
            # the model DID name reaches this only for a text edit's guess,
            # since a certain delete refuses above.
            # `on` says which token each span and link sits on, because a span
            # whose token is deleted is gone without ever being named.
            on = op.get('on') or {}
            kept = {key: [i for i in (op.get(key) or [])
                          if i not in doomed and on.get(i) not in dead]
                    for key in ('span_ids', 'token_ids', 'link_ids')}
            left_out = sum(len(op.get(key) or []) - len(kept[key]) for key in kept)
            op = {**op, **kept}
            if not any(op[key] for key in ('span_ids', 'token_ids', 'link_ids')):
                notes.append(f'dropped: {op.get("label") or "a confirmation"} (everything it confirms is deleted in this plan)')
                continue
            if left_out:
                notes.append(f'{op.get("label") or "a confirmation"}: {left_out} '
                             f'annotation{"s" if left_out != 1 else ""} left unconfirmed '
                             '(deleted in this plan)')
        if k == 'delete_entry':
            if op['item_id'] in seen_delete:
                continue
            seen_delete.add(op['item_id'])
            if any(o.get('kind') == 'merge_entries' and o['remove_id'] == op['item_id'] for o in ops):
                notes.append(f'dropped: {op.get("label") or "an entry delete"} '
                             '(a merge in this plan already removes that entry)')
                continue
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
    # A link to a morpheme of an analysis dropped above has nothing to be
    # written on. Dropped with it, since the second pass would fail with the
    # first batch already written.
    kept = []
    for op in out:
        if op.get('kind') == 'link' and op.get('analysis_word_id') and planned_morpheme(out, op) is None:
            notes.append(f'dropped: {op.get("label") or "a link"} (the analysis it links a morpheme of was dropped)')
            continue
        kept.append(op)
    # A merge leaves the links the rest of the plan takes (see settle_merges).
    # The card already shows what it leaves, so this finds nothing more for a
    # plan the tools built, and one built some other way is settled here.
    kept, taken = settle_merges(kept)
    for merge, _link_, taker in taken:
        notes.append(f'{merge.get("label") or "a merge"}: leaves a link to another change in this plan'
                     + (f' ({taker["label"]})' if taker and taker.get('label') else '')
                     + ', which replaces or removes it')
    refuse_two_links(kept)
    return kept, notes


def execute_plan(client, ops: List[Dict[str, Any]], *, source: str, label: str, project=None,
                 stamp_mode: str = 'verified', contributor: str = None,
                 requester: Optional[str] = None, detail: Optional[Dict[str, Any]] = None,
                 seed: Optional[str] = None) -> Dict[str, int]:
    """Apply ``ops`` with ``client`` under one operation labelled ``label``.
    Returns per-kind counts of what was applied (plus ``notes`` for anything
    dropped). ``project`` (an IgtProject) is needed only by document-creating
    ops. ``stamp_mode`` is ``'verified'`` (machine-made, human-confirmed: the
    default), ``'human'`` (no provenance keys at all) or ``'contributed'``
    (the approver's own unreviewed work; needs ``contributor``, their user
    id). ``requester`` is the user the plan acts for: a corpus-wide change
    worked out again here leaves out what that user may not change, as its
    preview did. Raises :class:`PlanError` with the applied count if a later
    batch fails: batches are atomic individually, the plan as a whole is not.
    ``detail`` is what the writes' provDetail names (see :class:`Stamps`).
    ``seed`` is the plan's id: every row the plan creates is named by an id
    drawn from it (:class:`Minter`), so applying the same plan again names
    the same rows. Without one they are drawn from a fresh id."""
    stamps = Stamps(stamp_mode, source, contributor, detail)
    ids = Minter(seed or uuid7())
    ops = expand_ops(ops)
    validate_ops(ops)
    ops = resolve_scopes(client, project, ops, requester)
    ops, notes = normalize_ops(ops)
    check_entries(client, ops, project)
    counts: Counter = Counter()
    return applying(ops, lambda tracker: _execute(client, ops, label=label, project=project,
                                                  counts=counts, notes=notes, stamps=stamps,
                                                  tracker=tracker, ids=ids))


def resolve_scopes(client, project, ops: List[Dict[str, Any]],
                   requester: Optional[str] = None) -> List[Dict[str, Any]]:
    """The per-span ops a stored corpus-wide change stands for, computed
    again NOW by the same function that previewed it. Approval has already
    refused the plan if a matched document moved since, so what is found
    here is what was counted.

    Each scope kind declares its own resolver and this dispatches on that, so
    a kind added later is resolved without being named here."""
    if not any(ok.resolver(KIND, op) for op in ops):
        return ops
    if project is None:
        raise ValueError('a corpus-wide change needs the project to read the corpus with')
    from .workspace import op_target
    # A change the model made by name beats one a scope finds at approval,
    # whichever came first (the scope previewed stored values, not planned).
    explicit = {op_target(op) for op in ops if not ok.resolver(KIND, op)} - {None}
    # The documents a scope reaches now must be the ones it was pinned to,
    # checked and locked by: `check_reach` refuses the plan otherwise.
    return ok.resolve_ops(KIND, Resolution(client, project, requester), ops,
                          lambda o: op_target(o) not in explicit,
                          check=lambda op, found: check_reach(op, found, lambda o: o.get('doc')))


def _execute(client, ops, *, label, project, counts, notes, stamps: Stamps, tracker=None,
             ids: Optional[Minter] = None) -> Dict[str, int]:
    # An unknown kind, one that should have been resolved away, or one staged
    # for a pass this executor does not run refuses before the first batch
    # opens rather than being written as nothing under a label saying it was
    # applied.
    ok.check_applicable(KIND, ops, STAGES)
    with client.operation(label):
        ctx = Context(client, project, stamps, counts, notes, TrackingBatcher(client, tracker=tracker, ids=ids))
        b = ctx.b
        b.expect(ops)
        # Seeded with what goes without a delete call of its own, so a single
        # delete naming the same id is never issued beside it.
        for _tid in _bulk_gone(ops):
            ctx.gone.add(('tokens', _tid))
        # Certainly: a text edit's token deletes are a guess, and an unlink
        # skipped on a guess would leave the link.
        ctx.dead_tokens = ok.removed_tokens(KIND, ops, only_certain=True)

        for op in ops:
            spec = KIND[op['kind']]
            # Its writes carry the version of the document it is for, when
            # the plan holds several (core.plan.Batcher.writing_for).
            with b.writing_for(op):
                n = spec.apply(ctx, op)
            n = 1 if n is None else n
            # An applier that wrote nothing (clearing a value that was not
            # there) adds no key. A zero-valued one reaches the user as
            # "0 field values" on the applied card.
            if n:
                counts[spec.noun[1]] += n
            if not ctx.deferred(op) and not any(op is r for r in ctx.restores):
                b.finish(op)

        # A delete_entry reads the entry's links once the plan's own changes
        # stand (`_entry_links_now`), so they land first. Otherwise the whole
        # plan goes in one batch.
        if ctx.pending_deletes:
            b.flush()

        # Second pass: what names a change the plan makes after it (a link to
        # an entry or a morpheme created later on), by the id it is made under.
        for tokens, key, document in ctx.pending_links:
            with b.writing_for(document):
                _link_new_entry(ctx, tokens, key)
        for op in ctx.planned_links:
            with b.writing_for(op):
                _link_planned_morpheme(ctx, op)
        for keep, remove in ctx.pending_merges:
            if ('vocab_items', remove) in ctx.gone:
                continue
            ctx.gone.add(('vocab_items', remove))
            b.add(lambda batch, k=keep, r=remove: batch.vocab_items.merge(k, [r]))
        for op in ctx.pending_deletes:
            iid = op['item_id']
            if ('vocab_items', iid) in ctx.gone:
                continue
            links = _entry_links_now(client, project, op)
            if any(link not in set(op.get('links') or []) for link in links):
                raise PlanError(f'An entry got a link after this plan was read, so it was not '
                                f'deleted ({op.get("label") or "Delete entry"}).', b.applied, len(ops))
            ctx.gone.add(('vocab_items', iid))
            b.add(lambda batch, i=iid, n=len(links): batch.vocab_items.delete(i, expected_link_count=n))
        try:
            b.flush()
        except PlaidAPIError as e:
            # Every link it has in this project is one the plan read, so the
            # server counting more means links in projects this one cannot
            # open, which the assistant can neither see nor take.
            if ctx.pending_deletes and e.status == 409 and 'links' in (e.response_data or {}):
                raise _linked_elsewhere(ctx.pending_deletes) from e
            raise
        for op in ctx.later.get('second', ()):
            b.finish(op)

        # A restore is the server's own single operation over the document.
        for op in ctx.restores:
            with b.on_client(op['document_id']):
                client.documents.restore(op['document_id'], op['as_of'])
            b.applied += 1
            b.finish(op)

        # Text edits after the batches (which carry pre-edit offsets).
        # Region edits first, highest region first: each is re-verified
        # against the live body, and the tools only let a region sit after
        # every respelling of the same text, so the respellings' offsets
        # still hold afterwards.
        for op in sorted(ctx.text_edits, key=lambda o: -o['begin']):
            if project is None:
                raise ValueError('edit_text needs the project')
            with b.on_client(op['document_id']):
                _write_text_edit(client, project, op, b.new_id)
            b.finish(op)
        # Whole-token replaces keep the token (and its morphemes, which share
        # its extent) and shift everything after it.
        for text_id, edits in ctx.respells.items():
            edits.sort(key=lambda e: -e[0])
            with b.on_client(_document_of_text(ctx.later.get(f'respell:{text_id}'))):
                client.texts.update(text_id, [{'type': 'replace', 'index': bg, 'length': en - bg, 'value': v}
                                              for bg, en, v in edits])
            for op in ctx.later.get(f'respell:{text_id}', ()):
                b.finish(op)

        for op in ctx.new_docs:
            if project is None:
                raise ValueError('create_document needs the project')
            # A new document is no document the plan holds, so its writes do
            # not carry the version of the one it does (core/plan.py
            # `holding`): claimed for the new one they would all be refused.
            held, client.strict_mode_document_id = client.strict_mode_document_id, None
            try:
                create_document(client, project, op['name'], op['text'], op.get('metadata') or {},
                                b.new_id)
            finally:
                client.strict_mode_document_id = held
            b.finish(op)
        said = confirm_note(ctx.confirm_accepted, ctx.confirm_left)
        if said:
            notes.append(said)
        unwritten = ctx.confirm_rows.unwritten()
    result = dict(counts)
    if unwritten:
        result['unwritten'] = unwritten
    if notes:
        result['notes'] = notes
    return result


def _document_of_text(ops) -> Optional[str]:
    """The document a respelled text belongs to, as its ops name it."""
    return next((op.get('doc') for op in ops or () if op.get('doc')), None)


def _linked_elsewhere(deletes: List[Dict[str, Any]]) -> PlanOutOfDate:
    if len(deletes) == 1:
        name = deletes[0].get('name')
        what = f'The entry {name}' if name else 'The entry'
        return PlanOutOfDate([f'{what} is linked in projects this assistant cannot open, so it was not '
                              f'deleted'])
    return PlanOutOfDate(['An entry this plan deletes is linked in projects this assistant cannot open, '
                          'so none was deleted'])


def _entry_links_now(client, project, op) -> List[str]:
    """The links a delete_entry takes, read after the plan's own earlier
    writes (the first ``len(op['links']) + 1`` of them). Every one must be a
    link the plan read (``op['links']``), or the delete would take a link
    someone made since, which the card never showed. The delete then claims
    their number (``expected_link_count``), so the server refuses it when a
    link is made in between, or when the entry has links in projects this one
    cannot see."""
    if project is None:
        raise ValueError('delete_entry needs the project')
    seen = set(op.get('links') or [])
    res = client.query({'where': [['link', '?l', {'item': op['item_id']}]],
                        'scope': {'project_ids': [project.id]},
                        'return': {'group': ['?l.id'], 'aggregates': [['count']]},
                        'limit': len(seen) + 1})
    return [row[0] for row in (res or {}).get('results') or []]


def create_document(client, project, name: str, text: str, metadata: Dict[str, Any], new_id):
    """Document + baseline text + sentence and word tokens, tokenized as the
    editor would (one sentence per line, and the words a Baseline save gives a
    first text, ``project_new_words``). Each is made under an id from ``new_id()`` (a :class:`Minter`),
    and one an earlier run of the plan made is taken as made. Returns the new
    document id."""
    doc_id = new_id()
    # No metadata is none sent: a null is refused as a metadata map.
    if metadata:
        new_id.once(lambda: client.documents.create(project.id, name, metadata, id=doc_id))
    else:
        new_id.once(lambda: client.documents.create(project.id, name, id=doc_id))
    # A failure here leaves the document as made: the plan approved again
    # draws the same ids, takes it as made and finishes it. Deleted, its id
    # would be refused as taken on every approval after.
    _seed_text(client, project, doc_id, text, new_id)
    return doc_id


def _seed_text(client, project, doc_id: str, text: str, new_id) -> str:
    """A document's first text, with sentence and word tokens. Returns the text id.

    The sentence layer is a partition, which the server takes only whole: the
    first sentence starts at 0, each runs to the start of the next, so the
    newline and the whitespace after it stay with the sentence before (as
    ``_line_starts`` says), and the last runs to the end of the text. A bulk
    create is one layer, so the sentences and the words are two, in one
    batch."""
    from .project import project_new_words, split_sentences
    text_id = new_id()
    new_id.once(lambda: client.texts.create(project.text_layer_id, doc_id, text, id=text_id))
    lines = split_sentences(text)
    if not lines:
        return text_id
    starts = [0] + [b for b, _ in lines[1:]]
    ends = starts[1:] + [len(text)]
    sentences = [{'token_layer_id': project.sentence_layer_id, 'text': text_id, 'begin': b, 'end': e,
                  'id': new_id()} for b, e in zip(starts, ends)]
    words = [{'token_layer_id': project.word_layer_id, 'text': text_id, 'begin': wb, 'end': we,
              'id': new_id()}
             for wb, we in project_new_words(project, '', [(0, 0, text)], [])]
    def tokens():
        with client.batched() as batch:
            batch.tokens.bulk_create(sentences)
            if words:
                batch.tokens.bulk_create(words)
    new_id.once(tokens, whole=True)
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


def _write_text_edit(client, project, op: Dict[str, Any], new_id) -> None:
    """Replace body[begin:end] (verified to still read ``old``) with ``new``
    as edits at their place (``texts.edit`` with the digest of the body read),
    so no word outside the region can be taken for the one changed, then give
    the edited region the sentence boundaries its line starts call for and
    the words a Baseline save gives the text it types (``project_new_words``: the
    project's "Tokenize new text", none when it is off). What it creates is
    made under ids from ``new_id()``."""
    from plaid_client import gaps_to_ops
    from .project import find_layer, project_new_words
    doc_id, text_id, new = op['document_id'], op.get('text_id'), op['new']
    if not text_id:
        _seed_text(client, project, doc_id, new, new_id)
        return
    raw = client.documents.get(doc_id, include_body=True)
    tl, read_words = find_layer(raw.get('text_layers'), project.word_layer_id)
    body = ((tl or {}).get('text') or {}).get('body') or ''
    b, e = op['begin'], op['end']
    if body[b:e] != op['old']:
        raise ValueError(f'the text no longer reads "{op["old"][:40]}" at {b}-{e}; the document changed since the plan was made')
    new_body = body[:b] + new + body[e:]
    gaps = _region_gaps(op['old'], new, b)
    # Measured on the body read, before the server places its words on the
    # new one, as the Baseline save measures them.
    planned = project_new_words(project, body, gaps,
                                [(t['begin'], t['end']) for t in (read_words or {}).get('tokens') or []])
    client.texts.edit(text_id, gaps_to_ops(gaps), None,
                      base=((tl or {}).get('text') or {}).get('digest'), versioned=True)
    region_end = b + len(new)

    raw = client.documents.get(doc_id, include_body=True)
    _, sent_layer = find_layer(raw.get('text_layers'), project.sentence_layer_id)
    _, word_layer = find_layer(raw.get('text_layers'), project.word_layer_id)
    sents = sorted((t['begin'], t['end'], t['id']) for t in (sent_layer or {}).get('tokens') or [])
    if not sents and new_body:
        made = new_id()
        new_id.once(lambda: client.tokens.create(project.sentence_layer_id, text_id, 0, len(new_body), id=made))
        sents = [(0, len(new_body), made)]
    for p in _line_starts(new_body, b, region_end):
        hit = next((s for s in sents if s[0] < p < s[1]), None)
        # Only a boundary that leaves text on both sides: never a blank sentence.
        if hit is None or not new_body[hit[0]:p].strip() or not new_body[p:hit[1]].strip():
            continue
        sb, se, sid = hit
        made = new_id()
        new_id.once(lambda: client.tokens.split(sid, p, id=made))
        sents.remove(hit)
        sents.extend([(sb, p, sid), (p, se, made)])
        sents.sort()
    words = [(t['begin'], t['end']) for t in (word_layer or {}).get('tokens') or []]
    # A planned word over one the server placed is left out (the app's save
    # goes again without its words then). A word never straddles a sentence
    # boundary: those sit after whitespace.
    creates = [{'token_layer_id': project.word_layer_id, 'text': text_id, 'begin': wb, 'end': we,
                'id': new_id()}
               for wb, we in planned if not any(ob < we and wb < oe for ob, oe in words)]
    if creates:
        new_id.once(lambda: client.tokens.bulk_create(creates), whole=True)


def _region_gaps(old: str, new: str, at: int) -> List[Dict[str, Any]]:
    """The gaps (``{start, end, value}``, code points of the body, as Python
    strings index) that make ``new`` of ``old``, which stands at ``at`` in the
    body: each stretch that changed, found by a diff of the region alone, so
    the letters the two share stay where they were and the words over them
    keep their tokens."""
    import difflib
    return [{'start': at + i1, 'end': at + i2, 'value': new[j1:j2]}
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
            if tag != 'equal']


def _region_edits(old: str, new: str, at: int) -> List[Dict[str, Any]]:
    """``_region_gaps`` as running edit ops."""
    from plaid_client import gaps_to_ops
    return gaps_to_ops(_region_gaps(old, new, at))


def summarize(ops: List[Dict[str, Any]]) -> str:
    return ok.summarize(KIND, expand_ops(ops))
