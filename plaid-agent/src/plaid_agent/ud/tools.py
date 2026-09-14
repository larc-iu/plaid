"""The tools a UD assistant may call, and the workspace they run against.

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3.w2``), never by id: see
:mod:`.project` for why, and for what a UD project is shaped like.
"""

import copy
import re
import uuid
from typing import Any, Dict, List, Optional

from ..core import opkind
from ..core.args import clamp_limit, read_int, sentence_number
from ..core.limits import MAX_RESULT_CHARS, READ_LIMITS
from ..core.workspace import BaseWorkspace
from ..core.tools import ToolError
from .plan import (COMPACT, EXCLUSIVE_KINDS, KIND,  # noqa: F401 - COMPACT is re-exported for the tests
                   RESHAPES_DOCUMENT, RESHAPES_TOKEN, REWRITES_DOCUMENT, docs_of_op, scope_clears)
from .project import (Sentence, Token, UdDoc, UdProject, Word, load_document, render_document,
                      resolve, word_ref)
from .review import (REVIEW_FIELDS, all_words, confirm_targets, counts_phrase, discard_targets,
                     per_field)

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ("A whole document's review (confirm or discard_predictions without refs) counts as one "
             "change however many values it covers.")
# Ops that stand for everything a predicate matches (a document and a set of
# fields, or a field and a pattern) and are resolved to spans when the plan is
# applied. Read off the registry, so a new one joins by being declared.
SCOPE_KINDS = opkind.shaped(KIND, opkind.SCOPE)
# The most documents one review may cover when several are named or all
# are asked for: each is read to count what is waiting, and read again at
# approval.
MAX_SCOPE_DOCS = 100




# --- the workspace ------------------------------------------------------------

