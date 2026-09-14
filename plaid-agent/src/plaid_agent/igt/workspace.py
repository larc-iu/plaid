"""The per-request workspace the interlinear tools run against.

Everything is deliberately IGT-shaped and id-free on the model's side: it
reads compact interlinear views, addresses things positionally (``s3.w2.m1``),
names fields, orthographies, and lexicon entries by name, and never sees a
layer or token id. The workspace resolves all of that against the live
project and caches what it loads for the length of one turn.

What is shared with the other app's workspace is
:class:`plaid_agent.core.workspace.BaseWorkspace`. What is here is how an
interlinear document and its lexicons are loaded, what a plan payload holds,
and the small helpers every tool module needs to read a reference or cut the
text the way the editor does.
"""

import copy
import re
import uuid
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from ..core import opkind
from ..core.limits import MAX_RESULT_CHARS
from ..core.tools import ToolError
from ..core.workspace import BaseWorkspace

from .plan import EXCLUSIVE_KINDS, KIND
from .project import IgtProject, IgtDoc, Morpheme, Sentence, Word, load_document, resolve
from .lexview import LexView, _dict_hits, entry_line
from .vocab import RESERVED_ITEM_KEYS, fields_for_item

MAX_DOCS_PER_SEARCH = 1000

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ('A corpus-wide replace or respell counts as one change, and so does a whole '
             "document's confirm, however many values it covers.")

# Parsed documents, shared across turns and users of this process, keyed by
# (document id, version): every write inside a document bumps its version,
# and the document list a turn starts from carries the current versions, so a
# cached document is exact or unused. Any reader of a project may read all
# of its documents, so sharing is safe. Bounded, least recently used out.
_DOC_CACHE: 'OrderedDict[tuple, IgtDoc]' = OrderedDict()
DOC_CACHE_SIZE = 400


