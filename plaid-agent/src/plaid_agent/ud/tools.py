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

from .project import (MISSING, Sentence, Token, UdDoc, UdProject, Word, load_document, parse_ref,
                      render_document, render_sentence, resolve, word_ref)
from .review import (REVIEW_FIELDS, all_words, confirm_targets, counts_phrase, discard_targets,
                     per_field)

MAX_RESULT_CHARS = 12000
# The most per-span changes one plan may hold. Stored compactly (see
# core.plan.compact_ops) this many fit the conversation record with room for
# the transcript; a whole document's review goes as a scope op and costs one.
PLAN_MAX_OPS = 3000
# Ops that name a document and a set of fields rather than spans, and are
# resolved to spans when the plan is applied.
SCOPE_KINDS = ('confirm_scope', 'discard_scope')
# The most documents one review may cover when several are named or all
# are asked for: each is read to count what is waiting, and read again at
# approval.
MAX_SCOPE_DOCS = 100


class ToolError(Exception):
    """A tool-level failure whose message goes back to the model as the result."""


# --- the workspace ------------------------------------------------------------

class Workspace:
    def __init__(self, client, project: UdProject, on_progress=None):
        self.client = client
        self.project = project
        self.on_progress = on_progress or (lambda msg: None)
        self._doc_list: Optional[List[dict]] = None
        self._docs: Dict[str, UdDoc] = {}
        self.ops: List[Dict[str, Any]] = []
        self.replaced = 0  # ops superseded by a later op on the same target this turn
        self._corpus = None  # the query helper, made on first corpus-wide read
        # Set when the operator configured web search. None means the web tools
        # are not offered to the model at all.
        self.web = None

    # --- loading ---------------------------------------------------------

    def documents(self) -> List[dict]:
        if self._doc_list is None:
            self._doc_list = list(self.client.projects.list_documents(self.project.id) or [])
        return self._doc_list

    def resolve_document_id(self, document: str) -> str:
        """Accept a document id, an exact name, or an unambiguous prefix."""
        if not document:
            raise ToolError('Name a document (id or exact name); project_overview lists them.')
        docs = self.documents()
        for d in docs:
            if d['id'] == document:
                return d['id']
        by_name = [d for d in docs if (d.get('name') or '').lower() == document.lower()]
        if len(by_name) == 1:
            return by_name[0]['id']
        if len(by_name) > 1:
            raise ToolError(f'Several documents are named "{document}"; use an id: '
                            + ', '.join(d['id'] for d in by_name))
        starts = [d for d in docs if (d.get('name') or '').lower().startswith(document.lower())]
        if len(starts) == 1:
            return starts[0]['id']
        raise ToolError(f'No document "{document}". Documents: '
                        + ', '.join(f'"{d.get("name")}"' for d in docs[:50]))

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

    def add_op(self, op: Dict[str, Any]) -> None:
        """Add one op, replacing an earlier op on the same target so a model
        that changes its mind inside one turn does not plan two writes."""
        # A page from the web is text by a stranger, and this turn has read
        # one. Nothing it says gets to become a proposed change in the same
        # breath: the user sees what was found first, and asks for the change
        # separately if they want it.
        #
        # IGT has had this since its web tools landed, and the prompt UD ships
        # (webtools.PROMPT) tells the model the workspace enforces it. UD's did
        # not, so the assistant could stage a plan in a turn a web page had
        # steered, and the user would have been approving a card whose origin
        # was a stranger's page.
        if self.web is not None and getattr(self.web, 'read', False):
            raise ToolError(
                'This turn has read the web, so it cannot also plan changes. Tell the user what you '
                'found and what you would change, and let them ask for it. The next turn can plan it '
                'without looking anything up.')
        key = op_target(op)
        if key is not None:
            for i, prev in enumerate(self.ops):
                if op_target(prev) == key:
                    self.ops[i] = op
                    self.replaced += 1
                    return
        self.reserve(1)
        self.ops.append(op)

    def reserve(self, n: int) -> None:
        """Refuse BEFORE staging what would push the plan past what a record
        can hold, so a tool never leaves half of its changes behind."""
        if len(self.ops) + n > PLAN_MAX_OPS:
            raise ToolError(f'That would bring the plan to {len(self.ops) + n} changes, more than the '
                            f'{PLAN_MAX_OPS} one plan may hold. Let the user approve what is planned and '
                            f'go on in another turn, or narrow it. A whole document\'s review (confirm or '
                            f'discard_predictions without refs) counts as one change however many values '
                            f'it covers.')

    def planned_value(self, layer_id: str, token_id: str, current: str) -> str:
        """The value a span will have once the plan runs, so a second tool in
        the same turn reads what the first one planned."""
        for op in self.ops:
            if op.get('kind') == 'set_span' and op.get('layer_id') == layer_id \
                    and op.get('token_id') == token_id:
                return op.get('value') or ''
        return current

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