class Workspace(BaseWorkspace):
    """One turn's view of a treebank project: what it has loaded and the plan
    it is proposing."""

    KIND = KIND
    PLAN_NOTE = PLAN_NOTE
    SPAN_KIND = 'set_span'

    def __init__(self, client, project: UdProject, on_progress=None):
        super().__init__(client, project, on_progress)

    def make_corpus(self):
        from .corpus import Corpus
        return Corpus(self)

    def doc(self, document: str) -> UdDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            # Name it the way the user would: a corpus-wide tool passes an id,
            # and "Reading 019ed0b8-…" tells a watcher nothing.
            entry = next((d for d in self.documents() if d['id'] == did), {})
            self.on_progress(f'Reading "{entry.get("name") or document}"…')
            self._docs[did] = load_document(self.client, self.project, did)
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
        _no_restore_planned(self)
        self.refuse_scope_clash(op, replacing=replacing)
        self.refuse_reshape_clash(op, replacing=replacing)

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
        ops = compact_ops(copy.deepcopy(self.ops), COMPACT)
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in ops], 'ops': ops,
                'changes': describe_changes(self, ops),
                'documents': self.touched_documents()}

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan refers to, with the version each was read at,
        so approval can refuse a plan made against data that has moved on."""
        out = []
        listed = {d['id']: d for d in self.documents()}
        touched = []
        for op in self.ops:
            for did in sorted(docs_of_op(op)):
                if did not in touched:
                    touched.append(did)
        for did in touched:
            doc = self._docs.get(did)
            if doc is not None:
                out.append({'id': did, 'name': doc.name, 'version': doc.version})
            elif did in listed:
                # Matched by a corpus-wide op without being read: the list
                # carries its version, which is all the stale check needs.
                out.append({'id': did, 'name': listed[did].get('name'), 'version': listed[did].get('version')})
        return out


def op_target(op: Dict[str, Any]):
    """What an op writes, for deduping within one turn. Each kind declares its
    own; an op that can supersede nothing (a comment, a structural change) has
    none."""
    return opkind.target_of(KIND, op)


def _truncate(s: str) -> str:
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS] + (f'\n... [truncated: {len(s) - MAX_RESULT_CHARS} more characters; '
                                   f'narrow the request]')


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
    for d in docs[:50]:
        out.append(f'  "{d.get("name")}"')
    if len(docs) > 50:
        out.append(f'  ... and {len(docs) - 50} more (list_documents pages through them)')
    return '\n'.join(out)


def t_list_documents(ws: Workspace, pattern: str = None, limit: int = 50, offset: int = 0) -> str:
    docs = ws.documents()
    if pattern:
        docs = [d for d in docs if pattern.lower() in (d.get('name') or '').lower()]
    if not docs:
        return 'No documents matched.' if pattern else 'The project has no documents.'
    limit = clamp_limit(limit, *READ_LIMITS['list_documents'])
    offset = read_int(offset, 'offset', 0, minimum=0)
    page = docs[offset:offset + limit]
    out = [f'{len(docs)} document(s)' + (f' matching "{pattern}"' if pattern else '')
           + (f', showing {offset + 1} to {offset + len(page)}' if len(docs) > len(page) else '') + ':']
    for d in page:
        out.append(f'  "{d.get("name")}"')
    return '\n'.join(out)


MAX_SENTENCES_PER_READ = 40


def _sentence_numbers(sentences) -> List[int]:
    """The sentence numbers a ``sentences`` argument names. Accepts what a read
    prints and what a search returns: 34, "34", "s34", and "s34.w2" (the word's
    sentence), in any mix."""
    out: List[int] = []
    for item in (sentences if isinstance(sentences, list) else [sentences]):
        n = sentence_number(item, 'sentences')
        if n is not None and n not in out:
            out.append(n)
    return out


def t_read_document(ws: Workspace, document: str = None, from_sentence: int = None,
                    to_sentence: int = None, sentences=None) -> str:
    doc = ws.doc(document)
    budget = MAX_RESULT_CHARS - 100
    # Named sentences beat a range: a reader that already knows where to look
    # should not have to page a long document to get there.
    if sentences:
        picked = _sentence_numbers(sentences)[:MAX_SENTENCES_PER_READ]
        return _truncate(render_document(doc, indexes=picked, budget=budget))
    lo = max(1, sentence_number(from_sentence, 'from_sentence') or 1)
    hi = sentence_number(to_sentence, 'to_sentence') or min(len(doc.sentences), lo + MAX_SENTENCES_PER_READ - 1)
    if hi - lo + 1 > MAX_SENTENCES_PER_READ:
        hi = lo + MAX_SENTENCES_PER_READ - 1
    return _truncate(render_document(doc, from_sentence=lo, to_sentence=hi, budget=budget))


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
    plan. The set is the registry's EXCLUSIVE tag rather than a kind name, so
    a second kind that owns its plan is refused by declaring itself. The check
    looks FORWARD as well as back: refusing only when the exclusive op is
    planned second would let an edit slip in after one."""
    for op in ws.ops:
        if op.get('kind') in EXCLUSIVE_KINDS:
            raise ToolError('This plan restores a document, and a restore rewrites every layer of '
                            'it, so nothing else can share the plan. Apply it on its own, then '
                            'plan the rest against what it restored (plan_status, drop_planned).')


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


def _check_value(ws: Workspace, field: str, value: str) -> None:
    """Refuse a value a CLOSED vocabulary does not list. An open one takes
    anything: an off-list value there is a finding, not an error."""
    if not value:
        return
    key = {'upos': 'upos', 'xpos': 'xpos'}.get(field)
    if not key or ws.project.modes.get(key) != 'closed':
        return
    allowed = ws.project.vocab.get(key) or []
    if allowed and value not in allowed:
        raise ToolError(f'"{value}" is not in this project\'s {field} vocabulary, which is closed. '
                        f'Allowed: ' + ', '.join(allowed))


def t_set_field(ws: Workspace, document: str = None, refs=None, field: str = None,
                value: str = None) -> str:
    doc = ws.doc(document)
    layer_id = _field_layer(ws, field)
    value = '' if value is None else str(value)
    _check_value(ws, field, value)
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


def _features(bundle: str) -> List[tuple]:
    """A FEATS string as (feature, value) pairs, in the order written."""
    out = []
    for pair in (bundle or '').split('|'):
        if pair and '=' in pair:
            k, v = pair.split('=', 1)
            out.append((k, v))
        elif pair:
            out.append((pair, ''))
    return out


def _bundle(pairs: List[tuple]) -> str:
    """Pairs as a FEATS string, ordered as CoNLL-U orders them: by feature,
    case-insensitively."""
    return '|'.join(f'{k}={v}' if v else k for k, v in sorted(pairs, key=lambda kv: kv[0].casefold()))


