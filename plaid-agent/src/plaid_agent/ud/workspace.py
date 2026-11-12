"""The workspace a UD assistant's tools run against: what one turn has
loaded and the plan it is building, with the refusals only this app owes
when something is staged (:mod:`.tools` holds the tools).
"""

import copy
from typing import Any, Dict, List, Optional

from ..core import docload, opkind
from ..core.bidi import qname, qv
from ..core.history import doc_label, plain_quote
from ..core.workspace import BaseWorkspace
from ..core.refs import clip
from ..core.tools import ToolError
from .plan import KIND, RESHAPES_TOKEN, docs_of_op, scope_clears
from .project import (Sentence, UdDoc, UdProject, Word, by_stored_sent_id, is_virtual, load_document,
                      render_document, resolve, virtual_at, word_ref)

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ("A whole document's review (confirm or discard_predictions without refs) counts as one "
             "change however many values it covers.")
# Ops that stand for everything a predicate matches (a document and a set of
# fields, or a field and a pattern) and are resolved to spans when the plan is
# applied. Every kind that declares how to resolve itself, so a new one joins
# by being declared.
SCOPE_KINDS = opkind.scopes(KIND)
# The token reshape that deletes no word, so a scope over its document may
# share its plan (UD.md, 2026-10-16).
SPLITS_KEEP_WORDS = frozenset({'split_token'})
# The most documents one review may cover when several are named or all
# are asked for: each is read to count what is waiting, and read again at
# approval.

