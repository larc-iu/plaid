"""The tools a UD assistant may call, and the workspace they run against.

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3.w2``), never by id: see
:mod:`.project` for why, and for what a UD project is shaped like.
"""

import copy
from typing import Any, Dict, List, Optional

from plaid_client import uuid7

from ..core import docload, opkind
from ..core.args import whole
from ..core.limits import MAX_SCOPE_DOCS, OVERVIEW_DOCS
from ..core.history import doc_label
from ..core.plan import by_document
from ..core.workspace import BaseWorkspace
from ..core.provenance import unmark
from ..core.tools import ToolError, server_refused
from .plan import (KIND, RESHAPES_DOCUMENT, RESHAPES_TOKEN, REWRITES_DOCUMENT, contributed_work, docs_of_op,
                   scope_clears)
from .project import (FEATURES, Sentence, Token, UdDoc, UdProject, Word, feats_order, feature_key,
                      feature_refusal, load_document, normalize_feature, render_document, resolve,
                      word_ref)
from .review import (REVIEW_FIELDS, all_words, confirm_targets, counts_phrase, discard_targets,
                     left_phrase, per_field)

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ("A whole document's review (confirm or discard_predictions without refs) counts as one "
             "change however many values it covers.")
# Ops that stand for everything a predicate matches (a document and a set of
# fields, or a field and a pattern) and are resolved to spans when the plan is
# applied. Every kind that declares how to resolve itself, so a new one joins
# by being declared.
SCOPE_KINDS = opkind.scopes(KIND)
# The most documents one review may cover when several are named or all
# are asked for: each is read to count what is waiting, and read again at
# approval.

# Parsed documents, shared across turns and users of this process. See
# plaid_agent.core.docload for what the key covers and what it does not.
_DOC_CACHE = docload.DocCache()




# --- the workspace ------------------------------------------------------------