def docs_of_op(op: Dict[str, Any]) -> set:
    """The documents an op reaches: one, a parse's list, or every document a
    corpus-wide replacement matched."""
    out = set()
    if op.get('document_id'):
        out.add(op['document_id'])
    out.update(op.get('document_ids') or [])
    out.update(op.get('documents') or [])
    return out


def op_target(op: Dict[str, Any]):
    """What an op writes, for deduping within one turn. None when an op is not
    the kind that can supersede another (a comment, a structural change)."""
    kind = op.get('kind')
    if kind == 'set_span':
        return ('span', op.get('layer_id'), op.get('token_id'))
    if kind == 'set_head':
        return ('head', op.get('word_id'))
    if kind == 'del_relation':
        return ('head', op.get('word_id'))
    if kind in SCOPE_KINDS:
        return ('scope', kind, op.get('document_id'))
    if kind == 'replace_scope':
        return ('replace', op.get('field'), op.get('pattern'), op.get('replacement'), op.get('document_id'))
    return None


def _refs_phrase(members, limit: int = 8) -> str:
    refs = [m.get('ref') for m in members if m.get('ref')]
    shown = ', '.join(refs[:limit])
    return shown + (f', … {len(refs) - limit} more' if len(refs) > limit else '')


def _set_span_label(first, members) -> str:
    what = f'{first["field"]} = "{first["value"]}"' if first.get('value') else f'clear {first["field"]}'
    return f'{what} on {len(members)} words ({_refs_phrase(members)})'


def _set_head_label(first, members) -> str:
    return f'{first["deprel"]} on {len(members)} words ({_refs_phrase(members)})'


def _del_relation_label(first, members) -> str:
    return f'remove the head of {len(members)} words ({_refs_phrase(members)})'


def _confirm_label(first, members) -> str:
    return f'confirm {len(members)} values ({_refs_phrase(members)})'


# How the like ops of one plan fold into one stored op (core.plan.compact_ops).
COMPACT = {
    'set_span': {'each': ('token_id', 'span_id', 'ref'), 'label': _set_span_label},
    'set_head': {'each': ('word_id', 'head_id', 'word_form', 'head_form', 'lemma_span_id',
                          'head_lemma_span_id', 'relation_id', 'ref'), 'label': _set_head_label},
    'del_relation': {'each': ('word_id', 'relation_id', 'ref'), 'label': _del_relation_label},
    'confirm': {'each': ('span_id', 'relation_id', 'ref'), 'label': _confirm_label},
}


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
        from .stats import _corpus
        sizes = _corpus(ws).sizes()
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
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
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
        text = str(item).strip()
        head = text.split('.')[0]
        if head[:1].lower() == 's':
            head = head[1:]
        if not head.isdigit():
            raise ToolError(f'"{item}" does not name a sentence. Use a number or a reference '
                            f'like "s34".')
        n = int(head)
        if n not in out:
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
    lo = max(1, int(from_sentence or 1))
    hi = int(to_sentence) if to_sentence else min(len(doc.sentences), lo + MAX_SENTENCES_PER_READ - 1)
    if hi - lo + 1 > MAX_SENTENCES_PER_READ:
        hi = lo + MAX_SENTENCES_PER_READ - 1
    return _truncate(render_document(doc, from_sentence=lo, to_sentence=hi, budget=budget))


