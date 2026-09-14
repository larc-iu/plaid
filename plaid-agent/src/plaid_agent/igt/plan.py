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
  link            {token_id, item_id|null, new_entry_key|null, existing_link_id|null}
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
  set_morpheme_form {morpheme_id, form}   (a respelling carried into a morpheme's own form, with no restamp, as in Bulk Edit)
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
  confirm         {span_ids, token_ids, link_ids, on: {id: token_id}, named}   (provConfirmed on material
                  awaiting review, any origin. `on` says which token each span and link sits on. `named` marks
                  one the model named by reference, which writes to what it names; without it the op covers
                  whatever a document has awaiting review, and what the plan deletes is left out at approval)
  discard_analysis {word_id, link_ids, span_ids, morpheme_ids, reset_first_id|null, renumber: [{id, precedence}]}
  link_phrase     {token_ids: [word ids], item_id|null, new_entry_key|null, existing_link_id|null}
                  (a multi-word expression: one link over two or more words, and unlink with token_ids is one too)
  set_morph_type  {morpheme_id, morph_type|null}
  add_comment     {entity_type, entity_id, body, anchor_label, document_id}   (unaudited, as every comment)
  restore_document {document_id, as_of}   (the server's own restore, always a plan of its own)
  delete_word may carry link_ids: multi-word expressions the deletion would leave with one member.
  merge_entries links are [{link_id, token_ids}] so a moved multi-word expression keeps every member.

Each also carries a human ``label`` for the approval UI.
"""

from collections import Counter
from typing import Any, Dict, List

from ..core import opkind as ok
from ..core.opkind import OpKind
from ..core.plan import (CLEAR_PROV, CONFIRM, PlanError, Stamps,  # noqa: F401 - PlanError is re-exported
                         TrackingBatcher, apply_add_comment, apply_restore_document, applying,
                         created_id, expand_ops)
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
        self.pending_spans: List[tuple] = []   # (result idx of the created morpheme, layer_id, value)
        self.pending_links: List[tuple] = []   # ([token_id, ...], new_entry_key)
        self.entry_idx: Dict[str, int] = {}
        self.respells: Dict[str, List[tuple]] = {}
        self.pending_deletes: List[str] = []   # entries to delete once their links are gone
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

    def drop(self, resource: str, entity_id) -> None:
        if not entity_id or (resource, entity_id) in self.gone:
            return
        self.gone.add((resource, entity_id))
        self.b.add(lambda i=entity_id: getattr(self.client, resource).delete(i))


# --- what each kind does -----------------------------------------------------------

def _apply_set_span(ctx: Context, op) -> int:
    span_id, value = op.get('span_id'), op.get('value') or ''
    if span_id and value == '':
        ctx.drop('spans', span_id)
    elif span_id:
        ctx.b.update('spans', span_id, value=value, metadata=ctx.restamp())
    elif value != '':
        ctx.b.add(lambda o=op, v=value: ctx.client.spans.create(o['layer_id'], [o['token_id']], v, ctx.stamp()))
    else:
        return 0  # nothing to clear
    return 1


def _apply_set_analysis(ctx: Context, op) -> int:
    existing = op.get('existing') or []
    morphemes = op.get('morphemes') or []
    layer, text_id = op['morpheme_layer_id'], op['text_id']
    begin, end = op['begin'], op['end']
    b, client = ctx.b, ctx.client
    if existing:
        m0 = existing[0]
        for m in existing[1:]:
            ctx.drop('tokens', m['id'])  # cascades spans + links
        for sid in m0.get('span_ids') or []:
            ctx.drop('spans', sid)
        first = morphemes[0]
        b.add(lambda mid=m0['id'], f=first: client.tokens.patch_metadata(
            mid, {'form': f['form'], 'morphType': f.get('morph_type'), **ctx.restamp()}))
        # Keep the chain's numbering contiguous from 1 whatever the
        # first morpheme's precedence was before.
        b.add(lambda mid=m0['id']: client.tokens.update(mid, precedence=1))
        for fv in first.get('fields') or []:
            if fv.get('value') not in (None, ''):
                b.add(lambda mid=m0['id'], fv=fv: client.spans.create(fv['layer_id'], [mid], fv['value'], ctx.stamp()))
        rest = list(enumerate(morphemes))[1:]
    else:
        rest = list(enumerate(morphemes))
    for j, m in rest:
        meta = {'form': m['form'], **ctx.stamp()}
        if m.get('morph_type'):
            meta['morphType'] = m['morph_type']
        idx = b.add(lambda j=j, meta=meta: client.tokens.create(
            layer, text_id, begin, end, precedence=j + 1, metadata=meta))
        for fv in m.get('fields') or []:
            if fv.get('value') not in (None, ''):
                ctx.pending_spans.append((idx, fv['layer_id'], fv['value']))
    return 1


def _apply_set_orthography(ctx: Context, op) -> int:
    ctx.b.update('tokens', op['word_id'], metadata={op['key']: op.get('value') or None})
    return 1


def _apply_respell(ctx: Context, op) -> int:
    ctx.respells.setdefault(op['text_id'], []).append((op['begin'], op['end'], op['value']))
    return 1


def _link(ctx: Context, op, tokens: List[str]) -> int:
    if op.get('existing_link_id'):
        ctx.drop('vocab_links', op['existing_link_id'])
    if op.get('item_id'):
        ctx.b.add(lambda o=op, t=tokens: ctx.client.vocab_links.create(o['item_id'], t, ctx.stamp()))
    elif op.get('new_entry_key'):
        ctx.pending_links.append((tokens, op['new_entry_key']))
    return 1


def _apply_link(ctx: Context, op) -> int:
    return _link(ctx, op, [op['token_id']])


def _apply_link_phrase(ctx: Context, op) -> int:
    return _link(ctx, op, list(op['token_ids']))


def _apply_unlink(ctx: Context, op) -> int:
    ctx.drop('vocab_links', op['link_id'])
    return 1


def _apply_set_morph_type(ctx: Context, op) -> int:
    ctx.b.update('tokens', op['morpheme_id'], metadata={'morphType': op.get('morph_type') or None})
    return 1


def _apply_create_entry(ctx: Context, op) -> int:
    ctx.entry_idx[op['key']] = ctx.b.add(lambda o=op: ctx.client.vocab_items.create(
        o['vocab_id'], o['form'], {**(o.get('metadata') or {}), **ctx.stamp()}))
    return 1


def _apply_set_entry_field(ctx: Context, op) -> int:
    ctx.b.add(lambda o=op: ctx.client.vocab_items.patch_metadata(o['item_id'], {o['field']: o.get('value') or None}))
    return 1


def _apply_set_entry_metadata(ctx: Context, op) -> int:
    # A patch, so a null clears that key and the rest of the entry's metadata
    # is left alone.
    ctx.b.add(lambda o=op: ctx.client.vocab_items.patch_metadata(o['item_id'], o['patch']))
    return 1


def _apply_set_doc_metadata(ctx: Context, op) -> int:
    ctx.b.add(lambda o=op: ctx.client.documents.patch_metadata(o['document_id'], {o['field']: o.get('value') or None}))
    return 1


def _apply_create_document(ctx: Context, op) -> int:
    ctx.new_docs.append(op)  # after the batches: several dependent calls
    return 1


def _apply_merge_entries(ctx: Context, op) -> int:
    for l in op.get('links') or []:
        ctx.drop('vocab_links', l['link_id'])
        ctx.b.add(lambda o=op, t=list(l['token_ids']): ctx.client.vocab_links.create(o['keep_id'], t, ctx.stamp()))
    ctx.pending_deletes.append(op['remove_id'])
    return 1


def _apply_delete_entry(ctx: Context, op) -> int:
    for lid in op.get('links') or []:
        ctx.drop('vocab_links', lid)
    ctx.pending_deletes.append(op['item_id'])
    return 1


def _apply_rename_entry(ctx: Context, op) -> int:
    ctx.b.add(lambda o=op: ctx.client.vocab_items.update(o['item_id'], o['form']))
    return 1


def _apply_rename_document(ctx: Context, op) -> int:
    ctx.b.add(lambda o=op: ctx.client.documents.update(o['document_id'], o['name']))
    return 1


def _apply_set_morpheme_form(ctx: Context, op) -> int:
    ctx.b.update('tokens', op['morpheme_id'], metadata={'form': op['form']})
    return 1


def _apply_split_word(ctx: Context, op) -> int:
    if op.get('morpheme_ids'):
        ctx.b.add(lambda o=op: ctx.client.tokens.bulk_delete(list(o['morpheme_ids'])))
    ctx.b.add(lambda o=op: ctx.client.tokens.split(o['word_id'], o['position']))
    return 1


def _merge(ctx: Context, op, key: str, others: List[str]) -> int:
    if op.get('morpheme_ids'):
        ctx.b.add(lambda o=op: ctx.client.tokens.bulk_delete(list(o['morpheme_ids'])))
    # Sequential merges into the survivor: the server runs batch ops in order,
    # so each merge sees the widened extent. The dedup ops after them see the
    # reparented spans and links.
    for oid in others:
        ctx.b.add(lambda o=op, x=oid, k=key: ctx.client.tokens.merge(o[k], x))
    for sp in op.get('spans') or []:
        if sp.get('value') is not None:
            ctx.b.add(lambda sp=sp: ctx.client.spans.update(sp['keep_id'], sp['value']))
        for sid in sp.get('delete_ids') or []:
            ctx.drop('spans', sid)
    for lid in (op.get('links') or {}).get('delete_ids') or []:
        ctx.drop('vocab_links', lid)
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
    ctx.b.add(lambda o=op: ctx.client.tokens.split(o['sentence_id'], o['position']))
    return 1


def _apply_edit_text(ctx: Context, op) -> int:
    ctx.text_edits.append(op)  # after the batches: several dependent calls
    return 1


def _apply_confirm(ctx: Context, op) -> int:
    for tid in op.get('token_ids') or []:
        ctx.b.update('tokens', tid, metadata=CONFIRM)
    for lid in op.get('link_ids') or []:
        ctx.b.add(lambda i=lid: ctx.client.vocab_links.patch_metadata(i, CONFIRM))
    for sid in op.get('span_ids') or []:
        ctx.b.update('spans', sid, metadata=CONFIRM)
    return (len(op.get('token_ids') or []) + len(op.get('link_ids') or [])
            + len(op.get('span_ids') or []))


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
        ctx.b.add(lambda i=op['reset_first_id']: ctx.client.tokens.patch_metadata(
            i, {'form': None, 'morphType': None, **CLEAR_PROV}))
    for r in op.get('renumber') or []:
        ctx.b.add(lambda r=r: ctx.client.tokens.update(r['id'], precedence=r['precedence']))
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
            + list((op.get('links') or {}).get('delete_ids') or []))


def _discard_analysis_deletes(op):
    return list(op.get('link_ids') or []) + list(op.get('span_ids') or [])


# --- what a kind writes to that no key of its own names ------------------------------

def _create_entry_writes(op):
    """A new sense hangs off the entry it is a sense of, which is named inside
    the metadata it carries rather than by a key of the op. A plan that deletes
    that entry would leave the sense hanging off an id that resolves to
    nothing."""
    return [parent_of({'metadata': op.get('metadata') or {}})]


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

    def __init__(self, client, project):
        from .workspace import Workspace
        self.client = client
        self.project = project
        self.ws = Workspace(client, project)


def _resolve_bulk_scope(res: Resolution, op):
    from .bulk import CANDIDATE_MAX, SCOPED
    from ..core.tools import ToolError
    fn = SCOPED.get(op.get('tool'))
    if fn is None:
        raise ValueError(f'unknown corpus-wide tool {op.get("tool")!r}')
    try:
        return fn(res.ws, dict(op.get('args') or {}), CANDIDATE_MAX)
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
    OpKind('set_span', ('field value', 'field values'), required=('layer_id', 'token_id'),
           apply=_apply_set_span, target=lambda op: ('span', op.get('layer_id'), op.get('token_id')),
           at=('token_id',), at_kind=TOKEN, token_keys=('token_id',), deletes=_set_span_deletes,
           compact_each=('token_id', 'span_id', 'value', 'doc')),
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
    OpKind('link', ('lexicon link', 'lexicon links'), required=('token_id',),
           apply=_apply_link, target=lambda op: ('link', op.get('token_id')),
           # The entry as well as the word: a link to an entry the plan removes
           # is written and then taken away with it.
           at=('token_id',), at_kind=TOKEN, token_keys=('token_id', 'item_id'),
           deletes=lambda op: [op.get('existing_link_id')]),
    OpKind('unlink', ('unlink', 'unlinks'), required=('link_id',), apply=_apply_unlink,
           # A multi-word expression's link is its own target: unlinking it
           # never displaces a member word's own link.
           target=lambda op: (('mwe_link', op.get('link_id')) if op.get('token_ids')
                              else ('link', op.get('token_id_hint'))),
           at=('token_id_hint', 'token_ids'), at_kind=TOKEN, deletes=lambda op: [op['link_id']]),
    OpKind('link_phrase', ('multi-word expression', 'multi-word expressions'), required=('token_ids',),
           apply=_apply_link_phrase, target=lambda op: ('mwe', tuple(op.get('token_ids') or [])),
           at=('token_ids',), at_kind=TOKEN, token_keys=('token_ids', 'item_id'),
           deletes=lambda op: [op.get('existing_link_id')]),
    OpKind('create_entry', ('new lexicon entry', 'new lexicon entries'), required=('vocab_id', 'form', 'key'),
           apply=_apply_create_entry, writes=_create_entry_writes),
    OpKind('set_entry_field', ('entry field', 'entry fields'), required=('item_id', 'field'),
           apply=_apply_set_entry_field, at=('item_id',), at_kind=ENTRY, token_keys=('item_id',),
           target=lambda op: ('entry_field', op.get('item_id'), op.get('field'))),
    OpKind('set_entry_metadata', ('entry structure change', 'entry structure changes'),
           required=('item_id', 'patch'), apply=_apply_set_entry_metadata, at=('item_id',), at_kind=ENTRY,
           token_keys=('item_id',),
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
           extra={'removes_entry': ('remove_id',)}),
    OpKind('delete_entry', ('deleted entry', 'deleted entries'), required=('item_id',),
           apply=_apply_delete_entry, at=('item_id',), at_kind=ENTRY,
           target=lambda op: ('delete_entry', op.get('item_id')),
           deletes=lambda op: [op['item_id']] + list(op.get('links') or []),
           extra={'removes_entry': ('item_id',)}),
    OpKind('rename_entry', ('renamed entry', 'renamed entries'), required=('item_id', 'form'),
           apply=_apply_rename_entry, at=('item_id',), at_kind=ENTRY, token_keys=('item_id',),
           target=lambda op: ('rename_entry', op.get('item_id')),
           compact_each=('item_id', 'form')),
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
           compact_each=('morpheme_id', 'form', 'doc')),
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
MORPHEME_WRITERS = tuple(name for name, keys in ok.token_keys(KIND).items() if 'morpheme_id' in keys)


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


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    reach = {d for op in ops if op.get('kind') in SCOPES for d in (op.get('documents') or [])}
    if reach:
        for op in ops:
            if op.get('kind') in RESHAPES and (not op.get('doc') or op['doc'] in reach):
                raise ValueError('this plan holds a corpus-wide change and reshapes a document it reaches; '
                                 'the two would meet for the first time in the batch')
    for i, op in enumerate(ops):
        spec = ok.kind_of(KIND, op, index=i + 1)
        kind = spec.name
        for k in spec.required:
            if op.get(k) in (None, '') and not (k in ('begin', 'end') and op.get(k) == 0):
                raise ValueError(f'op {i + 1} ({kind}): missing {k}')
        if kind == 'set_analysis' and (not isinstance(op['morphemes'], list) or not op['morphemes']
                                       or any(not (m.get('form') or '').strip() for m in op['morphemes'])):
            raise ValueError(f'op {i + 1} (set_analysis): morphemes must be a non-empty list with non-empty forms')
        if kind in ('link', 'link_phrase') and not (op.get('item_id') or op.get('new_entry_key')):
            raise ValueError(f'op {i + 1} ({kind}): needs item_id or new_entry_key')
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


def _certainly_doomed(ops) -> set:
    """Ids the plan certainly deletes, as against the ones a text edit only
    guesses at. Staging refuses a change naming one of these, so reaching
    here with one means a plan was built some way the guard does not cover."""
    return ok.removed_ids(KIND, ops, only_certain=True)


def normalize_ops(ops: List[Dict[str, Any]]) -> tuple:
    """Resolve interactions between ops in one plan: drop links to entries the
    plan deletes or merges away, refuse a merge whose survivor is removed by
    another op, dedupe entry deletes, collapse repeated respells of one range
    (last wins) and refuse overlapping ones. Returns (ops, notes)."""
    notes: List[str] = []
    removed = removed_entries(ops)
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
    certain = _certainly_doomed(ops)
    dead = _dead_tokens(ops)
    for op in ops:
        k = op.get('kind')
        # What this op writes to and the plan deletes: the word a change sits
        # on, the entry a link points at, the span a comment is anchored to,
        # the material a confirmation the model NAMED confirms.
        writes = ok.written_to(KIND, op)
        # A CERTAIN delete is refused as the plan is built, in both orders, so
        # a card never promises a change that will not happen. Reaching here
        # with one means the plan was built some way the staging guard does not
        # cover, and refusing the whole plan says so rather than applying most
        # of it.
        if writes & certain:
            raise ValueError(f'{op.get("label") or k}: what it names is deleted or merged away by '
                             'another change in this plan')
        # A text edit's word ids are a GUESS (the server diffs the text and
        # may keep the word), so the op is dropped rather than refused: it
        # is moot if the word goes, and the plan was already approved. A
        # confirmation covers several things and keeps the ones that survive,
        # below.
        if writes & doomed and k != 'confirm':
            notes.append(f'dropped: {op.get("label") or k} '
                         '(what it names is deleted or merged away in this plan)')
            continue
        if k in MORPHEME_WRITERS and op['morpheme_id'] in rewritten:
            notes.append(f'dropped: {op.get("label") or "a morpheme change"} (that analysis is rewritten in this plan)')
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
    return out, notes


def execute_plan(client, ops: List[Dict[str, Any]], *, source: str, label: str, project=None,
                 stamp_mode: str = 'verified', contributor: str = None) -> Dict[str, int]:
    """Apply ``ops`` with ``client`` under one operation labelled ``label``.
    Returns per-kind counts of what was applied (plus ``notes`` for anything
    dropped). ``project`` (an IgtProject) is needed only by document-creating
    ops. ``stamp_mode`` is ``'verified'`` (machine-made, human-confirmed: the
    default), ``'human'`` (no provenance keys at all) or ``'contributed'``
    (the approver's own unreviewed work; needs ``contributor``, their user
    id). Raises :class:`PlanError` with the applied count if a later batch
    fails: batches are atomic individually, the plan as a whole is not."""
    stamps = Stamps(stamp_mode, source, contributor)
    ops = expand_ops(ops)
    validate_ops(ops)
    ops = resolve_scopes(client, project, ops)
    ops, notes = normalize_ops(ops)
    counts: Counter = Counter()
    return applying(ops, lambda tracker: _execute(client, ops, label=label, project=project,
                                                  counts=counts, notes=notes, stamps=stamps,
                                                  tracker=tracker))


def resolve_scopes(client, project, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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
    return ok.resolve_ops(KIND, Resolution(client, project), ops,
                          lambda o: op_target(o) not in explicit)


def _execute(client, ops, *, label, project, counts, notes, stamps: Stamps, tracker=None) -> Dict[str, int]:
    # An unknown kind, one that should have been resolved away, or one staged
    # for a pass this executor does not run refuses before the first batch
    # opens rather than being written as nothing under a label saying it was
    # applied.
    ok.check_applicable(KIND, ops, STAGES)
    with client.operation(label):
        ctx = Context(client, project, stamps, counts, notes, TrackingBatcher(client, tracker=tracker))
        b = ctx.b
        # Seeded with what goes without a delete call of its own, so a single
        # delete naming the same id is never issued beside it.
        for _tid in _bulk_gone(ops):
            ctx.gone.add(('tokens', _tid))

        for op in ops:
            spec = KIND[op['kind']]
            n = spec.apply(ctx, op)
            n = 1 if n is None else n
            # An applier that wrote nothing (clearing a value that was not
            # there) adds no key. A zero-valued one reaches the user as
            # "0 field values" on the applied card.
            if n:
                counts[spec.noun[1]] += n

        b.flush()

        # Second pass: things that need ids minted above.
        for idx, layer_id, value in ctx.pending_spans:
            mid = created_id(b.results[idx] if idx < len(b.results) else None)
            if not mid:
                raise RuntimeError('a created morpheme came back without an id; its gloss was not written')
            b.add(lambda l=layer_id, m=mid, v=value: client.spans.create(l, [m], v, stamps.stamp()))
        for tokens, key in ctx.pending_links:
            i = ctx.entry_idx.get(key)
            iid = created_id(b.results[i]) if i is not None and i < len(b.results) else None
            if not iid:
                raise RuntimeError('a created lexicon entry came back without an id; a link to it was not written')
            b.add(lambda i=iid, t=tokens: client.vocab_links.create(i, t, stamps.stamp()))
        for iid in ctx.pending_deletes:
            ctx.drop('vocab_items', iid)
        b.flush()

        # A restore is the server's own single operation over the document.
        for op in ctx.restores:
            client.documents.restore(op['document_id'], op['as_of'])
            b.applied += 1

        # Text edits after the batches (which carry pre-edit offsets).
        # Region edits first, highest region first: each is re-verified
        # against the live body, and the tools only let a region sit after
        # every respelling of the same text, so the respellings' offsets
        # still hold afterwards.
        for op in sorted(ctx.text_edits, key=lambda o: -o['begin']):
            if project is None:
                raise ValueError('edit_text needs the project')
            _write_text_edit(client, project, op)
        # Whole-token replaces keep the token (and its morphemes, which share
        # its extent) and shift everything after it.
        for text_id, edits in ctx.respells.items():
            edits.sort(key=lambda e: -e[0])
            client.texts.update(text_id, [{'type': 'replace', 'index': bg, 'length': en - bg, 'value': v}
                                          for bg, en, v in edits])

        for op in ctx.new_docs:
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
    from .project import split_sentences, split_words
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


def _write_text_edit(client, project, op: Dict[str, Any]) -> None:
    """Replace body[begin:end] (verified to still read ``old``) with ``new``
    through the server's diffing text update, then give the edited region
    the sentence boundaries its line starts call for and word tokens for
    whatever text in it is untokenized, as the editor's baseline save plus
    its tokenizer would."""
    from .project import find_layer
    from .project import split_words
    doc_id, text_id, new = op['document_id'], op.get('text_id'), op['new']
    if not text_id:
        _seed_text(client, project, doc_id, new)
        return
    raw = client.documents.get(doc_id, include_body=True)
    tl, _ = find_layer(raw.get('text_layers'), project.word_layer_id)
    body = ((tl or {}).get('text') or {}).get('body') or ''
    b, e = op['begin'], op['end']
    if body[b:e] != op['old']:
        raise ValueError(f'the text no longer reads "{op["old"][:40]}" at {b}-{e}; the document changed since the plan was made')
    new_body = body[:b] + new + body[e:]
    client.texts.update(text_id, new_body)
    region_end = b + len(new)

    raw = client.documents.get(doc_id, include_body=True)
    _, sent_layer = find_layer(raw.get('text_layers'), project.sentence_layer_id)
    _, word_layer = find_layer(raw.get('text_layers'), project.word_layer_id)
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
    return ok.summarize(KIND, expand_ops(ops))