def t_set_feature(ws: Workspace, document: str = None, refs=None, feature: str = None,
                  value: str = None) -> str:
    """PLAN: one Feature=Value inside the FEATS bundle, leaving the rest as
    they are. set_field on features replaces the whole bundle."""
    feature = (feature or '').strip()
    if not feature or '=' in feature or '|' in feature:
        raise ToolError('Give feature: one feature name, like Number (the value goes in value).')
    value = '' if value is None else str(value).strip()
    inventory = ws.project.vocab.get('feats') or {}
    if inventory and ws.project.modes.get('feats') == 'closed' and value:
        if feature not in inventory:
            raise ToolError(f'"{feature}" is not in this project\'s feature inventory, which is closed. '
                            f'Features: ' + ', '.join(sorted(inventory)))
        allowed = inventory.get(feature) or []
        if allowed and value not in allowed:
            raise ToolError(f'"{value}" is not a value of {feature} here. Allowed: ' + ', '.join(allowed))
    doc = ws.doc(document)
    layer_id = ws.project.layer('features')
    words = _words(ws, doc, refs)
    staged, changed = [], []
    for w in words:
        current = ws.planned_value(layer_id, w.id, w.value('features'))
        pairs = [(k, v) for k, v in _features(current) if k != feature]
        if value:
            pairs.append((feature, value))
        new = _bundle(pairs)
        if new == current:
            continue
        sp = w.fields.get('features')
        ref = word_ref(ws.sentence_of(doc, w), w)
        staged.append({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                       'span_id': sp.id if sp else None, 'value': new, 'field': 'features',
                       'document_id': doc.id, 'ref': ref,
                       'label': f'{feature}={value}' if value else f'remove {feature}'})
        changed.append(ref)
    ws.add_ops(staged)
    if not changed:
        return (f'Nothing to change: {feature}={value} is already set on every word named.' if value
                else f'Nothing to change: none of the words named has {feature}.')
    what = f'{feature}={value}' if value else f'{feature} removed'
    return f'Planned {what} on {len(changed)} word(s): ' + ', '.join(changed)