# --- planning helpers ----------------------------------------------------------

def _no_parse_planned(ws: Workspace, doc: UdDoc) -> None:
    """A parse rewrites a document from scratch, so nothing else in the same
    plan may write into it: whichever was planned first, the other is lost."""
    for op in ws.ops:
        if op.get('kind') == 'run_parse' and doc.id in docs_of_op(op):
            raise ToolError(f'This plan already parses "{doc.name}", and a parse rewrites the '
                            f'document from scratch, so this change would be thrown away. Plan '
                            f'the parse on its own, or drop it first (plan_status, drop_planned).')


def _no_restore_planned(ws: Workspace) -> None:
    """A restore rewrites every layer of its document, so nothing may join its
    plan. The check looks FORWARD as well as back: refusing only when a
    restore is planned second would let an edit slip in after one."""
    for op in ws.ops:
        if op.get('kind') == 'restore_document':
            raise ToolError('This plan restores a document, and a restore rewrites every layer of '
                            'it, so nothing else can share the plan. Apply it on its own, then '
                            'plan the rest against what it restored (plan_status, drop_planned).')


def _no_boundary_moved(ws: Workspace, doc: UdDoc) -> None:
    """Moving a sentence boundary renumbers every sentence after it, and every
    reference in a plan is positional. Rather than decide whether a later
    "s7.w2" means before or after, a plan that moves a boundary does that and
    nothing else to the document."""
    for op in ws.ops:
        if op.get('kind') in ('split_sentence', 'merge_sentences') and op.get('document_id') == doc.id:
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


def _not_being_reshaped(ws: Workspace, words: List[Word]) -> None:
    """Reshaping a token deletes and remakes its words, so annotating one of
    them in the same plan writes to something that will not exist."""
    doomed = {w for op in ws.ops if op.get('kind') == 'set_words'
              for w in (op.get('existing_word_ids') or [])}
    hit = [w for w in words if w.id in doomed]
    if hit:
        raise ToolError('This plan already reshapes the token these words belong to, and that '
                        'deletes them. Do one or the other (plan_status, drop_planned).')


def _no_words_annotated(ws: Workspace, token, doc_id: str = None) -> None:
    """Reshaping a token deletes and remakes its words, so a plan that already
    annotates one of them would be writing to something that will not exist.
    `_not_being_reshaped` is this rule seen from the other side; without both,
    annotate-then-reshape was staged, approved, and only then refused."""
    doomed = {w.id for w in token.words}
    for op in ws.ops:
        if op.get('kind') == 'set_words' and set(op.get('existing_word_ids') or []) & doomed:
            raise ToolError('This plan already reshapes this token. Do one or the other '
                            '(plan_status, drop_planned).')
        # A scope op reaches every word of its document, this token's included,
        # and a corpus-wide replacement reaches every document it matched.
        if op.get('kind') in SCOPE_KINDS + ('replace_scope',) and doc_id in docs_of_op(op):
            raise ToolError('This plan already reviews every word of this document, and reshaping '
                            'a token deletes some of them. Do one or the other (plan_status, '
                            'drop_planned).')
        if op.get('token_id') in doomed or op.get('word_id') in doomed:
            raise ToolError('This plan already annotates a word of this token, and reshaping it '
                            'deletes that word. Do one or the other (plan_status, drop_planned).')


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
    _not_being_reshaped(ws, out)
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
    ws.reserve(len(words))
    for w in words:
        sp = w.fields.get(field)
        ws.add_op({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                   'span_id': sp.id if sp else None, 'value': value,
                   'field': field, 'document_id': doc.id,
                   'label': f'{field} = "{value}"' if value else f'clear {field}',
                   'ref': word_ref(ws.sentence_of(doc, w), w)})
    what = f'{field} = "{value}"' if value else f'{field} cleared'
    return f'Planned {what} on {len(words)} word(s): ' + ', '.join(
        word_ref(ws.sentence_of(doc, w), w) for w in words)


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
    ws.reserve(len(words) - len(headless))
    for w in words:
        if not w.relation_id:
            continue
        ws.add_op({'kind': 'del_relation', 'word_id': w.id, 'relation_id': w.relation_id,
                   'document_id': doc.id,
                   'label': f'remove the head of {word_ref(ws.sentence_of(doc, w), w)}',
                   'ref': word_ref(ws.sentence_of(doc, w), w)})
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
    """Every word, with the refusals `_words` would have made: a scope op
    reaches every word, so it cannot join a plan that reshapes any of them."""
    _guards(ws, doc)
    words = all_words(doc)
    _not_being_reshaped(ws, [w for _, w in words])
    return words