class Workspace(BaseWorkspace):
    """One turn's view of an interlinear project: what it has loaded, the
    lexicon it is building on, and the plan it is proposing."""

    KIND = KIND
    PLAN_NOTE = PLAN_NOTE
    SPAN_KIND = 'set_span'

    def __init__(self, client, project: IgtProject, on_progress=None):
        super().__init__(client, project, on_progress)
        self._lexicons: Dict[str, List[dict]] = {}
        self._views: Dict[tuple, tuple] = {}
        # The metadata an entry will carry once the plan runs, so a second
        # structural tool in one turn reads the tree the first is building.
        self.item_patches: Dict[str, dict] = {}
        self._patch_version = 0
        self.new_entries: Dict[str, dict] = {}  # key -> {form, vocab_id, metadata}
        self._doc_ids: Dict[str, set] = {}  # document id -> every id the document contains
        # Corpus-wide tools ask the query engine unless told to scan every
        # document instead (tests compare the two).
        self.prefer_scan = False

    def make_corpus(self):
        from .corpus import Corpus
        return Corpus(self)

    def doc_tag(self, doc, show: bool = True) -> str:
        """The ``"<document>" `` prefix on a printed reference: the document's
        name, or its id where another document shares that name."""
        return f'"{self.corpus.ref_name(doc.id)}" ' if show else ''

    def doc_label(self, doc_id: str, quote: bool = False) -> str:
        """How a plan's lines name a document to the person approving them:
        its name, and its id too where another document shares that name.
        ``quote`` puts the name in quotes (for prose), the id outside them."""
        name = self.corpus.doc_name(doc_id)
        head = f'"{name}"' if quote else name
        return head if self.corpus.ref_name(doc_id) == name else f'{head} ({doc_id})'

    def use_scan(self, document: Optional[str]) -> bool:
        """Scan (one document, or everything when asked) rather than query."""
        return bool(document) or self.prefer_scan

    # --- loading ---------------------------------------------------------

    def doc(self, document: str) -> IgtDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            entry = next((d for d in self.documents() if d['id'] == did), {})
            # A client may opt out (test doubles reuse ids with different content).
            version = None if getattr(self.client, 'no_doc_cache', False) else entry.get('version')
            key = (did, version)
            cached = _DOC_CACHE.get(key) if version is not None else None
            if cached is not None:
                _DOC_CACHE.move_to_end(key)
                self._docs[did] = cached
                return cached
            self.on_progress(f'Reading "{entry.get("name") or did}"…')
            doc = load_document(self.client, self.project, did)
            self._docs[did] = doc
            if version is not None and doc.version == version:
                _DOC_CACHE[key] = doc
                while len(_DOC_CACHE) > DOC_CACHE_SIZE:
                    _DOC_CACHE.popitem(last=False)
        return self._docs[did]

    def all_docs(self) -> List[IgtDoc]:
        docs = self.documents()
        if len(docs) > MAX_DOCS_PER_SEARCH:
            raise ToolError(f'{len(docs)} documents is too many to scan at once; name a document.')
        return [self.doc(d['id']) for d in docs]

    def lexicon(self, vocab: dict) -> List[dict]:
        if vocab['id'] not in self._lexicons:
            self.on_progress(f'Reading lexicon "{vocab["name"]}"…')
            layer = self.client.vocab_layers.get(vocab['id'], include_items=True)
            self._lexicons[vocab['id']] = list(layer.get('items') or [])
        return self._lexicons[vocab['id']]

    def patch_item(self, item_id: str, metadata: dict) -> None:
        """Record the metadata an entry will have once the plan runs."""
        self.item_patches[item_id] = metadata
        self._patch_version += 1

    def doomed_entries(self) -> frozenset:
        """The entries this plan removes, by delete or by merge."""
        return frozenset({op['item_id'] for op in self.ops if op.get('kind') == 'delete_entry'}
                         | {op['remove_id'] for op in self.ops if op.get('kind') == 'merge_entries'})

    def view(self, vocab: dict, removed: bool = False) -> 'LexView':
        """A lexicon with the plan's pending metadata applied and the entries it
        removes left out, with the sense tree over what is left: what the
        lexicon screens would show once the plan is approved.

        With ``removed`` the entries the plan removes are kept, which is the
        lexicon a tool has to resolve a form against before it can say that
        this plan removes what the form names.
        """
        key = (vocab['id'], removed)
        items = self.lexicon(vocab)
        gone = frozenset() if removed else self.doomed_entries()
        got = self._views.get(key)
        if got and got[0] is items and got[1] == (self._patch_version, gone):
            return got[2]
        planned = [{**it, 'metadata': self.item_patches[it['id']]}
                   if it['id'] in self.item_patches else it
                   for it in items if it['id'] not in gone]
        view = LexView(vocab, planned)
        self._views[key] = (items, (self._patch_version, gone), view)
        return view

    def view_of_item(self, item_id: str) -> Optional['LexView']:
        v = self.vocab_of_item(item_id)
        return self.view(v) if v else None

    def entry_name(self, item: dict) -> str:
        """How a refusal names an entry, spelled the way a tool takes it back.

        Asked of the whole lexicon, not of :meth:`view`: the view leaves out
        what the plan removes, so a refusal ABOUT a removal would have only an
        id to name it by, and no line the user could copy into a tool.
        """
        v = self.vocab_of_item(item['id'])
        if v is None:
            return f'"{item.get("form") or item["id"]}"'
        return self.view(v, removed=True).label(item['id'])

    def find_entry(self, form: Optional[str], lexicon: Optional[str], entry_id: Optional[str],
                   gloss: Optional[str] = None):
        """-> ('existing', item) | ('new', key). Errors list candidates.
        ``gloss`` narrows homographs to entries with that value in any field."""
        if entry_id:
            for key, e in self.new_entries.items():
                if key == entry_id:
                    return 'new', key
            for v in self.project.vocabs:
                for it in self.lexicon(v):
                    if it['id'] == entry_id:
                        return 'existing', it
            raise ToolError(f'No lexicon entry with id {entry_id}')

        if not form:
            raise ToolError('Give entry_form (or entry_id).')
        vocabs = [self.project.vocab(lexicon)] if lexicon else self.project.vocabs
        if not vocabs:
            raise ToolError('This project has no lexicon.')
        # A "#" suffix is always the number the user is SHOWN beside the
        # form: the dotted number, which names a sense ("kwatha#1.2") or one
        # of several entries spelled alike ("gam#2").
        suffix = None
        if '#' in form:
            form, _, hn = form.rpartition('#')
            suffix = hn.strip()
        # A homograph number is a POSITION among the entries spelled alike, and
        # the view it counts against leaves out what this plan deletes. So
        # "gam#1" after a planned delete of gam#1 quietly names the other gam.
        # A number whose referent has moved within the turn is not a name.
        if suffix is not None and '.' not in suffix and self.doomed_entries():
            same = [it for v in vocabs for it in self.lexicon(v)
                    if (it.get('form') or '').lower() == form.lower()
                    and it['id'] in self.doomed_entries()]
            if same:
                raise ToolError(
                    f'"{form}#{suffix}" is not a name any more: this plan deletes or merges away an '
                    f'entry spelled "{form}", so the numbers beside the others have moved. '
                    'Pass entry_id, or drop that change with drop_planned first.')
        g = (gloss or '').strip().casefold()

        def has_gloss(meta, view=None):
            # A value one of the entry's FIELDS holds: never the morph type, the
            # provenance or a structural key, which are not what a user quotes.
            # An entry this plan is adding has no view yet, so its own keys
            # stand in for the schema.
            if not g:
                return True
            names = ([f['name'] for f in fields_for_item(view.fields, {'metadata': meta})] if view is not None
                     else [k for k in (meta or {})
                           if k not in RESERVED_ITEM_KEYS and k != 'morphType' and not k.startswith('prov')])
            return any(isinstance((meta or {}).get(n), str) and meta[n].strip().casefold() == g for n in names)
        # With a gloss to go on, the senses are searched too: a bare form means
        # the entry, but the value that tells two apart is usually a sense's.
        hits = [(v, it) for v in vocabs
                for it in _hits_in(self, v, form, suffix, has_gloss, deep=bool(g))]
        # A sense this plan has just added carries its entry's form, so a bare
        # form would suddenly name two things. It counts only when there is
        # something to tell it apart by, exactly as an existing sense does.
        def planned_ok(e):
            if suffix is not None or g:
                return True
            return not (e.get('metadata') or {}).get('parent')

        news = [(k, e) for k, e in self.new_entries.items()
                if e['form'].lower() == form.lower() and (not lexicon or e['vocab_id'] == vocabs[0]['id'])
                and has_gloss(e.get('metadata')) and planned_ok(e)]
        if len(hits) + len(news) == 1:
            return ('existing', hits[0][1]) if hits else ('new', news[0][0])
        if not hits and not news:
            # The lookup ran against the plan's view, which leaves out what the
            # plan removes, so a form naming only a doomed entry came back as no
            # entry at all and the caller's refusal about a doomed entry never
            # fired: the model was told to create what it had just deleted.
            # Resolve it against the lexicon as it was and hand that entry back.
            # Whether the plan may still work on it is the caller's question,
            # asked in one place (`lexicon._refuse_doomed`, and the plan's own
            # delete-clash check for a tool that only names it).
            gone = self.doomed_entries()
            if gone:
                was = [it for v in vocabs
                       for it in _hits_in(self, v, form, suffix, has_gloss, deep=bool(g), removed=True)
                       if it['id'] in gone]
                # Several entries spelled alike and all of them doomed: no one
                # of them is what the form names, so the refusal stays as it is.
                if len(was) == 1:
                    return 'existing', was[0]
            hint = ''
            if suffix is not None and any(self.view(v).tree_has_form(form) for v in vocabs):
                hint = (f' Headword "{form}" has no sense {suffix}; lexicon_entry shows the senses '
                        'it has.')
            raise ToolError(f'No lexicon entry "{form}"' + (f' with a field valued "{gloss}"' if g else '')
                            + '.' + hint + ' Use read_lexicon to look, or create_entry to add one.')
        lines = [f'Several entries match "{form}"; pass entry_id, entry_gloss (a field value that singles one '
                 f'out), or entry_form as the list shows it:']
        for v, it in hits:
            view = self.view(v)
            addr = view.address(it['id'])
            shown = f' form={addr}' if addr != (it.get('form') or '') else ''
            lines.append(f'  id={it["id"]}{shown} {entry_line(it, view)} ({v["name"]})')
        for k, e in news:
            lines.append(f'  id={k} {e["form"]} (new in this plan)')
        raise ToolError('\n'.join(lines))

    def vocab_of_item(self, item_id: str) -> Optional[dict]:
        """The lexicon an existing entry belongs to."""
        for v in self.project.vocabs:
            if any(it['id'] == item_id for it in self.lexicon(v)):
                return v
        return None

    # --- plan --------------------------------------------------------------

    def guard_op(self, op: Dict[str, Any], replacing=None) -> None:
        """A restore rewrites a document wholesale, so nothing else can be
        planned against the ids and offsets read before it: a restore is
        always a plan of its own."""
        if op.get('kind') not in EXCLUSIVE_KINDS and any(o.get('kind') in EXCLUSIVE_KINDS for o in self.ops):
            raise ToolError('The plan holds a restore, which must be approved on its own; discard_plan first, '
                            'or let the user approve the restore and plan this afterwards.')

    def planned_respells(self, text_id: str) -> List[tuple]:
        return [(op['begin'], op['end']) for op in self.ops if op.get('kind') == 'respell' and op.get('text_id') == text_id]

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .plan import summarize
        from .changes import describe_changes
        from ..core.plan import compact_ops
        # A snapshot: the payload must not alias the live list (discard_plan
        # clears it) since it is what the user approves later. Large groups
        # of like ops are stored as one op: a bulk respell cost over a
        # kilobyte per word stored, and the record could not hold one.
        ops = copy.deepcopy(self.ops)
        spec = compact_spec(self)
        # An op the scan path staged names no document; the group it joins
        # must, so the card can place it and the label can head it.
        from .changes import _doc_of
        for op in ops:
            if op.get('kind') in spec and not op.get('doc'):
                doc_id = _doc_of(self, op)
                if doc_id:
                    op['doc'] = doc_id
        ops = compact_ops(ops, spec)
        # A group whose members share one document keeps it, so the card can
        # place the row; expansion writes each member's own back over it.
        for op in ops:
            docs = set((op.get('items') or {}).get('doc') or []) if op.get('compact') else set()
            if len(docs) == 1:
                op['doc'] = docs.pop()
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in ops], 'ops': ops,
                'changes': describe_changes(self, ops),
                'documents': self.touched_documents()}

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan's ops refer to, with the version each was
        read at, so approval can refuse a plan made against stale data (ops
        carry ids and character offsets from plan time)."""
        out = []
        # Ops built from query results name their document directly.
        unloaded = {op['doc'] for op in self.ops if op.get('doc') and op['doc'] not in self._docs}
        unloaded |= {d for op in self.ops for d in (op.get('documents') or []) if d not in self._docs}
        if unloaded:
            for did, version in self.corpus.versions(unloaded).items():
                out.append({'id': did, 'name': self.corpus.doc_name(did), 'version': version})
        for did, doc in self._docs.items():
            ids = self._doc_ids.get(did)
            if ids is None:
                ids = {doc.id, doc.text_id}
                for s in doc.sentences:
                    ids.add(s.id)
                    ids.update(sp.id for sp in s.fields.values())
                    for w in s.words:
                        ids.add(w.id)
                        ids.update(sp.id for sp in w.fields.values())
                        if w.link:
                            ids.add(w.link.id)
                        ids.update(l.id for l in w.mwes)
                        for m in w.morphemes:
                            ids.add(m.id)
                            ids.update(sp.id for sp in m.fields.values())
                            if m.link:
                                ids.add(m.link.id)
                ids.discard(None)
                self._doc_ids[did] = ids
            if any(_op_mentions(op, ids) for op in self.ops):
                out.append({'id': doc.id, 'name': doc.name, 'version': doc.version})
        return out

def _op_mentions(value, ids: set) -> bool:
    if isinstance(value, str):
        return value in ids
    if isinstance(value, dict):
        return any(_op_mentions(v, ids) for k, v in value.items() if k != 'label')
    if isinstance(value, list):
        return any(_op_mentions(v, ids) for v in value)
    return False


def _change_part(label: str) -> str:
    """The change a label describes, after its location head."""
    return label.split(': ', 1)[1] if ': ' in label else label


def compact_spec(ws: Workspace) -> Dict[str, Dict[str, Any]]:
    """How like ops fold into one stored op (core.plan.compact_ops), read off
    the registry: each kind says which of its keys vary per member (the
    document among them, so a bulk change over a whole corpus is one group
    and not one per document, most of which held too few to fold at all).
    The line is headed by the document when the group has one, the way every
    label is, so the card can split it the same way."""
    def label(first, members):
        n = len(members)
        parts = [_change_part(m.get('label') or '') for m in members[:5]]
        body = f'{n} changes: ' + '; '.join(parts) + (f'; … {n - 5} more' if n > 5 else '')
        docs = {m.get('doc') for m in members} - {None}
        if len(docs) == 1:
            return f'{ws.doc_label(next(iter(docs)))}: {body}'
        if docs:
            return f'{n} changes in {len(docs)} documents: ' + body.split(': ', 1)[1]
        return body

    return opkind.compact_spec(KIND, label)


def op_target(op: Dict[str, Any]):
    """What an op writes to, for last-wins replacement within one plan. Each
    kind declares its own; a kind that can supersede nothing has none."""
    return opkind.target_of(KIND, op)


# --- helpers -----------------------------------------------------------------

# --- reading what the model wrote --------------------------------------------

_REF_TOKEN = re.compile(r's\d+(?:\.w\d+(?:\.m\d+)?)?')


def _refs(refs) -> List[str]:
    """References as the model passes them: a list or a string, possibly
    prefixed with the document name the read tools print ('"Text 1" s3.w2')."""
    if refs is None:
        return []
    items = [refs] if isinstance(refs, str) else [str(r) for r in refs]
    out: List[str] = []
    for item in items:
        found = _REF_TOKEN.findall(item)
        if not found and item.strip():
            raise ToolError(f'Bad reference "{item.strip()}": use sN, sN.wN, or sN.wN.mN')
        out.extend(found)
    return out


def _matcher(pattern: str, regex: bool, case_sensitive: bool = False):
    if regex:
        try:
            rx = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
        except re.error as e:
            raise ToolError(f'Bad regex: {e}')
        return lambda s: bool(rx.search(s or ''))
    if case_sensitive:
        return lambda s: (pattern or '') in (s or '')
    p = (pattern or '').casefold()
    return lambda s: p in (s or '').casefold()


def _hits_in(ws: Workspace, v: dict, form: str, suffix: Optional[str], has_gloss,
             deep: bool = False, removed: bool = False) -> List[dict]:
    """The entries a form names in one lexicon, by that lexicon's own rules."""
    view = ws.view(v, removed=removed)
    return [it for it in _dict_hits(view, form, suffix, deep) if has_gloss(it.get('metadata'), view)]


def _meta_of(ws: Workspace, item: dict) -> dict:
    return ws.item_patches.get(item['id'], item.get('metadata') or {})


def _need(obj, kind, ref):
    if not isinstance(obj, kind):
        want = {Sentence: 'a sentence (sN)', Word: 'a word (sN.wN)', Morpheme: 'a morpheme (sN.wN.mN)'}[kind]
        raise ToolError(f'{ref} is not {want}')
    return obj


def _words_of(doc: IgtDoc, refs) -> List[tuple]:
    """[(ref, sentence, word)] for word references, in text order, no repeats."""
    out = []
    seen = set()
    for ref in _refs(refs):
        w = _need(resolve(doc, ref), Word, ref)
        if w.id in seen:
            continue
        seen.add(w.id)
        out.append((ref, _sentence_of(doc, w), w))
    out.sort(key=lambda t: t[2].begin)
    return out


def _truncate(s: str) -> str:
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS] + f'\n... [truncated: {len(s) - MAX_RESULT_CHARS} more characters; narrow the request]'


def _sentence_of(doc: IgtDoc, w: Word) -> Sentence:
    for s in doc.sentences:
        if w in s.words:
            return s
    raise ToolError('internal: word not in document')