def _head_id(head) -> int:
    """The head argument as a word number.

    Every other argument in this module is a reference, so a model reaches for
    one ("w3", "s3.w3") before it reaches for a bare number, and int() answered
    that with its own error text. A number with a fraction is refused rather
    than truncated: 2.7 is not word 2.
    """
    if isinstance(head, int) and not isinstance(head, bool):
        return head
    if isinstance(head, float) and head.is_integer():
        return int(head)
    text = str(head).strip()
    # `isdigit` is true of "\u00b2" and of the digits in "--1", and int() then
    # answered the model with its own error text, which is the symptom this
    # helper exists to remove.
    if re.fullmatch(r'-?[0-9]+', text):
        return int(text)
    raise ToolError(f'"{head}" is not a head. Give the number the head word carries within its own sentence '
                    '(1, 2, 3 …), or 0 for the root. It is a plain number, not a reference.')


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
    deprel = (deprel or '').strip()
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
    ws.add_op({'kind': 'set_head', 'word_id': word.id, 'head_id': head_word.id,
               'lemma_layer_id': ws.project.layer('lemma'),
               'relation_layer_id': ws.project.relation_layer_id,
               'word_form': word.form, 'head_form': head_word.form,
               # A dependency hangs off the lemma spans, so a word with no
               # lemma yet needs one made before the relation can exist.
               'lemma_span_id': lemma.id if lemma else None,
               'head_lemma_span_id': head_lemma.id if head_lemma else None,
               'relation_id': word.relation_id, 'deprel': deprel, 'document_id': doc.id,
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
    saved, saved_replaced, saved_reported = list(ws.ops), ws.replaced, ws.reported_replaced
    planned = 0
    covered = []
    try:
        for did in ids:
            before = len(ws.ops)
            one(ws, document=did, field=field)
            if len(ws.ops) > before:
                planned += ws.ops[-1].get('count') or 0
                covered.append(ws.doc(did).name)
    except Exception:
        ws.ops[:] = saved
        ws.replaced = saved_replaced
        ws.reported_replaced = saved_reported
        raise
    if not covered:
        return f'Nothing is waiting for review in the {len(ids)} document(s) named.'
    verb = 'confirming' if kind == 'confirm' else 'discarding'
    return (f'Planned {verb} {planned} value(s) across {len(covered)} document(s), one planned change '
            f'each: ' + ', '.join(f'"{n}"' for n in covered[:20])
            + (f', … {len(covered) - 20} more' if len(covered) > 20 else '') + '.')


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
        targets = confirm_targets(_named(ws, doc, refs), fields)
        if not targets:
            return 'Nothing to confirm: every value named is already a person\'s work or confirmed.'
        staged = []
        for sentence, w, f, span_id, relation_id in targets:
            ref = word_ref(sentence, w)
            staged.append({'kind': 'confirm', 'span_id': span_id, 'relation_id': relation_id,
                           'token_id': w.id, 'document_id': doc.id, 'ref': ref,
                           'label': f'confirm the head of {ref}' if f == 'deprel' else f'confirm {f} on {ref}'})
        ws.add_ops(staged)
        return f'Planned confirming {len(targets)} value(s).'
    fields = _scope_fields(ws, 'confirm_scope', doc, fields)
    targets = confirm_targets(_whole_document(ws, doc), fields)
    if not targets:
        return f'Nothing in "{doc.name}" is waiting for review.'
    counts = per_field(targets)
    ws.add_op({'kind': 'confirm_scope', 'document_id': doc.id, 'fields': fields,
               'count': len(targets), 'per_field': counts, 'ref': None,
               'label': f'confirm {len(targets)} values in "{doc.name}" ({counts_phrase(counts)})'})
    return (f'Planned confirming {len(targets)} value(s) in "{doc.name}": {counts_phrase(counts)}. '
            f'That is one planned change covering the whole document.')


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
                               'label': f'discard the unconfirmed head of {ref}'})
            else:
                staged.append({'kind': 'set_span', 'layer_id': span.layer_id, 'token_id': w.id,
                               'span_id': span.id, 'value': '', 'field': f, 'document_id': doc.id,
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

def t_plan_status(ws: Workspace) -> str:
    if not ws.ops:
        return 'Nothing is planned yet.'
    out = [f'{len(ws.ops)} change(s) planned. The user approves or discards them as one plan.']
    for i, op in enumerate(ws.ops, start=1):
        where = f' ({op["ref"]})' if op.get('ref') else ''
        out.append(f'  {i}. {op.get("label")}{where}')
    return '\n'.join(out)


def t_discard_plan(ws: Workspace) -> str:
    n = len(ws.ops)
    ws.ops.clear()
    return f'Discarded {n} planned change(s).' if n else 'Nothing was planned.'


def _whole(i) -> int:
    """One plan index. A fraction is refused rather than truncated: 1.5 is not
    change 1, and silently dropping change 1 for it is worse than a refusal."""
    if isinstance(i, bool):
        raise ValueError(i)
    if isinstance(i, int):
        return i
    if isinstance(i, float):
        if not i.is_integer():
            raise ValueError(i)
        return int(i)
    if re.fullmatch(r'-?[0-9]+', str(i).strip()):
        return int(str(i).strip())
    raise ValueError(i)


def t_drop_planned(ws: Workspace, indexes=None) -> str:
    if not indexes:
        raise ToolError('Give indexes: the numbers plan_status shows, as a list.')
    try:
        drop = {_whole(i) for i in indexes}
    except (TypeError, ValueError):
        raise ToolError('indexes must be the whole numbers plan_status shows, as a list, e.g. [2, 5].')
    bad = [i for i in drop if not 1 <= i <= len(ws.ops)]
    if bad:
        raise ToolError(f'No planned change numbered {", ".join(str(b) for b in bad)}. '
                        f'{len(ws.ops)} are planned.')
    ws.ops[:] = [op for i, op in enumerate(ws.ops, start=1) if i not in drop]
    return f'Dropped {len(drop)} planned change(s). {len(ws.ops)} remain.'


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
    except Exception as e:  # noqa: BLE001 - the model reads the server's complaint
        raise ToolError(f'The project\'s services could not be read: {e}')
    return [s for s in seen if s.get('online') and 'parse' in (s.get('tasks') or [])]


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