def _scope_fields(ws: Workspace, kind: str, doc: UdDoc, fields: List[str]) -> List[str]:
    """The fields a scope op on this document ends up covering: a second call
    widens the first rather than replacing it (add_op replaces by target)."""
    for op in ws.ops:
        if op.get('kind') == kind and op.get('document_id') == doc.id:
            return [f for f in REVIEW_FIELDS if f in set(op.get('fields') or []) | set(fields)]
    return fields


def _scope_documents(ws: Workspace, documents, kind: str, fields: List[str]) -> List[str]:
    """The document ids a many-document review covers: the ones named, or
    every document with something waiting when ``documents`` is "all"."""
    if isinstance(documents, list) and len(documents) == 1 and str(documents[0]).strip().lower() == 'all':
        documents = 'all'
    if isinstance(documents, str) and documents.strip().lower() == 'all':
        from .stats import _corpus
        c = _corpus(ws)
        stamps = [{'prov': 'inferred'}] + ([{'prov': 'contributed'}] if kind == 'confirm' else [])
        ids: List[str] = []
        for f in fields:
            if f == 'deprel':
                continue
            for stamp in stamps:
                for did, _n in c.documents_with([c.field(f, '?s', metadata=stamp), c.unconfirmed('?s')], '?s'):
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
    """Run a one-document review tool over several documents, and sum up."""
    fields = _review_fields(field)
    kind = 'confirm' if one is t_confirm else 'discard'
    ids = _scope_documents(ws, documents, kind, fields)
    planned = 0
    covered = []
    for did in ids:
        before = len(ws.ops)
        one(ws, document=did, field=field)
        if len(ws.ops) > before:
            planned += ws.ops[-1].get('count') or 0
            covered.append(ws.doc(did).name)
    if not covered:
        return f'Nothing is waiting for review in the {len(ids)} document(s) named.'
    verb = 'confirming' if kind == 'confirm' else 'discarding'
    return (f'Planned {verb} {planned} value(s) across {len(covered)} document(s), one planned change '
            f'each: ' + ', '.join(f'"{n}"' for n in covered[:20])
            + (f', … {len(covered) - 20} more' if len(covered) > 20 else '') + '.')


def t_confirm(ws: Workspace, document: str = None, refs=None, field: str = None, documents=None) -> str:
    """Mark machine output and contributors' work as reviewed and correct."""
    if documents and not document:
        return _many(ws, documents, field, t_confirm)
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets = confirm_targets(_named(ws, doc, refs), fields)
        if not targets:
            return 'Nothing to confirm: every value named is already a person\'s work or confirmed.'
        ws.reserve(len(targets))
        for sentence, w, f, span_id, relation_id in targets:
            ref = word_ref(sentence, w)
            ws.add_op({'kind': 'confirm', 'span_id': span_id, 'relation_id': relation_id,
                       'document_id': doc.id, 'ref': ref,
                       'label': f'confirm the head of {ref}' if f == 'deprel' else f'confirm {f} on {ref}'})
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
    if documents and not document:
        return _many(ws, documents, field, t_discard_predictions)
    doc = ws.doc(document)
    fields = _review_fields(field)
    if refs:
        targets, spared = discard_targets(_named(ws, doc, refs), fields)
        if targets:
            ws.reserve(len(targets))
        for sentence, w, f, span, relation_id in targets:
            ref = word_ref(sentence, w)
            if f == 'deprel':
                ws.add_op({'kind': 'del_relation', 'word_id': w.id, 'relation_id': relation_id,
                           'document_id': doc.id, 'ref': ref,
                           'label': f'discard the unconfirmed head of {ref}'})
            else:
                ws.add_op({'kind': 'set_span', 'layer_id': span.layer_id, 'token_id': w.id,
                           'span_id': span.id, 'value': '', 'field': f, 'document_id': doc.id,
                           'ref': ref, 'label': f'discard the unconfirmed {f} on {ref}'})
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