# Parsed documents, shared across turns and users of this process. See
# plaid_agent.core.docload for what the key covers and what it does not.
_DOC_CACHE = docload.DocCache()


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
        return render_document(doc, label=doc_label(self, doc.id, plain_quote), **kw)

    def sentence_position(self, doc, item) -> Optional[int]:
        return by_stored_sent_id(doc, item)

    def entity_index(self, doc) -> Dict[str, Any]:
        """Everything that carries provenance, a word's basic relation
        included, which the parsed word holds by id beside its metadata."""
        index = super().entity_index(doc)
        for s in doc.sentences:
            for w in s.words:
                if w.relation_id and w.relation_id not in index:
                    index[w.relation_id] = w.relation_metadata
        return index

    def comment_placed(self, doc: 'UdDoc', ref, field, short: str) -> Dict[str, Any]:
        # The same refusals every other edit to a document owes: a parse or a
        # boundary move in the same plan renumbers or rewrites what ``ref``
        # names.
        from .tools import _guards
        _guards(self, doc)
        if field:
            raise ToolError('A comment here sits on a sentence or on the document, never on one value.',
                            kind='invalid-argument')
        if not ref:
            return {'entity_type': 'document', 'entity_id': doc.id, 'anchor_label': (doc.name or '')[:200],
                    'ref': None, 'label': f'comment on the document: {qv(short)}'}
        thing = doc.sentences[[s.id for s in doc.sentences].index(self.comment_anchor(doc, str(ref)))]
        where = f's{thing.index}'
        return {'entity_type': 'token', 'entity_id': thing.id, 'anchor_label': f'{where}: {thing.text[:120]}'[:200],
                'ref': where, 'label': f'comment on {where}: {qv(short)}'}

    def comment_anchor(self, doc: 'UdDoc', ref: str) -> str:
        # A sentence's comments hang off its token.
        thing = resolve(doc, ref)
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence or on '
                            f'the document.', kind='invalid-argument')
        return thing.id

    def __init__(self, client, project: UdProject, on_progress=None):
        super().__init__(client, project, on_progress)
        # What each replacement of the plan found, by its target, so a value
        # two of them change is counted once, on the later (settle.py).
        self.replace_found: Dict[tuple, List[Dict[str, Any]]] = {}

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
        doc = self._docs[did]
        doc.label = doc_label(self, did, qname)
        return doc

    def word(self, document: str, ref: str):
        """The sentence, word or multi-word token a reference names."""
        return resolve(self.doc(document), ref)

    def sentence_of(self, doc: UdDoc, w: Word) -> Sentence:
        for s in doc.sentences:
            if any(x is w for x in s.words):
                return s
        raise ToolError('internal: word not in document', kind='tool-fault')

    # --- the plan --------------------------------------------------------

    def add_op(self, op: Dict[str, Any]) -> None:
        self.place_virtual(op)
        super().add_op(op)

    def place_virtual(self, op: Dict[str, Any]) -> None:
        """Note on ``op`` where the UD word of each stand-in it writes to is
        made (``virtual_at`` for its word, ``head_virtual_at`` for a head
        another than it), read from the document as the tool read it: the word
        is stored nowhere, so the executor makes it from this when the plan is
        applied, in the write's own batch."""
        keys = {'set_span': (('token_id', 'virtual_at'),),
                'set_head': (('word_id', 'virtual_at'), ('head_id', 'head_virtual_at'))}.get(op.get('kind'), ())
        for key, at in keys:
            wid = op.get(key)
            if not is_virtual(wid) or op.get(at) or (key == 'head_id' and wid == op.get('word_id')):
                continue
            doc = self.doc(op['document_id'])
            word = next((w for s in doc.sentences for w in s.words if w.id == wid), None)
            if word is None:
                raise ToolError(f'{op.get("label") or "That change"}: the word it is on was not read in this turn',
                                kind='conflict')
            op[at] = virtual_at(self.project, doc, word)

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        super().guard_op(op, replacing=replacing)
        self.refuse_scope_clash(op, replacing=replacing)
        self.refuse_reshape_clash(op, replacing=replacing)
        self.refuse_cycle(op, replacing=replacing)

    def staged_values(self, op: Dict[str, Any]) -> List[tuple]:
        if op.get('kind') == 'set_span':
            return [(op.get('layer_id'), op.get('value'))]
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
            # Say what the cycle is and nothing more. It once ended "Give the
            # head word another head first", and the model did just that to a
            # word the user had said to leave alone.
            names = {w.id: f'{word_ref(sentence, w)} "{clip(w.form)}"' for w in sentence.words}
            path, at = [], op['head_id']
            while at is not None and at != op['word_id'] and at not in path:
                path.append(at)
                at = heads.get(at)
            word = names.get(op['word_id'], op.get('ref') or 'That word')
            head = names.get(op['head_id'], 'that head')
            chain = ' -> '.join(names.get(i, '?') for i in [*path, op['word_id']])
            raise ToolError(f'{word} cannot take {head} as its head: {head} hangs below it, through the heads '
                            f'{chain} (each word, then its head, with the heads this plan gives), so the tree '
                            'would hold a cycle. Nothing was planned. Any other head that would change is the '
                            'user\'s to ask for.', kind='conflict')

    def exclusive_message(self, staging_it: bool) -> str:
        if staging_it:
            return ('A restore must be a plan of its own, since it rewrites every layer of the '
                    'document. Discard the plan first (discard_plan), or let the user approve it '
                    'and ask for the restore afterwards.')
        return ('This plan restores a document, and a restore rewrites every layer of '
                'it, so nothing else can share the plan. Apply it on its own, then '
                'plan the rest against what it restored.')

    def clash_message(self, victim: Dict[str, Any], killer: Optional[Dict[str, Any]]) -> str:
        """Reshaping a token deletes and remakes its words, so the words it
        takes with it are worth naming: the registry's own wording says only
        that one change writes to what another deletes."""
        if (killer or {}).get('kind') in RESHAPES_TOKEN:
            forms = ' + '.join(f'"{clip(f)}"' for f in killer.get('forms') or [])
            return ('This plan both reshapes a token and writes to one of its words, and the '
                    'reshape deletes that word'
                    + (f' and makes {forms} in its place' if forms else '') + '. '
                    + PLANNED_WORDS_LATER + ' Or keep one of the two (discard_plan and stage the rest again).')
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
                                '(discard_plan and stage the rest again), or plan them in separate turns.',
                                kind='conflict')
            # A split deletes no word: each keeps its id and its values, so a
            # scope over the document finds them as it would without it.
            other = SCOPE_KINDS if kind not in SPLITS_KEEP_WORDS else ()
        else:
            other = tuple(k for k in RESHAPES_TOKEN if k not in SPLITS_KEEP_WORDS)
        reach = docs_of_op(op)
        if any(prev.get('kind') in other and docs_of_op(prev) & reach for prev in planned):
            raise ToolError('This plan both reshapes a token and changes every matching word of '
                            'its document, and the reshape deletes some of them. Keep one of the '
                            'two (discard_plan and stage the rest again), or plan them in separate turns.',
                            kind='conflict')

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
                'covers, and one of the two throws values away. Keep one of them '
                '(discard_plan and stage the rest again), or plan them in separate turns.', kind='conflict')

    def plan_view(self) -> List[Dict[str, Any]]:
        from .settle import settle_scopes
        settle_scopes(self)
        return self.ops

    def settle_for_payload(self) -> List[Dict[str, Any]]:
        from ..core.plan import compact_ops
        from .settle import digested, settle_scopes
        # Each discard or replacement counted as approval writes it: less
        # what the plan names or keeps.
        settle_scopes(self)
        return compact_ops(digested(self, self.mark_replaced_work(copy.deepcopy(self.ops))), compact_spec(self))

    def describe_changes(self, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # A replace's card row was built when it was staged and goes in
        # `changes` only.
        from .changes import describe_changes
        return describe_changes(self, ops)

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        from .plan import summarize
        return summarize(ops)

    def payload_extra(self, ops: List[Dict[str, Any]]) -> Dict[str, Any]:
        from .settle import FOUND
        for op in ops:
            (op.get(FOUND) or {}).pop('card', None)
        return {}


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


#: What to do about a word a planned reshape makes, said by every refusal that
#: meets one. A plan names words by the ids they have now, and these have none
#: until the plan runs.
PLANNED_WORDS_LATER = ('A plan cannot write to words it is still making: once the user approves this '
                       'plan they are ordinary words, so annotate them in the next plan.')
