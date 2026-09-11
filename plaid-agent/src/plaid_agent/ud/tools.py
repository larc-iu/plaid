"""The tools a UD assistant may call, and the workspace they run against.

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3.w2``), never by id: see
:mod:`.project` for why, and for what a UD project is shaped like.
"""

import copy
import uuid
from typing import Any, Dict, List, Optional

from .project import (MISSING, Sentence, Token, UdDoc, UdProject, Word, load_document, parse_ref,
                      render_document, render_sentence, resolve, word_ref)

MAX_RESULT_CHARS = 12000


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
            self.on_progress(f'Reading "{document}"…')
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
        key = op_target(op)
        if key is not None:
            for i, prev in enumerate(self.ops):
                if op_target(prev) == key:
                    self.ops[i] = op
                    self.replaced += 1
                    return
        self.ops.append(op)

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
        # A snapshot: the payload must not alias the live list, since it is
        # what the user approves later.
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in self.ops], 'ops': copy.deepcopy(self.ops),
                'changes': describe_changes(self, self.ops),
                'documents': self.touched_documents()}

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan refers to, with the version each was read at,
        so approval can refuse a plan made against data that has moved on."""
        out = []
        for did in dict.fromkeys(op.get('document_id') for op in self.ops if op.get('document_id')):
            doc = self._docs.get(did)
            if doc is not None:
                out.append({'id': did, 'name': doc.name, 'version': doc.version})
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
    return None


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


def t_read_document(ws: Workspace, document: str = None, from_sentence: int = None,
                    to_sentence: int = None) -> str:
    doc = ws.doc(document)
    lo = max(1, int(from_sentence or 1))
    hi = int(to_sentence) if to_sentence else min(len(doc.sentences), lo + MAX_SENTENCES_PER_READ - 1)
    if hi - lo + 1 > MAX_SENTENCES_PER_READ:
        hi = lo + MAX_SENTENCES_PER_READ - 1
    return _truncate(render_document(doc, from_sentence=lo, to_sentence=hi))


# --- planning helpers ----------------------------------------------------------

def _no_parse_planned(ws: Workspace, doc: UdDoc) -> None:
    """A parse rewrites a document from scratch, so nothing else in the same
    plan may write into it: whichever was planned first, the other is lost."""
    for op in ws.ops:
        if op.get('kind') == 'run_parse' and doc.id in (op.get('document_ids') or []):
            raise ToolError(f'This plan already parses "{doc.name}", and a parse rewrites the '
                            f'document from scratch, so this change would be thrown away. Plan '
                            f'the parse on its own, or drop it first (plan_status, drop_planned).')


def _words(ws: Workspace, doc: UdDoc, refs) -> List[Word]:
    """The words a list of references names, with a readable failure when one
    of them names a sentence or a multi-word token instead."""
    _no_parse_planned(ws, doc)
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
    for w in words:
        sp = w.fields.get(field)
        ws.add_op({'kind': 'set_span', 'layer_id': layer_id, 'token_id': w.id,
                   'span_id': sp.id if sp else None, 'value': value,
                   'document_id': doc.id,
                   'label': f'{field} = "{value}"' if value else f'clear {field}',
                   'ref': word_ref(ws.sentence_of(doc, w), w)})
    what = f'{field} = "{value}"' if value else f'{field} cleared'
    return f'Planned {what} on {len(words)} word(s): ' + ', '.join(
        word_ref(ws.sentence_of(doc, w), w) for w in words)


def t_set_head(ws: Workspace, document: str = None, ref: str = None, head=None,
               deprel: str = None) -> str:
    doc = ws.doc(document)
    word = _words(ws, doc, [ref])[0]
    sentence = ws.sentence_of(doc, word)
    if head is None:
        raise ToolError('Give head: the CoNLL-U id of the head word in the same sentence, or 0 for the root.')
    head = int(head)
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

def _reviewable(w: Word, field: str):
    """(span, state) for a field whose value is waiting for review, else None."""
    from plaid_client.provenance import prov_state
    sp = w.fields.get(field)
    if not sp or not sp.value:
        return None
    state = prov_state(sp.metadata)
    return (sp, state) if state in ('machine', 'contributed') else None


def _targets(ws: Workspace, doc: UdDoc, refs, field: Optional[str]):
    """The words a review tool acts on: the ones named, or every word in the
    document when none are."""
    if refs:
        return _words(ws, doc, refs)
    return [w for s in doc.sentences for w in s.words]


def t_confirm(ws: Workspace, document: str = None, refs=None, field: str = None) -> str:
    """Mark machine output and contributors' work as reviewed and correct."""
    doc = ws.doc(document)
    fields = [field] if field else list(FIELDS)
    for f in fields:
        if f not in FIELDS and f != 'deprel':
            raise ToolError(f'Unknown field "{f}". One of: ' + ', '.join(FIELDS + ('deprel',)))
    words = _targets(ws, doc, refs, field)
    n = 0
    for w in words:
        sentence = ws.sentence_of(doc, w)
        for f in fields:
            hit = _reviewable(w, f)
            if hit:
                ws.add_op({'kind': 'confirm', 'span_id': hit[0].id, 'document_id': doc.id,
                           'label': f'confirm {f} on {word_ref(sentence, w)}',
                           'ref': word_ref(sentence, w)})
                n += 1
        if (not field or field == 'deprel') and w.relation_id:
            from plaid_client.provenance import prov_state
            if prov_state(w.relation_metadata) in ('machine', 'contributed'):
                ws.add_op({'kind': 'confirm', 'relation_id': w.relation_id, 'document_id': doc.id,
                           'label': f'confirm the head of {word_ref(sentence, w)}',
                           'ref': word_ref(sentence, w)})
                n += 1
    if not n:
        return ('Nothing to confirm: every value named is already a person\'s work or confirmed.'
                if refs else f'Nothing in "{doc.name}" is waiting for review.')
    return f'Planned confirming {n} value(s).'