# --- the tool table -------------------------------------------------------------

def _fn(name, description, properties, required):
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Word references in the same document, e.g. ["s3.w2", "s3.w5"].'}
_FIELD = {'type': 'string', 'enum': list(FIELDS),
          'description': 'Which column: lemma, upos, xpos or features.'}

TOOLS = [
    _fn('project_overview',
        'The project: its language, its controlled vocabularies and whether each one is a rule or a '
        'suggestion, and its documents. Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a name substring.',
        {'pattern': {'type': 'string'}, 'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}},
        []),
    _fn('read_document',
        'Read a document as tab-separated CoNLL-U rows: one line per word with its form, lemma, UPOS, '
        'XPOS, features, head and deprel, and a range line for each multi-word token. A value followed '
        'by ~ was made by a machine and nobody has confirmed it; ^ is a contributor\'s unreviewed work. '
        'Up to 40 sentences per call, fewer when they are long: the first line says which sentences '
        'were shown and where to continue. WHEN YOU ALREADY KNOW WHICH SENTENCES YOU NEED (a search '
        'told you, or an earlier read did), name them in `sentences` and get them all in ONE call. '
        'Paging a long document with from_sentence/to_sentence costs a call per page and will run out '
        'of steps before it runs out of document.',
        {'document': _DOC,
         'sentences': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Just these sentences, e.g. ["s34","s64","s104"]. A word '
                                      'reference like "s34.w2" names its sentence. Overrides the '
                                      'range below.'},
         'from_sentence': {'type': 'integer', 'description': 'First sentence, 1-based (default 1).'},
         'to_sentence': {'type': 'integer', 'description': 'Last sentence, inclusive.'}},
        ['document']),
    _fn('set_field',
        'PLAN: set one annotation column on one or more words. An empty value clears it. features '
        'takes the whole set at once, in CoNLL-U form ("Case=Nom|Number=Sing").',
        {'document': _DOC, 'refs': _REFS, 'field': _FIELD,
         'value': {'type': 'string', 'description': 'The new value, or "" to clear the column.'}},
        ['document', 'refs', 'field']),
    _fn('set_head',
        'PLAN: give one word its head and its relation to it. head is the CoNLL-U id of another word in '
        'the SAME sentence, or 0 to make this word the sentence root (deprel "root"). A word has one '
        'head, so this replaces whatever head it had.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The dependent word, e.g. "s3.w2".'},
         'head': {'type': 'integer', 'description': 'The head word\'s CoNLL-U id, or 0 for the root.'},
         'deprel': {'type': 'string', 'description': 'The relation label, e.g. nsubj, obj, det.'}},
        ['document', 'ref', 'head']),
    _fn('del_relation',
        'PLAN: leave one or more words with no head at all. Use set_head to re-attach instead whenever '
        'there is a head to give.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('confirm',
        'PLAN: mark values as reviewed and correct, which is what clears the ~ and ^ marks. With refs, '
        'only those words; without, everything in the document that is waiting, as ONE planned change '
        'for the whole document. With field, only that column (deprel is allowed here too); without, '
        'all of them. Give `documents` instead of `document` to cover several at once: a list of '
        'names, or "all" for every document with something waiting (up to 100).',
        {'document': _DOC, 'refs': _REFS,
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'},
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        []),
    _fn('discard_predictions',
        'PLAN: throw away machine values nobody has confirmed, so the columns go back to empty. A '
        'person\'s work and a confirmed value are never touched. Without refs it covers the whole '
        'document as one planned change; `documents` covers several, or "all".',
        {'document': _DOC, 'refs': _REFS,
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'},
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        []),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of one column that matches a pattern, across the whole '
        'project or in one document: rename a lemma everywhere, retag a deprel, fix a feature '
        'spelling. A literal substring unless regex is true; whole matches the whole value; case is '
        'ignored unless case_sensitive. Empty values are never filled. The plan holds it as ONE change '
        'with its count; search shows every match first.',
        {'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']},
         'pattern': {'type': 'string'},
         'replacement': {'type': 'string', 'description': 'With regex, \\1 refers to a group.'},
         'regex': {'type': 'boolean'}, 'whole': {'type': 'boolean'},
         'case_sensitive': {'type': 'boolean'}, 'document': _DOC},
        ['field', 'pattern', 'replacement']),
    _fn('run_parse',
        'PLAN: have the project\'s parser re-parse whole documents. This REWRITES each document '
        'from scratch (tokens, columns and tree), so it cannot share a plan with any other change '
        'to the same document, and it is the right tool only when a document should be parsed '
        'afresh, never for fixing particular words. overwrite=false leaves sentences a person made '
        'or confirmed alone.',
        {'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Document ids or exact names.'},
         'language': {'type': 'string', 'description': 'Defaults to the project\'s own language.'},
         'overwrite': {'type': 'boolean'},
         'service_id': {'type': 'string', 'description': 'Only when several parsers are connected.'}},
        ['documents']),
    _fn('set_words',
        'PLAN: say which WORDS a token holds. Two or more makes it a multi-word token (Spanish '
        '"al" holding "a" and "el"); one collapses it back to a plain token. This REPLACES the '
        'token\'s words, so it discards their lemma, UPOS, XPOS, features and heads, and seeds '
        'each new word\'s lemma from its form. Use it to fix segmentation, never to change one '
        'value.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The token: "s3.w2", or "s3.w2-3" if it is '
                                                  'already a multi-word token.'},
         'forms': {'type': 'array', 'items': {'type': 'string'},
                   'description': 'The words, in order, e.g. ["a", "el"].'}},
        ['document', 'ref', 'forms']),
    _fn('split_sentence',
        'PLAN: start a new sentence at this word, so the sentence it is in becomes two. Any '
        'dependency relation that would end up spanning the two is deleted, because a relation '
        'never crosses a sentence. Sentences after it renumber, so this is the ONLY change a '
        'plan may carry for this document: every other reference would move.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The word the new sentence starts at, "s3.w5".'}},
        ['document', 'ref']),
    _fn('merge_sentences',
        'PLAN: join this sentence onto the one before it, so the two become one. Name the SECOND '
        'of them: "s3" joins s2 and s3. Nothing is lost, since merging only widens a sentence. '
        'Sentences after it renumber, so this is the ONLY change a plan may carry for this '
        'document.',
        {'document': _DOC,
         'ref': {'type': 'string', 'description': 'The second of the two sentences, "s3".'}},
        ['document', 'ref']),
    _fn('query_help',
        'The Plaid query language, and this project\'s layer names. Call it before writing a '
        'query; it costs nothing until you need it.', {}, []),
    _fn('query',
        'Run one read-only Plaid query over this project. The escape hatch for a question the '
        'other reads cannot express: two columns at once, adjacency, a join. Layers are named by '
        'name. Call query_help first.',
        {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, '
                                                    'order_by. See query_help.'},
         'limit': {'type': 'integer', 'description': 'Rows to show (default 50, max 500).'}},
        ['query']),
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history, every layer of it. The '
        'plan shows what would change, from the server\'s own dry run, so it is not a guess. '
        'Maintainers only. It rewrites the whole document, so it must be the ONLY change in its '
        'plan. recent_changes prints an as_of instant for every change.',
        {'document': _DOC,
         'as_of': {'type': 'string', 'description': 'An ISO-8601 instant, e.g. '
                                                    '2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _fn('plan_status', 'Every change planned so far in this turn, numbered.', {}, []),
    _fn('discard_plan', 'Throw away everything planned so far and start the plan over.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their numbers from plan_status.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
]

# The corpus-wide reads live in their own module, which imports this one for
# the workspace: declare them after TOOLS exists.
from .stats import (COUNTABLE, CONSISTENCY, SEARCHABLE, WORKLIST_KINDS,  # noqa: E402
                    t_check_consistency, t_comments, t_frequency_list, t_recent_changes,
                    t_search, t_worklist)

TOOLS += [
    _fn('search',
        'Words whose column matches a pattern, each shown in its context with the hit in brackets. '
        'Searches the whole project unless a document is named: the first line gives the total '
        'and how many documents have hits, and the hits shown are a few from each of several '
        'documents, not every hit from one. Name a document to see every hit in it.',
        {'field': {'type': 'string', 'enum': list(SEARCHABLE)},
         'pattern': {'type': 'string', 'description': 'A literal substring unless regex is true.'},
         'document': _DOC, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'},
         'regex': {'type': 'boolean'}, 'limit': {'type': 'integer'}},
        ['field', 'pattern']),
    _fn('frequency_list',
        'The commonest values of one column, with counts. Across the project, or inside one document. '
        '"features" counts each Feature=Value on its own; "feature-bundles" counts whole FEATS strings '
        'as stored.',
        {'what': {'type': 'string', 'enum': list(COUNTABLE)}, 'document': _DOC,
         'limit': {'type': 'integer'}}, ['what']),
    _fn('check_consistency',
        'Places where the corpus disagrees with itself: one lemma under several UPOS, one form under '
        'several lemmas, deprel and UPOS pairs seen once or twice. Every hit is a question, not a '
        'verdict: read the sentences before planning anything.',
        {'kind': {'type': 'string', 'enum': list(CONSISTENCY)}, 'limit': {'type': 'integer'}}, []),
    _fn('worklist',
        'What is unfinished. kind "unverified" is machine output nobody has confirmed, '
        '"contributed" a contributor\'s unreviewed work, "missing" words with no value in a '
        'column at all. Without a document it counts per document, so a session has somewhere to '
        'start. WITH A DOCUMENT it names the words themselves, by reference, whichever kind you '
        'ask for: that is the list to plan from, and it saves reading or searching the document '
        'to find them.',
        {'kind': {'type': 'string', 'enum': list(WORKLIST_KINDS)},
         'field': _FIELD, 'document': _DOC,
         'limit': {'type': 'integer', 'description': 'How many rows per column (default 20, '
                                                     'max 100).'}}, []),
    _fn('recent_changes',
        'Who changed what, when, and under which operation label. Each entry prints the as_of '
        'instant a restore would use.',
        {'document': _DOC, 'limit': {'type': 'integer'},
         'since': {'type': 'string', 'description': 'A date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Match the actor\'s name or email.'}}, []),
    _fn('comments',
        'What people have written to each other on a document or one of its sentences. These are '
        'notes between annotators, never annotation.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One sentence, e.g. "s3".'},
         'limit': {'type': 'integer'}}, ['document']),
]