class Workspace(BaseWorkspace):
    """One turn's view of a treebank project: what it has loaded and the plan
    it is proposing."""

    KIND = KIND
    PLAN_NOTE = PLAN_NOTE
    SPAN_KIND = 'set_span'
    DOC_CACHE = _DOC_CACHE
    RESTORE_TOOL = 'restore_document'
    # A word holds its basic relation and the suppressor over it by id, and a
    # change to either depends on that word's sentence.
    SENTENCE_ID_FIELDS = ('id', 'relation_id', 'suppressor_id')
    # A token's new words name the text, at the token's own offsets, which
    # its sentence's fingerprint holds.
    NOT_CONTENT_KEYS = ('text_id',)

    def render(self, doc, **kw) -> str:
        return render_document(doc, **kw)

    def entity_index(self, doc) -> Dict[str, Any]:
        """Everything that carries provenance, a word's basic relation
        included, which the parsed word holds by id beside its metadata."""
        index = super().entity_index(doc)
        for s in doc.sentences:
            for w in s.words:
                if w.relation_id and w.relation_id not in index:
                    index[w.relation_id] = w.relation_metadata
        return index

    def comment_anchor(self, doc: 'UdDoc', ref: str) -> str:
        # A sentence's comments hang off its token.
        thing = resolve(doc, ref)
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence or on '
                            f'the document.')
        return thing.id

    def __init__(self, client, project: UdProject, on_progress=None):
        super().__init__(client, project, on_progress)

    def make_corpus(self):
        from .corpus import Corpus
        return Corpus(self)

    def load_doc(self, doc_id: str) -> UdDoc:
        return load_document(self.client, self.project, doc_id)

    def doc(self, document: str) -> UdDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            # Name it the way the user would: a corpus-wide tool passes an id,
            # and "Reading 019ed0b8-…" tells a watcher nothing.
            entry = next((d for d in self.documents() if d['id'] == did), {})
            self._docs[did] = self.reader.get(did, self._version_of(entry),
                                              entry.get('name') or document)
        return self._docs[did]

    def word(self, document: str, ref: str):
        """The sentence, word or multi-word token a reference names."""
        return resolve(self.doc(document), ref)

    def sentence_of(self, doc: UdDoc, w: Word) -> Sentence:
        for s in doc.sentences:
            if any(x is w for x in s.words):
                return s
        raise ToolError('internal: word not in document')

    # --- the plan --------------------------------------------------------

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        super().guard_op(op, replacing=replacing)
        self.refuse_scope_clash(op, replacing=replacing)
        self.refuse_reshape_clash(op, replacing=replacing)
        self.refuse_cycle(op, replacing=replacing)

    def staged_values(self, op: Dict[str, Any]) -> List[tuple]:
        if op.get('kind') in ('set_head', 'set_deprel'):
            return [(self.project.relation_layer_id, op.get('deprel'))]
        return super().staged_values(op)

    def value_rules(self, layer_id: str) -> tuple:
        if layer_id and layer_id == self.project.relation_layer_id:
            return 'deprel', self.project.value_sets.get('deprel') or []
        field = next((f for f, lid in self.project.span_layers.items() if lid == layer_id), None)
        return (field, self.project.value_sets.get(field) or []) if field else ('', [])

    def refuse_cycle(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A head that closes a cycle in the basic tree, with the heads the
        plan already gives (the tree's layer holds the acyclic rule, so the
        server would refuse the whole plan at approval, R1-DEBT-CORE-4)."""
        if (op.get('kind') != 'set_head' or op.get('head_id') == op.get('word_id')
                or not self.project.acyclic):
            return
        doc = self.doc(op['document_id'])
        sentence = next((s for s in doc.sentences if any(w.id == op['word_id'] for w in s.words)), None)
        if sentence is None:
            return
        by_index = {w.index: w.id for w in sentence.words}
        heads = {w.id: (by_index.get(w.head) if w.head else None) for w in sentence.words}
        for i, o in enumerate(self.ops):
            if i == replacing or o.get('word_id') not in heads:
                continue
            if o.get('kind') == 'set_head':
                heads[o['word_id']] = None if o.get('head_id') == o['word_id'] else o.get('head_id')
            elif o.get('kind') == 'del_relation':
                heads[o['word_id']] = None
        heads[op['word_id']] = op['head_id']
        seen, cur = set(), op['word_id']
        while cur is not None and cur not in seen:
            seen.add(cur)
            cur = heads.get(cur)
        if cur is not None:
            raise ToolError(f'{op.get("ref") or "That word"} cannot take that head: the head hangs below it '
                            'in the tree (with the heads this plan gives), so the tree would hold a cycle. '
                            'Give the head word another head first.')

    def exclusive_message(self, staging_it: bool) -> str:
        if staging_it:
            return ('A restore must be a plan of its own, since it rewrites every layer of the '
                    'document. Discard the plan first (discard_plan), or let the user approve it '
                    'and ask for the restore afterwards.')
        return ('This plan restores a document, and a restore rewrites every layer of '
                'it, so nothing else can share the plan. Apply it on its own, then '
                'plan the rest against what it restored (plan_status, drop_planned).')

    def clash_message(self, victim: Dict[str, Any], killer: Optional[Dict[str, Any]]) -> str:
        """Reshaping a token deletes and remakes its words, so the words it
        takes with it are worth naming: the registry's own wording says only
        that one change writes to what another deletes."""
        if (killer or {}).get('kind') in RESHAPES_TOKEN:
            return ('This plan both reshapes a token and writes to one of its words, and the '
                    'reshape deletes that word. Keep one of the two (plan_status, drop_planned), '
                    'or plan them in separate turns.')
        return super().clash_message(victim, killer)

    def refuse_reshape_clash(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A token reshape against a change that names no word, which is what
        the certain-delete funnel matches on: a second reshape of the same
        token, and a scope, which reaches every word of its document without
        naming one. Both orders, with `validate_ops` as the backstop.

        A reshape against a change that DOES name a word is the funnel's, and
        saying it here as well would be one rule with two writers.
        """
        kind = op.get('kind')
        if kind not in RESHAPES_TOKEN and kind not in SCOPE_KINDS:
            return
        planned = [o for i, o in enumerate(self.ops) if i != replacing]
        if kind in RESHAPES_TOKEN:
            words = set(op.get('existing_word_ids') or [])
            if any(prev.get('kind') in RESHAPES_TOKEN
                   and words & set(prev.get('existing_word_ids') or []) for prev in planned):
                raise ToolError('This plan already reshapes this token. Keep one of the two '
                                '(plan_status, drop_planned), or plan them in separate turns.')
            other = SCOPE_KINDS
        else:
            other = RESHAPES_TOKEN
        reach = docs_of_op(op)
        if any(prev.get('kind') in other and docs_of_op(prev) & reach for prev in planned):
            raise ToolError('This plan both reshapes a token and changes every matching word of '
                            'its document, and the reshape deletes some of them. Keep one of the '
                            'two (plan_status, drop_planned), or plan them in separate turns.')

    def refuse_scope_clash(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """Two changes that cover a whole document, reaching one document,
        where one of them throws values away.

        Neither knows which values it covers until the plan is applied, so the
        pair cannot be checked by id at all. A confirmation of a document and a
        discard over the same document used to be staged together, shown on one
        card, and reconciled only afterwards, by dropping the confirmations.
        """
        if op.get('kind') not in SCOPE_KINDS:
            return
        reaches = docs_of_op(op)
        clears = scope_clears(op)
        for i, prev in enumerate(self.ops):
            if i == replacing or prev.get('kind') not in SCOPE_KINDS:
                continue
            if not (docs_of_op(prev) & reaches) or not (clears or scope_clears(prev)):
                continue
            raise ToolError(
                f'{prev.get("label") or prev.get("kind")} already covers a document this change '
                'covers, and one of the two throws values away. Keep one of them (plan_status, '
                'drop_planned), or plan them in separate turns.')

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .plan import summarize
        from .changes import describe_changes
        from ..core.plan import compact_ops
        # A snapshot: the payload must not alias the live list, since it is
        # what the user approves later. Large groups of like ops are stored
        # as one (the summary still counts what they stand for).
        ops = compact_ops(self.mark_replaced_work(copy.deepcopy(self.ops)), compact_spec(self))
        return {'id': uuid7(), 'summary': summarize(self.ops),
                'labels': [op['label'] for op in ops], 'ops': ops,
                'changes': describe_changes(self, ops),
                'documents': self.touched_documents()}


# --- whose work a change replaces -----------------------------------------------
#
# What each kind rewrites or removes, for the card's "replace accepted work"
# line (core/work.py). A value's provenance sits on its span and a dependency's
# on its relation, which a parsed word holds as ``relation_metadata``.

def _words_by_id(ws: 'Workspace', ids) -> List[Any]:
    wanted = set(ids or [])
    return [w for doc in ws._docs.values() for s in doc.sentences for w in s.words if w.id in wanted]


def _words_work(ws: 'Workspace', op: Dict[str, Any]) -> List[str]:
    """A token's words, when it is cut again: their values and their heads."""
    return [x for w in _words_by_id(ws, op.get('existing_word_ids'))
            for x in [sp.id for _f, sp in w.all_spans()] + [w.relation_id]]


_NONE = None
REPLACES = {
    'set_span': lambda ws, op: [op.get('span_id')],
    'set_head': lambda ws, op: [op.get('relation_id')],
    'del_relation': lambda ws, op: [op.get('relation_id')],
    'set_deprel': lambda ws, op: [op.get('relation_id')],
    'set_words': _words_work,
    # The relations a cut leaves spanning two sentences go with it.
    'split_sentence': lambda ws, op: list(op.get('relation_ids') or []),
    # A join only widens a sentence, so it takes no relation.
    'merge_sentences': _NONE,
    'confirm': _NONE, 'add_comment': _NONE,
    # Resolved when approved, from the documents as they are then, and a
    # restore puts back what was there: none of them names what it replaces
    # now. A parse is a service run with its own overwrite rule.
    'confirm_scope': _NONE, 'discard_scope': _NONE, 'replace_scope': _NONE,
    'restore_document': _NONE, 'run_parse': _NONE,
    # Prose: the card's Rewrite line says so already.
    'add_guideline': _NONE, 'revise_guideline': _NONE, 'rewrite_guideline': _NONE,
}
Workspace.REPLACES = REPLACES


def op_target(op: Dict[str, Any]):
    """What an op writes to, for last-wins replacement within one plan. Each
    kind declares its own; a kind that can supersede nothing has none."""
    return opkind.target_of(KIND, op)


def compact_spec(ws: 'Workspace') -> Dict[str, Dict[str, Any]]:
    """How like ops fold into one stored op (core.plan.compact_ops), read off
    the registry: each kind says which of its keys vary per member, and writes
    the line its group shows.

    A function taking the workspace, as IGT's is, because that app's group
    lines are headed by their document. Nothing here needs it, and one name
    for the thing beats two."""
    return opkind.compact_spec(KIND)


# --- reads --------------------------------------------------------------------

FIELDS = ('lemma', 'upos', 'xpos', 'features')


def t_project_overview(ws: Workspace) -> str:
    p = ws.project
    out = [f'Project "{p.name}" (Universal Dependencies)']
    if p.language:
        out.append(f'Language: {p.language}')
    out.append('')
    out.append('Every annotation sits on a WORD (a CoNLL-U word). A word is addressed by its '
               'position: s3.w2 is word 2 of sentence 3. A multi-word token is s3.w1-2.')
    out.append('')
    out.append('Vocabularies:')
    for f in ('upos', 'xpos', 'deprel'):
        out.append('  ' + p.rule(f))
    feats = p.vocab.get('feats') or {}
    if feats:
        out.append('  features: ' + ', '.join(f'{k}={"/".join(v)}' if v else k
                                              for k, v in sorted(feats.items())))
    else:
        out.append('  features: no inventory set, any Feature=Value is allowed')
    docs = ws.documents()
    out.append('')
    # How much corpus there is, so the model knows before it reads anything
    # whether reading is a way to answer. A project without the engine (a
    # test double) just goes without the line.
    try:
        sizes = ws.corpus.sizes()
        out.append(f'Size: {len(docs)} documents, {sizes["sentences"]} sentences, {sizes["words"]} words. '
                   'search, frequency_list, worklist and check_consistency read the whole corpus at '
                   'once; read_document reads one document a page at a time.')
        out.append('')
    except Exception:  # noqa: BLE001 - the overview is worth having without the size
        pass
    out.append(f'Documents ({len(docs)}):')
    for d in docs[:OVERVIEW_DOCS]:
        out.append(f'  "{d.get("name")}"')
    if len(docs) > OVERVIEW_DOCS:
        out.append(f'  ... and {len(docs) - OVERVIEW_DOCS} more (list_documents pages through them)')
    return '\n'.join(out)


# --- planning helpers ----------------------------------------------------------

def _no_parse_planned(ws: Workspace, doc: UdDoc) -> None:
    """A parse rewrites a document from scratch, so nothing else in the same
    plan may write into it: whichever was planned first, the other is lost.
    Per document, which is why a parse is not tagged EXCLUSIVE: a plan may
    write to one document and parse another."""
    for op in ws.ops:
        if op.get('kind') in REWRITES_DOCUMENT and doc.id in docs_of_op(op):
            raise ToolError(f'This plan already parses "{doc.name}", and a parse rewrites the '
                            f'document from scratch, so this change would be thrown away. Plan '
                            f'the parse on its own, or drop it first (plan_status, drop_planned).')


def _no_restore_planned(ws: Workspace) -> None:
    """A restore rewrites every layer of its document, so nothing may join its
    plan. The rule and its wording are the workspace's, and every staged op
    reaches them through `guard_op`; this is the early refusal for a tool that
    would otherwise do expensive work first."""
    ws.refuse_exclusive(None)


def _no_boundary_moved(ws: Workspace, doc: UdDoc) -> None:
    """Moving a sentence boundary renumbers every sentence after it, and every
    reference in a plan is positional. Rather than decide whether a later
    "s7.w2" means before or after, a plan that moves a boundary does that and
    nothing else to the document."""
    for op in ws.ops:
        if op.get('kind') in RESHAPES_DOCUMENT and op.get('document_id') == doc.id:
            raise ToolError(f'This plan already moves a sentence boundary in "{doc.name}", and '
                            f'that renumbers the sentences every other reference names. Apply it '
                            f'on its own, then plan the rest against the new numbering '
                            f'(plan_status, drop_planned).')


def _boundary_can_still_move(ws: Workspace, doc: UdDoc) -> None:
    """The same rule seen from the other side, for the boundary tools
    themselves. `_no_boundary_moved` refuses an edit planned AFTER a boundary
    move; without this, planning them the other way round was accepted, the
    card said the sentences would renumber, and `validate_ops` refused the
    whole thing only once the user had approved it."""
    if any(doc.id in docs_of_op(op) for op in ws.ops):
        raise ToolError(f'This plan already changes "{doc.name}", and moving a sentence boundary '
                        f'renumbers the sentences every other reference names, so it has to be a '
                        f'plan of its own. Apply what is planned, then move the boundary '
                        f'(plan_status, drop_planned).')


def _guards(ws: Workspace, doc: UdDoc) -> None:
    """The refusals every edit to a document owes, whichever tool stages it.
    Kept in one place because the hole they leave is invisible: a tool that
    reaches a document's words without passing through here can join a plan
    that deletes the very tokens it writes to."""
    _no_parse_planned(ws, doc)
    _no_boundary_moved(ws, doc)
    _no_restore_planned(ws)


def _words(ws: Workspace, doc: UdDoc, refs) -> List[Word]:
    """The words a list of references names, with a readable failure when one
    of them names a sentence or a multi-word token instead."""
    _guards(ws, doc)
    if isinstance(refs, str):
        refs = [refs]
    if not refs:
        raise ToolError('Name at least one word, as a list of references like ["s1.w2"].')
    out = []
    for ref in refs:
        thing = resolve(doc, str(ref))
        if isinstance(thing, Sentence):
            raise ToolError(f'{ref} is a sentence. Name its words (s{thing.index}.w1 and so on): '
                            f'an annotation sits on a word.')
        if isinstance(thing, Token):
            raise ToolError(f'{ref} is a multi-word token, which carries no annotation of its own. '
                            f'Name its words: ' + ', '.join(f's?.w{w.index}' for w in thing.words))
        out.append(thing)
    return out


def _field_layer(ws: Workspace, field: str) -> str:
    if field not in FIELDS:
        raise ToolError(f'Unknown field "{field}". One of: ' + ', '.join(FIELDS))
    return ws.project.layer('features' if field == 'features' else field)


def t_set_field(ws: Workspace, document: str = None, refs=None, field: str = None,
                value: str = None) -> str:
    doc = ws.doc(document)
    layer_id = _field_layer(ws, field)
    value = '' if value is None else str(value)
    if field == FEATURES:
        return _set_features(ws, doc, layer_id, refs, value)
    value = unmark(value, field)
    words = _words(ws, doc, refs)
    staged = []
    for w in words:
        sp = w.fields.get(field)
        staged.append({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                       'span_id': sp.id if sp else None, 'value': value,
                       'field': field, 'document_id': doc.id,
                       'label': f'{field} = "{value}"' if value else f'clear {field}',
                       'ref': word_ref(ws.sentence_of(doc, w), w)})
    ws.add_ops(staged)
    what = f'{field} = "{value}"' if value else f'{field} cleared'
    return f'Planned {what} on {len(words)} word(s): ' + ', '.join(
        word_ref(ws.sentence_of(doc, w), w) for w in words)


def _pairs(bundle: str) -> Dict[str, str]:
    """A FEATS string as ``{feature: value}``, each pair read as the app reads
    one. A pair it cannot read, or a feature named twice, is refused."""
    out: Dict[str, str] = {}
    for raw in (bundle or '').split('|'):
        if not raw.strip():
            continue
        # A read marks each pair on its own ("Mood=Ind~|Number=Plur").
        raw = unmark(raw, 'feature')
        pair = normalize_feature(raw)
        if not pair:
            raise ToolError(f'"{raw}" is not a feature: write each one as Feature=Value, '
                            f'joined by |, e.g. Case=Nom|Number=Sing.')
        refusal = feature_refusal(pair[2])
        if refusal:
            raise ToolError(f'"{raw}": {refusal}')
        if pair[0] in out:
            raise ToolError(f'{pair[0]} is named twice. A word holds one value of each feature.')
        out[pair[0]] = pair[1]
    return out


def _check_feature(ws: Workspace, feature: str, value: str) -> None:
    """Refuse a pair a CLOSED feature inventory does not list."""
    inventory = ws.project.vocab.get('feats') or {}
    if not (inventory and ws.project.modes.get('feats') == 'closed' and value):
        return
    if feature not in inventory:
        raise ToolError(f'"{feature}" is not in this project\'s feature inventory, which is closed. '
                        f'Features: ' + ', '.join(sorted(inventory)))
    allowed = inventory.get(feature) or []
    if allowed and value not in allowed:
        raise ToolError(f'"{value}" is not a value of {feature} here. Allowed: ' + ', '.join(allowed))


def _is_feature_op(op: Dict[str, Any], layer_id: str, word_id: str) -> bool:
    return (op.get('kind') == 'set_span' and op.get('layer_id') == layer_id
            and op.get('token_id') == word_id and op.get('feature') is not None)


def _planned_features(ws: Workspace, layer_id: str, w: Word) -> Dict[str, str]:
    """The word's features once the plan runs, ``{feature: value}``: what is
    stored, with every planned write to one of its pairs applied."""
    out: Dict[str, str] = {}
    for sp in w.features:
        pair = normalize_feature(sp.value)
        if pair:
            out[pair[0]] = pair[1]
    for op in ws.ops:
        if _is_feature_op(op, layer_id, w.id):
            pair = normalize_feature(op.get('value'))
            if pair:
                out[op['feature']] = pair[1]
            else:
                out.pop(op['feature'], None)
    return out


def _feature_ops(ws: Workspace, doc: UdDoc, layer_id: str, w: Word,
                 want: Dict[str, Optional[str]]) -> tuple:
    """What a word needs for its features to be ``want`` (a value, or None to
    remove one): ``(ops to stage, planned ops to drop)``. Each feature is its
    own span, so a change is a create, an update or a delete of the one span
    holding that feature, as the app's FEATS cell writes it. Wanting what is
    stored drops the planned change to that feature (removing a feature only
    this plan adds, or putting back a stored one this plan removes)."""
    planned = _planned_features(ws, layer_id, w)
    ref = word_ref(ws.sentence_of(doc, w), w)
    stage, drop = [], []
    for key, value in want.items():
        if (planned.get(key) or None) == (value or None):
            continue
        sp = w.feature_span(key)
        stored = (normalize_feature(sp.value) or (None, None))[1] if sp is not None else None
        if (value or None) == stored:
            # Back to what is stored: drop the planned change rather than
            # stage a write of the span's own value, which an approved plan
            # would stamp verified.
            drop += [op for op in ws.ops if _is_feature_op(op, layer_id, w.id) and op['feature'] == key]
            continue
        stage.append({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                      'span_id': sp.id if sp else None, 'value': f'{key}={value}' if value else '',
                      'field': FEATURES, 'feature': key, 'document_id': doc.id, 'ref': ref,
                      'label': f'{key}={value}' if value else f'remove {key}'})
    return stage, drop


def _stage_features(ws: Workspace, changes: List[tuple]) -> List[str]:
    """Stage every word's feature ops as one batch, then drop the planned adds
    a removal undoes. The refs of the words that change, in order."""
    ws.add_ops([op for _ref, stage, _drop in changes for op in stage])
    dropped = {id(op) for _ref, _stage, drop in changes for op in drop}
    if dropped:
        ws.ops[:] = [op for op in ws.ops if id(op) not in dropped]
    return [ref for ref, stage, drop in changes if stage or drop]


def _set_features(ws: Workspace, doc: UdDoc, layer_id: str, refs, value: str) -> str:
    """set_field on features: the word's whole FEATS becomes ``value``. Each
    pair is its own span, so this writes the pairs that differ and removes
    the ones ``value`` leaves out."""
    # A read prints "_" for a word with no features, as CoNLL-U does.
    pairs = _pairs('' if value.strip() == '_' else value)
    for k, v in pairs.items():
        _check_feature(ws, k, v)
    words = _words(ws, doc, refs)
    changes = []
    for w in words:
        planned = _planned_features(ws, layer_id, w)
        want: Dict[str, Optional[str]] = {k: None for k in planned if k not in pairs}
        want.update(pairs)
        stage, drop = _feature_ops(ws, doc, layer_id, w, want)
        changes.append((word_ref(ws.sentence_of(doc, w), w), stage, drop))
    changed = _stage_features(ws, changes)
    bundle = '|'.join(sorted((f'{k}={v}' for k, v in pairs.items()), key=feats_order))
    if not changed:
        return (f'Nothing to change: features are already "{bundle}" on every word named.' if bundle
                else 'Nothing to change: none of the words named has features.')
    what = f'features = "{bundle}"' if bundle else 'features cleared'
    return f'Planned {what} on {len(changed)} word(s): ' + ', '.join(changed)


def t_set_feature(ws: Workspace, document: str = None, refs=None, feature: str = None,
                  value: str = None) -> str:
    """PLAN: one Feature=Value on each word named, leaving its other features
    as they are. set_field on features replaces them all."""
    feature = (feature or '').strip()
    if not feature or '=' in feature or '|' in feature:
        raise ToolError('Give feature: one feature name, like Number (the value goes in value).')
    value = '' if value is None else unmark(str(value), 'value').strip()
    if value:
        refusal = feature_refusal(f'{feature}={value}')
        if refusal or '|' in value:
            raise ToolError(refusal or 'Give value: one value, like Sing. Set each feature on its own.')
    _check_feature(ws, feature, value)
    doc = ws.doc(document)
    layer_id = ws.project.layer(FEATURES)
    words = _words(ws, doc, refs)
    changes = []
    for w in words:
        stage, drop = _feature_ops(ws, doc, layer_id, w, {feature: value or None})
        changes.append((word_ref(ws.sentence_of(doc, w), w), stage, drop))
    changed = _stage_features(ws, changes)
    if not changed:
        return (f'Nothing to change: {feature}={value} is already set on every word named.' if value
                else f'Nothing to change: none of the words named has {feature}.')
    what = f'{feature}={value}' if value else f'{feature} removed'
    return f'Planned {what} on {len(changed)} word(s): ' + ', '.join(changed)


def _head_id(head) -> int:
    """The head argument as a word number.

    Every other argument in this module is a reference, so a model reaches for
    one ("w3", "s3.w3") before it reaches for a bare number, and int() answered
    that with its own error text. `core.args.whole` is the one reader of a
    number a model wrote: it refuses a fraction rather than truncating it (2.7
    is not word 2), refuses True, and refuses "\u00b2", which `isdigit` calls a
    digit and `int` then complains about in Python's own words.
    """
    try:
        return whole(head, 'head')
    except ValueError:
        raise ToolError(f'"{head}" is not a head. Give the number the head word carries within its own sentence '
                        '(1, 2, 3 …), or 0 for the root. It is a plain number, not a reference.') from None


def t_set_head(ws: Workspace, document: str = None, ref: str = None, head=None,
               deprel: str = None) -> str:
    doc = ws.doc(document)
    word = _words(ws, doc, [ref])[0]
    sentence = ws.sentence_of(doc, word)
    if head is None:
        raise ToolError('Give head: the CoNLL-U id of the head word in the same sentence, or 0 for the root.')
    head = _head_id(head)
    if head and sentence.word(head) is None:
        raise ToolError(f'Sentence s{sentence.index} has no word {head}. Its words are 1 to {len(sentence.words)}.')
    if head == word.index:
        raise ToolError(f'A word cannot be its own head. Use head 0 to make {ref} the root of s{sentence.index}.')
    deprel = unmark(deprel or '', 'deprel').strip()
    if head == 0 and not deprel:
        deprel = 'root'
    if not deprel:
        raise ToolError('Give deprel: the relation label, e.g. nsubj, obj, det.')
    if head == 0 and deprel != 'root':
        raise ToolError(f'Head 0 is the sentence root, whose deprel is "root", not "{deprel}".')
    if head != 0 and deprel == 'root':
        raise ToolError('The deprel "root" belongs to head 0. Give the head word\'s id.')
    head_word = sentence.word(head) if head else word
    lemma, head_lemma = word.fields.get('lemma'), head_word.fields.get('lemma')
    # The suppressors this write leaves stranded: the one over the relation it
    # replaces, and one already lying over the pair it creates, which would
    # otherwise leave the new relation faded and the word with no enhanced
    # head. The editor's `createRelation` clears both. A RELABEL (same head)
    # strands nothing: the pair stays, and so does whatever the enhanced graph
    # says about it, as in the editor's `updateRelation`.
    relabel = bool(word.relation_id) and word.head == head
    stale = [] if relabel else [
        word.suppressor_id,
        doc.suppressor_over(head_lemma.id if head_lemma else None, lemma.id if lemma else None)]
    ws.add_op({'kind': 'set_head', 'word_id': word.id, 'head_id': head_word.id,
               'lemma_layer_id': ws.project.layer('lemma'),
               'relation_layer_id': ws.project.relation_layer_id,
               'word_form': word.form, 'head_form': head_word.form,
               # A dependency hangs off the lemma spans, so a word with no
               # lemma yet needs one made before the relation can exist.
               'lemma_span_id': lemma.id if lemma else None,
               'head_lemma_span_id': head_lemma.id if head_lemma else None,
               'relation_id': word.relation_id, 'deprel': deprel, 'document_id': doc.id,
               'suppressor_ids': [i for i in dict.fromkeys(stale) if i],
               'label': (f'{word_ref(sentence, word)} root' if head == 0
                         else f'{word_ref(sentence, word)} {deprel} of word {head}'),
               'ref': word_ref(sentence, word)})
    if head == 0:
        return f'Planned {word_ref(sentence, word)} ("{word.form}") as the root of s{sentence.index}.'
    return (f'Planned {word_ref(sentence, word)} ("{word.form}") as {deprel} of '
            f'word {head} ("{head_word.form}").')


def t_del_relation(ws: Workspace, document: str = None, refs=None) -> str:
    doc = ws.doc(document)
    words = _words(ws, doc, refs)
    headless = [w for w in words if not w.relation_id]
    if len(headless) == len(words):
        return 'Nothing to remove: ' + ', '.join(
            word_ref(ws.sentence_of(doc, w), w) for w in words) + ' already have no head.'
    ws.add_ops([{'kind': 'del_relation', 'word_id': w.id, 'relation_id': w.relation_id,
                 'document_id': doc.id,
                 # The suppressor over it goes with it (see Word.suppressor_id).
                 'suppressor_ids': [w.suppressor_id] if w.suppressor_id else [],
                 'label': f'remove the head of {word_ref(ws.sentence_of(doc, w), w)}',
                 'ref': word_ref(ws.sentence_of(doc, w), w)}
                for w in words if w.relation_id])
    n = len(words) - len(headless)
    return f'Planned removing the head of {n} word(s).'


# --- review -------------------------------------------------------------------
#
# Named words get one op per value. A whole document gets ONE op, a scope
# (the document and the fields), found again at approval: see review.py.

def _review_fields(field: str) -> List[str]:
    fields = [field] if field else list(REVIEW_FIELDS)
    for f in fields:
        if f not in REVIEW_FIELDS:
            raise ToolError(f'Unknown field "{f}". One of: ' + ', '.join(REVIEW_FIELDS))
    return fields


def _named(ws: Workspace, doc: UdDoc, refs) -> List[tuple]:
    words = _words(ws, doc, refs)
    return [(ws.sentence_of(doc, w), w) for w in words]


def _whole_document(ws: Workspace, doc: UdDoc) -> List[tuple]:
    """Every word, with the refusals `_words` would have made. The scope op
    this feeds is refused against a reshape of the same document when it is
    staged, which is where every other path into that rule goes too."""
    _guards(ws, doc)
    return all_words(doc)


def _scope_fields(ws: Workspace, kind: str, doc: UdDoc, fields: List[str]) -> List[str]:
    """The fields a scope op on this document ends up covering: a second call
    widens the first rather than replacing it (add_op replaces by target)."""
    for op in ws.ops:
        if op.get('kind') == kind and op.get('document_id') == doc.id:
            return [f for f in REVIEW_FIELDS if f in set(op.get('fields') or []) | set(fields)]
    return fields


def _refs_need_a_document(document, refs) -> None:
    """A reference is positional inside one document, so refs without a
    document to read them against are a request that cannot be answered."""
    if refs and not document:
        raise ToolError('refs need a document')


def _scope_documents(ws: Workspace, documents, kind: str, fields: List[str]) -> List[str]:
    """The document ids a many-document review covers: the ones named, or
    every document with something waiting when ``documents`` is "all"."""
    if isinstance(documents, list) and len(documents) == 1 and str(documents[0]).strip().lower() == 'all':
        documents = 'all'
    if isinstance(documents, str) and documents.strip().lower() == 'all':
        c = ws.corpus
        stamps = [{'prov': 'inferred'}] + ([{'prov': 'contributed'}] if kind == 'confirm' else [])
        ids: List[str] = []
        for f in fields:
            for stamp in stamps:
                # A head is a relation, not a span, so it is found on its own
                # layer. Skipping it meant confirm(documents=["all"],
                # field="deprel") always answered that nothing was waiting.
                if f == 'deprel':
                    where = [c.dep('?s', metadata=stamp), c.unconfirmed_relation('?s')]
                else:
                    where = [c.field(f, '?s', metadata=stamp), c.unconfirmed('?s')]
                for did, _n in c.documents_with(where, '?s'):
                    if did not in ids:
                        ids.append(did)
        if not ids:
            raise ToolError('Nothing is waiting for review anywhere in the project.')
    else:
        if isinstance(documents, str):
            documents = [documents]
        ids = []
        for d in documents or []:
            did = ws.resolve_document_id(str(d))
            if did not in ids:
                ids.append(did)
        if not ids:
            raise ToolError('Name the documents as a list, or "all" for every document with something waiting.')
    if len(ids) > MAX_SCOPE_DOCS:
        raise ToolError(f'{len(ids)} documents, more than the {MAX_SCOPE_DOCS} one plan covers. Go in passes: '
                        f'worklist lists them by document.')
    return ids


def _many(ws: Workspace, documents, field: str, one) -> str:
    """Run a one-document review tool over several documents, and sum up.

    All of them or none. A guard firing on the third document used to leave the
    first two staged while the model was told the call had failed, so the user
    was offered changes nobody had described to them.
    """
    fields = _review_fields(field)
    kind = 'confirm' if one is t_confirm else 'discard'
    ids = _scope_documents(ws, documents, kind, fields)
    planned = 0
    per_doc: List[str] = []  # one name per value, for the exact count by document
    with ws.staging():
        for did in ids:
            before = len(ws.ops)
            one(ws, document=did, field=field)
            if len(ws.ops) > before:
                n = ws.ops[-1].get('count') or 0
                planned += n
                # By label, not by name: two documents may share a name.
                per_doc += [doc_label(ws, did)] * n
    if not per_doc:
        return f'Nothing is waiting for review in the {len(ids)} document(s) named.'
    verb = 'confirming' if kind == 'confirm' else 'discarding'
    return (f'Planned {verb} {planned} value(s), one planned change per document. '
            + by_document(per_doc))


def t_confirm(ws: Workspace, document: str = None, refs=None, field: str = None, documents=None) -> str:
    """Mark machine output and contributors' work as reviewed and correct."""
    # refs name words INSIDE one document, so a request that gives refs and
    # several documents means two different things at once. IGT refuses it;
    # here the refs were silently dropped and the card offered whole documents
    # when the model had asked for one word.
    _refs_need_a_document(document, refs)
    if documents and not document:
        return _many(ws, documents, field, t_confirm)
    if not document:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'something waiting.')
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets, left = confirm_targets(_named(ws, doc, refs), fields, ws.project)
        if not targets:
            return (' '.join(x for x in (left_phrase(left), 'Nothing else to confirm.') if x) if left
                    else 'Nothing to confirm: every value named is already a person\'s work or confirmed.')
        staged = []
        for sentence, w, f, span_id, relation_id, state in targets:
            ref = word_ref(sentence, w)
            staged.append({'kind': 'confirm', 'span_id': span_id, 'relation_id': relation_id,
                           'token_id': w.id, 'document_id': doc.id, 'ref': ref,
                           **contributed_work(state),
                           'label': f'confirm the head of {ref}' if f == 'deprel' else f'confirm {f} on {ref}'})
        ws.add_ops(staged)
        return f'Planned confirming {len(targets)} value(s).' + (f' {left_phrase(left)}' if left else '')
    fields = _scope_fields(ws, 'confirm_scope', doc, fields)
    targets, left = confirm_targets(_whole_document(ws, doc), fields, ws.project)
    if not targets:
        return (f'{left_phrase(left)} Nothing else in "{doc.name}" is waiting for review.' if left
                else f'Nothing in "{doc.name}" is waiting for review.')
    counts = per_field(targets)
    off = f', {len(left)} off the list left unconfirmed' if left else ''
    ws.add_op({'kind': 'confirm_scope', 'document_id': doc.id, 'fields': fields,
               'count': len(targets), 'per_field': counts, 'ref': None,
               'label': f'confirm {len(targets)} values in "{doc.name}" ({counts_phrase(counts)}{off})'})
    return (f'Planned confirming {len(targets)} value(s) in "{doc.name}": {counts_phrase(counts)}. '
            f'That is one planned change covering the whole document.'
            + (f' {left_phrase(left)}' if left else ''))


def t_discard_predictions(ws: Workspace, document: str = None, refs=None, field: str = None,
                          documents=None) -> str:
    """Throw away machine output nobody has confirmed. A person's work and a
    confirmed value are never touched."""
    # refs name words INSIDE one document, so a request that gives refs and
    # several documents means two different things at once. IGT refuses it;
    # here the refs were silently dropped and the card offered whole documents
    # when the model had asked for one word.
    _refs_need_a_document(document, refs)
    if documents and not document:
        return _many(ws, documents, field, t_discard_predictions)
    if not document:
        raise ToolError('Name a document, or documents: a list of names, or ["all"] for every document with '
                        'unconfirmed machine values.')
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets, spared = discard_targets(_named(ws, doc, refs), fields)
        staged = []
        for sentence, w, f, span, relation_id in targets:
            ref = word_ref(sentence, w)
            if f == 'deprel':
                staged.append({'kind': 'del_relation', 'word_id': w.id, 'relation_id': relation_id,
                               'document_id': doc.id, 'ref': ref,
                               'suppressor_ids': [w.suppressor_id] if w.suppressor_id else [],
                               'label': f'discard the unconfirmed head of {ref}'})
            else:
                staged.append({'kind': 'set_span', 'layer_id': span.layer_id, 'token_id': w.id,
                               'span_id': span.id, 'value': '', 'field': f, 'document_id': doc.id,
                               'feature': feature_key(f, span.value),
                               'ref': ref, 'label': f'discard the unconfirmed {f} on {ref}'})
        ws.add_ops(staged)
        n = len(targets)
    else:
        fields = _scope_fields(ws, 'discard_scope', doc, fields)
        targets, spared = discard_targets(_whole_document(ws, doc), fields)
        n = len(targets)
        if n:
            counts = per_field(targets)
            ws.add_op({'kind': 'discard_scope', 'document_id': doc.id, 'fields': fields,
                       'count': n, 'per_field': counts, 'ref': None,
                       'label': f'discard {n} unconfirmed machine values in "{doc.name}" '
                                f'({counts_phrase(counts)})'})
    spared_note = f' Left {spared} machine lemma(s) that anchor arcs a person drew.' if spared else ''
    if not n:
        if spared:
            return f'Nothing to discard: {spared} machine lemma(s) here anchor arcs a person drew.'
        return 'Nothing to discard: no unconfirmed machine values here.'
    scope_note = '' if refs else f' That is one planned change covering the whole of "{doc.name}".'
    return f'Planned discarding {n} unconfirmed machine value(s).{spared_note}{scope_note}'


# --- the plan so far -----------------------------------------------------------

# --- running the parser ----------------------------------------------------------
# The odd one out among the plan ops: it does not write anything itself, it
# asks another service to. It is a plan op all the same, because a parse
# rewrites documents and that is exactly the kind of thing a user should be
# approving rather than discovering.

def parse_services(ws: Workspace) -> List[dict]:
    """The parse services currently connected to this project."""
    from plaid_client.services import discover_services
    try:
        seen = discover_services(ws.client, ws.project.id) or []
    except Exception as e:  # noqa: BLE001 - the model reads the server's reason
        raise server_refused('The project\'s services', e)
    return [s for s in seen
            if s.get('online') and 'parse' in ((s.get('extras') or {}).get('tasks') or [])]


def t_run_parse(ws: Workspace, documents=None, language: str = None,
                overwrite: bool = False, service_id: str = None) -> str:
    _no_restore_planned(ws)
    if isinstance(documents, str):
        documents = [documents]
    if not documents:
        raise ToolError('Name the documents to parse, as a list.')
    online = parse_services(ws)
    if not online:
        raise ToolError('No parser is connected to this project right now. A parse cannot be '
                        'planned until the operator starts one.')
    if service_id:
        chosen = next((s for s in online if s.get('service_id') == service_id), None)
        if not chosen:
            raise ToolError(f'No connected parser "{service_id}". Connected: '
                            + ', '.join(s.get('service_id') for s in online))
    elif len(online) > 1:
        raise ToolError('Several parsers are connected; name one in service_id: '
                        + ', '.join(f'{s.get("service_id")} ({s.get("service_name")})' for s in online))
    else:
        chosen = online[0]

    ids = []
    for d in documents:
        did = ws.resolve_document_id(d)
        if did not in ids:
            ids.append(did)   # named twice is parsed once
    if len(ids) > MAX_SCOPE_DOCS:
        raise ToolError(f'{len(ids)} documents, more than the {MAX_SCOPE_DOCS} one plan covers. '
                        f'Go in passes.')
    # Names come from the document LIST, which is already in hand: reading
    # every named document just to write its name into a label cost a full
    # fetch per document, which on a corpus-sized parse is most of the call.
    listed = {d['id']: (d.get('name') or d['id']) for d in ws.documents()}
    # A parse deletes and recreates a document's tokens, spans and relations.
    # Anything else this plan writes into the same document would be thrown
    # away by it, so the two cannot travel together.
    clash = set().union(*(docs_of_op(op) for op in ws.ops)) & set(ids) if ws.ops else set()
    if clash:
        names = ', '.join(f'"{listed.get(i, i)}"' for i in clash)
        raise ToolError(f'This plan already changes {names}, and a parse rewrites a document from '
                        f'scratch, so those changes would be thrown away. Plan the parse on its own, '
                        f'or drop the other changes first (plan_status, drop_planned).')
    lang = (language or ws.project.language or '').strip()
    if not lang:
        raise ToolError('Give language: the project does not record one, and the parser needs to '
                        'know which models to load.')
    names = [listed.get(i, i) for i in ids]
    ws.add_op({'kind': 'run_parse', 'document_ids': ids, 'service_id': chosen.get('service_id'),
               'project_id': ws.project.id, 'language': lang, 'overwrite': bool(overwrite),
               'label': (f'parse {len(ids)} document(s) with {chosen.get("service_name")} ({lang})'
                         + (', overwriting human work' if overwrite else '')),
               'ref': None})
    warn = (' It will overwrite annotations a person made or confirmed.' if overwrite
            else ' Sentences a person made or confirmed are left alone.')
    shown = ', '.join(f'"{n}"' for n in names[:20]) + (f', … {len(names) - 20} more' if len(names) > 20 else '')
    return (f'Planned a parse of {len(ids)} document(s) with {chosen.get("service_name")} '
            f'in {lang}: ' + shown + '.' + warn
            + ' A parse rewrites a document, so it is the only kind of change in this plan.')


def t_add_comment(ws: Workspace, document: str = None, body: str = None, ref: str = None) -> str:
    """PLAN: a note on a sentence or on the document."""
    body = (body or '').strip()
    if not body:
        raise ToolError('Give body: the text of the note.')
    if len(body) > 10000:
        raise ToolError('A comment holds at most 10000 characters.')
    doc = ws.doc(document)
    # The same three refusals every other edit to a document owes. This had
    # one of them, so a comment could be anchored on a sentence token that a
    # parse or a boundary move in the same plan deletes.
    _guards(ws, doc)
    if ref:
        thing = resolve(doc, str(ref))
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence (s3) or on the document.')
        entity_type, entity_id = 'token', thing.id
        anchor = f's{thing.index}: {thing.text[:120]}'
        where = f's{thing.index}'
    else:
        entity_type, entity_id, anchor, where = 'document', doc.id, doc.name, None
    short = body[:60] + ('…' if len(body) > 60 else '')
    ws.add_op({'kind': 'add_comment', 'entity_type': entity_type, 'entity_id': entity_id, 'body': body,
               'anchor_label': anchor[:200], 'document_id': doc.id, 'ref': where,
               'label': f'comment on {where or "the document"}: "{short}"'})
    return f'Planned a comment on {where or "the document"} of "{doc.name}".'