def t_discard_predictions(ws: Workspace, document: str = None, refs=None, field: str = None) -> str:
    """Throw away machine output nobody has confirmed. A person's work and a
    confirmed value are never touched."""
    doc = ws.doc(document)
    fields = [field] if field else list(FIELDS)
    words = _targets(ws, doc, refs, field)
    n = 0
    for w in words:
        sentence = ws.sentence_of(doc, w)
        for f in fields:
            hit = _reviewable(w, f)
            if hit and hit[1] == 'machine':
                ws.add_op({'kind': 'set_span', 'layer_id': hit[0].layer_id, 'token_id': w.id,
                           'span_id': hit[0].id, 'value': '', 'document_id': doc.id,
                           'label': f'discard the unconfirmed {f} on {word_ref(sentence, w)}',
                           'ref': word_ref(sentence, w)})
                n += 1
        if (not field or field == 'deprel') and w.relation_id:
            from plaid_client.provenance import prov_state
            if prov_state(w.relation_metadata) == 'machine':
                ws.add_op({'kind': 'del_relation', 'word_id': w.id, 'relation_id': w.relation_id,
                           'document_id': doc.id,
                           'label': f'discard the unconfirmed head of {word_ref(sentence, w)}',
                           'ref': word_ref(sentence, w)})
                n += 1
    if not n:
        return 'Nothing to discard: no unconfirmed machine values here.'
    return f'Planned discarding {n} unconfirmed machine value(s).'


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


def t_drop_planned(ws: Workspace, indexes=None) -> str:
    if not indexes:
        raise ToolError('Give indexes: the numbers plan_status shows, as a list.')
    drop = {int(i) for i in indexes}
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
        'Read a document as CoNLL-U rows: one line per word with its form, lemma, UPOS, XPOS, features, '
        'head and deprel, and a range line for each multi-word token. A value followed by ~ was made by '
        'a machine and nobody has confirmed it; ^ is a contributor\'s unreviewed work. Up to 40 '
        'sentences per call.',
        {'document': _DOC,
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
        'only those words; without, everything in the document that is waiting. With field, only that '
        'column (deprel is allowed here too); without, all of them.',
        {'document': _DOC, 'refs': _REFS,
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        ['document']),
    _fn('discard_predictions',
        'PLAN: throw away machine values nobody has confirmed, so the columns go back to empty. A '
        'person\'s work and a confirmed value are never touched.',
        {'document': _DOC, 'refs': _REFS,
         'field': {'type': 'string', 'enum': list(FIELDS) + ['deprel']}},
        ['document']),
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
        'Words whose column matches a pattern, with the sentence each sits in. Searches the whole '
        'project unless a document is named. field "form" and a named document are read outright; '
        'the rest go through the query engine.',
        {'field': {'type': 'string', 'enum': list(SEARCHABLE)},
         'pattern': {'type': 'string', 'description': 'A literal substring unless regex is true.'},
         'document': _DOC, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'},
         'regex': {'type': 'boolean'}, 'limit': {'type': 'integer'}},
        ['field', 'pattern']),
    _fn('frequency_list',
        'The commonest values of one column, with counts. Across the project, or inside one document.',
        {'what': {'type': 'string', 'enum': list(COUNTABLE)}, 'document': _DOC,
         'limit': {'type': 'integer'}}, ['what']),
    _fn('check_consistency',
        'Places where the corpus disagrees with itself: one lemma under several UPOS, one form under '
        'several lemmas, deprel and UPOS pairs seen once or twice. Every hit is a question, not a '
        'verdict: read the sentences before planning anything.',
        {'kind': {'type': 'string', 'enum': list(CONSISTENCY)}, 'limit': {'type': 'integer'}}, []),
    _fn('worklist',
        'What is unfinished, counted per document so a session has somewhere to start. kind '
        '"unverified" is machine output nobody has confirmed, "contributed" a contributor\'s '
        'unreviewed work, "missing" words with no value in a column at all.',
        {'kind': {'type': 'string', 'enum': list(WORKLIST_KINDS)},
         'field': _FIELD, 'document': _DOC, 'limit': {'type': 'integer'}}, []),
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
    if ws.web is not None:
        return list(TOOLS)
    return [t for t in TOOLS if t['function']['name'] not in WEB_TOOLS]


def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool; every failure comes back as text for the model."""
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
    clash = {op.get('document_id') for op in ws.ops} & set(ids)
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