_IMPL = {
    'project_overview': t_project_overview,
    'search': t_search,
    'frequency_list': t_frequency_list,
    'check_consistency': t_check_consistency,
    'worklist': t_worklist,
    'recent_changes': t_recent_changes,
    'comments': t_comments,
    'list_documents': t_list_documents,
    'read_document': t_read_document,
    'set_field': t_set_field,
    'set_head': t_set_head,
    'del_relation': t_del_relation,
    'confirm': t_confirm,
    'discard_predictions': t_discard_predictions,
    'plan_status': t_plan_status,
    'discard_plan': t_discard_plan,
    'drop_planned': t_drop_planned,
}

# Offered only when the operator configured a search backend (see tools_for).
from ..core import webtools  # noqa: E402
from ..core.web import WebError  # noqa: E402

TOOLS += webtools.schemas('this corpus')


def _need_web(ws: Workspace):
    if ws.web is None:
        raise ToolError('Web lookup is not configured on this assistant.')


def t_web_search(ws: Workspace, query: str, limit: int = 5) -> str:
    _need_web(ws)
    try:
        return _truncate(webtools.web_search(ws, query, limit))
    except WebError as e:
        raise ToolError(str(e))


def t_read_url(ws: Workspace, url: str) -> str:
    _need_web(ws)
    try:
        return _truncate(webtools.read_url(ws, url))
    except WebError as e:
        raise ToolError(str(e))


_IMPL.update({'web_search': t_web_search, 'read_url': t_read_url})
WEB_TOOLS = webtools.NAMES

# A tool that plans a change says so in the first word of its description, and
# that is what makes it one: no second list to keep in step with the first.
WRITE_TOOLS = {t['function']['name'] for t in TOOLS if t['function']['description'].startswith('PLAN:')}


def tools_for(ws: Workspace) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call. The web tools exist only
    where the operator configured a search backend, so a model that cannot
    look anything up is never told that it can."""
    hidden = set() if ws.web is not None else set(WEB_TOOLS)
    if _sandbox.available() is not None:
        hidden |= set(CODE_TOOLS)
    return [t for t in TOOLS if t['function']['name'] not in hidden]


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool. Every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    try:
        return _truncate(fn(ws, **(args or {})))
    except (ToolError, ValueError) as e:  # ValueError: a reference lookup failed, message is for the model
        return f'Error: {e}'
    except (TypeError, AttributeError) as e:
        return f'Error: an argument has the wrong type ({e}); check the tool\'s parameter types'
    except Exception as e:  # noqa: BLE001 - the model gets the failure as text; the log gets the trace
        import traceback
        traceback.print_exc()
        return f'Error: {type(e).__name__}: {e}'


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

    ids = [ws.resolve_document_id(d) for d in documents]
    # A parse deletes and recreates a document's tokens, spans and relations.
    # Anything else this plan writes into the same document would be thrown
    # away by it, so the two cannot travel together.
    clash = set().union(*(docs_of_op(op) for op in ws.ops)) & set(ids) if ws.ops else set()
    if clash:
        names = ', '.join(f'"{ws.doc(i).name}"' for i in clash)
        raise ToolError(f'This plan already changes {names}, and a parse rewrites a document from '
                        f'scratch, so those changes would be thrown away. Plan the parse on its own, '
                        f'or drop the other changes first (plan_status, drop_planned).')
    lang = (language or ws.project.language or '').strip()
    if not lang:
        raise ToolError('Give language: the project does not record one, and the parser needs to '
                        'know which models to load.')
    names = [ws.doc(i).name for i in ids]
    ws.add_op({'kind': 'run_parse', 'document_ids': ids, 'service_id': chosen.get('service_id'),
               'project_id': ws.project.id, 'language': lang, 'overwrite': bool(overwrite),
               'label': (f'parse {len(ids)} document(s) with {chosen.get("service_name")} ({lang})'
                         + (', overwriting human work' if overwrite else '')),
               'ref': None})
    warn = (' It will overwrite annotations a person made or confirmed.' if overwrite
            else ' Sentences a person made or confirmed are left alone.')
    return (f'Planned a parse of {len(ids)} document(s) with {chosen.get("service_name")} '
            f'in {lang}: ' + ', '.join(f'"{n}"' for n in names) + '.' + warn
            + ' A parse rewrites a document, so it is the only kind of change in this plan.')


_IMPL['run_parse'] = t_run_parse

from .shape import t_set_words  # noqa: E402
from .sentences import t_merge_sentences, t_split_sentence  # noqa: E402

_IMPL['set_words'] = t_set_words
from .query import t_query, t_query_help  # noqa: E402
from .restore import t_restore_document  # noqa: E402

from .bulk import t_replace_in_field  # noqa: E402

_IMPL['replace_in_field'] = t_replace_in_field
_IMPL['split_sentence'] = t_split_sentence
_IMPL['restore_document'] = t_restore_document
_IMPL['query'] = t_query
_IMPL['query_help'] = t_query_help
_IMPL['merge_sentences'] = t_merge_sentences


# Offered only where the monty worker binary is present (see tools_for): a
# model that cannot run code is never told that it can.
from ..core import sandbox as _sandbox  # noqa: E402
from .sandbox import t_code_help, t_run_code  # noqa: E402

TOOLS += _sandbox.schemas('the treebank')
_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})
CODE_TOOLS = _sandbox.NAMES
