"""The tools the model sees, and the per-request workspace they run against.

Everything is deliberately IGT-shaped and id-free on the model's side: it
reads compact interlinear views, addresses things positionally (``s3.w2.m1``),
names fields, orthographies, and lexicon entries by name, and never sees a
layer or token id. The workspace resolves all of that against the live
project and caches what it loads for the length of one turn.

Read tools answer immediately. Write tools do not write: they append resolved
operations to the workspace's plan (see :mod:`plan`), which the service returns
with the turn for the user to approve.
"""

import copy
import json
import re
import uuid
from collections import Counter, OrderedDict
from typing import Any, Dict, List, Optional

import unicodedata

from plaid_client.provenance import prov_state, MACHINE

from .project import (IgtProject, IgtDoc, Sentence, Word, Morpheme, Link, load_document, resolve, document_lines,
                      render_document, render_overview, render_word, mwe_ref, REVIEWABLE,
                      segmentation, joiner, word_ref, is_unicode_punctuation)

MAX_RESULT_CHARS = 12000
MAX_DOCS_PER_SEARCH = 1000

# Parsed documents, shared across turns and users of this process, keyed by
# (document id, version): every write inside a document bumps its version,
# and the document list a turn starts from carries the current versions, so a
# cached document is exact or unused. Any reader of a project may read all
# of its documents, so sharing is safe. Bounded, least recently used out.
_DOC_CACHE: 'OrderedDict[tuple, IgtDoc]' = OrderedDict()
DOC_CACHE_SIZE = 400


from .vocab import (
    homograph_of,RESERVED_ITEM_KEYS, FIELD_ITEM, FIELD_TEXT, SCOPE_ENTRY, SCOPE_SENSE,
                    build_sense_tree, descendants_of, item_ref_fields, field_by_name,
                    is_reserved_field_name, parent_of, ref_ids, with_ref_ids, with_parent,
                    next_sense_order, plan_sense_set_number, all_examples, with_example_added,
                    with_example_removed, references_to, arrange_as_tree, vocab_field_summary,
                    build_item_numbers, homograph_group,
                    plan_homograph_order, SENSE_ORDER_KEY, fields_for_item, PARENT_KEY)


class ToolError(Exception):
    """A tool-level failure whose message goes back to the model as the result."""


class Workspace:
    def __init__(self, client, project: IgtProject, on_progress=None):
        self.client = client
        self.project = project
        self.on_progress = on_progress or (lambda msg: None)
        self._doc_list: Optional[List[dict]] = None
        self._docs: Dict[str, IgtDoc] = {}
        self._lexicons: Dict[str, List[dict]] = {}
        self._views: Dict[str, tuple] = {}
        # The metadata an entry will carry once the plan runs, so a second
        # structural tool in one turn reads the tree the first is building.
        self.item_patches: Dict[str, dict] = {}
        self._patch_version = 0
        self.ops: List[Dict[str, Any]] = []
        self.replaced = 0  # ops superseded by a later op on the same target this turn
        self.new_entries: Dict[str, dict] = {}  # key -> {form, vocab_id, metadata}
        self._doc_ids: Dict[str, set] = {}  # document id -> every id the document contains
        # Corpus-wide tools ask the query engine unless told to scan every
        # document instead (tests compare the two).
        self.prefer_scan = False
        self._corpus = None
        # Set when the operator configured web search (see .web). None means
        # the web tools are not offered at all.
        self.web = None

    @property
    def corpus(self):
        if self._corpus is None:
            from .corpus import Corpus
            self._corpus = Corpus(self)
        return self._corpus

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

    def documents(self) -> List[dict]:
        if self._doc_list is None:
            self._doc_list = list(self.client.projects.list_documents(self.project.id) or [])
        return self._doc_list

    def resolve_document_id(self, document: str) -> str:
        """Accept a document id or a unique document name."""
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

    def view(self, vocab: dict) -> 'LexView':
        """A lexicon with the plan's pending metadata applied and the entries it
        removes left out, with the sense tree over what is left: what the
        lexicon screens would show once the plan is approved."""
        key = vocab['id']
        items = self.lexicon(vocab)
        gone = self.doomed_entries()
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

    def add_op(self, op: Dict[str, Any]) -> None:
        """Append a plan op. An op on a target the plan already touches
        REPLACES the earlier op (last wins), so a corrected instruction never
        yields two writes to one span, token, or entry. The target key is
        derived from the op's kind."""
        # A page from the web is text by a stranger, and this turn has read
        # one. Nothing it says gets to become a proposed change in the same
        # breath: the user sees what was found first, and asks for the change
        # separately if they want it.
        if self.web is not None and self.web.read:
            raise ToolError(
                'This turn has read the web, so it cannot also plan changes. Tell the user what you '
                'found and what you would change, and let them ask for it. The next turn can plan it '
                'without looking anything up.')
        # A restore rewrites a document wholesale, so nothing else can be
        # planned against the ids and offsets read before it: a restore is
        # always a plan of its own.
        if op.get('kind') != 'restore_document' and any(o.get('kind') == 'restore_document' for o in self.ops):
            raise ToolError('The plan holds a restore, which must be approved on its own; discard_plan first, '
                            'or let the user approve the restore and plan this afterwards.')
        key = op_target(op)
        if key is not None:
            for i, prev in enumerate(self.ops):
                if op_target(prev) == key:
                    self.ops[i] = op
                    self.replaced += 1
                    return
        self.ops.append(op)

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        for op in ops:
            self.add_op(op)

    def planned_span_value(self, layer_id: str, token_id: str, current: str) -> str:
        """The value a span will have once the plan runs (a planned op wins
        over the stored value), so bulk tools compose with earlier plans."""
        for op in self.ops:
            if op.get('kind') == 'set_span' and op.get('layer_id') == layer_id and op.get('token_id') == token_id:
                return op.get('value') or ''
        return current

    def planned_respells(self, text_id: str) -> List[tuple]:
        return [(op['begin'], op['end']) for op in self.ops if op.get('kind') == 'respell' and op.get('text_id') == text_id]

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .plan import summarize
        from .changes import describe_changes
        # A snapshot: the payload must not alias the live list (discard_plan
        # clears it) since it is what the user approves later.
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in self.ops], 'ops': copy.deepcopy(self.ops),
                'changes': describe_changes(self, self.ops),
                'documents': self.touched_documents()}

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan's ops refer to, with the version each was
        read at, so approval can refuse a plan made against stale data (ops
        carry ids and character offsets from plan time)."""
        out = []
        # Ops built from query results name their document directly.
        unloaded = {op['doc'] for op in self.ops if op.get('doc') and op['doc'] not in self._docs}
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

    def planned_note(self, n: int) -> str:
        note = (f'Planned {n} change{"s" if n != 1 else ""} (nothing is written until the user approves; '
                f'the plan now holds {len(self.ops)}). Describe the plan to the user in your reply.')
        if self.replaced:
            note += f' {self.replaced} earlier planned change{"s" if self.replaced != 1 else ""} on the same target{"s" if self.replaced != 1 else ""} superseded.'
            self.replaced = 0
        return note


def _op_mentions(value, ids: set) -> bool:
    if isinstance(value, str):
        return value in ids
    if isinstance(value, dict):
        return any(_op_mentions(v, ids) for k, v in value.items() if k != 'label')
    if isinstance(value, list):
        return any(_op_mentions(v, ids) for v in value)
    return False


def op_target(op: Dict[str, Any]):
    """What an op writes to, for last-wins replacement within one plan."""
    k = op.get('kind')
    if k == 'set_span':
        return ('span', op.get('layer_id'), op.get('token_id'))
    if k in ('set_analysis', 'discard_analysis'):
        return ('analysis', op.get('word_id'))
    if k == 'set_orthography':
        return ('orth', op.get('word_id'), op.get('key'))
    if k == 'set_morpheme_form':
        return ('morph_form', op.get('morpheme_id'))
    if k == 'set_morph_type':
        return ('morph_type', op.get('morpheme_id'))
    if k in ('split_word', 'merge_words', 'delete_word'):
        return ('word_shape', op.get('word_id'))
    if k in ('split_sentence', 'merge_sentences'):
        return ('sentence_shape', op.get('sentence_id'))
    if k == 'edit_text':
        return ('edit_text', op.get('text_id'), op.get('begin'), op.get('end'))
    if k == 'respell':
        return ('respell', op.get('text_id'), op.get('begin'), op.get('end'))
    if k == 'link':
        return ('link', op.get('token_id'))
    if k == 'unlink':
        # A multi-word expression's link is its own target: unlinking it
        # never displaces a member word's own link.
        return ('mwe_link', op.get('link_id')) if op.get('token_ids') else ('link', op.get('token_id_hint'))
    if k == 'link_phrase':
        return ('mwe', tuple(op.get('token_ids') or []))
    if k == 'restore_document':
        return ('restore', op.get('document_id'))
    if k == 'set_entry_field':
        return ('entry_field', op.get('item_id'), op.get('field'))
    if k == 'set_entry_metadata':
        # Keyed by the keys it writes, so renumbering a sense and promoting an
        # example on one entry are two changes rather than one replacing the other.
        return ('entry_meta', op.get('item_id'), tuple(sorted((op.get('patch') or {}).keys())))
    if k == 'rename_entry':
        return ('rename_entry', op.get('item_id'))
    if k == 'delete_entry':
        return ('delete_entry', op.get('item_id'))
    if k == 'set_doc_metadata':
        return ('doc_meta', op.get('document_id'), op.get('field'))
    if k == 'rename_document':
        return ('rename_document', op.get('document_id'))
    if k == 'create_document':
        return ('create_document', op.get('name'))
    return None


# --- helpers -----------------------------------------------------------------

class LexView:
    """A lexicon's items and the sense tree over them."""

    __slots__ = ('vocab', 'items', 'tree', 'fields', 'ref_fields', 'numbers', 'shared')

    def __init__(self, vocab: dict, items: List[dict]):
        self.vocab = vocab
        self.items = items
        self.fields = vocab.get('fields') or []
        self.ref_fields = item_ref_fields(self.fields)
        self.tree = build_sense_tree(items)
        # The number the USER sees beside a form, which is what a "#" suffix
        # has to mean.
        self.numbers = build_item_numbers(items)
        # Headwords that share their form with another. A lone headword with
        # senses is numbered 1, which says nothing in prose, so only these
        # carry their number when a line names them.
        counts = Counter((r.get('form') or '') for r in self.tree.roots)
        self.shared = {r['id'] for r in self.tree.roots if counts[r.get('form') or ''] > 1}

    def number(self, item_id: str) -> str:
        return self.numbers.get(item_id, '')

    def hidden_fields(self, item: dict) -> set:
        """Field names the app's entry form does not show on this item. A
        headword-only field sits on the headword, so reporting it on a sense
        offers the model a value the user cannot see and set_entry_field will
        refuse to write.

        Asked of the TREE, not of the raw metadata: a parent naming nothing
        makes an item a root here and in the app, whose load-time repair
        clears such a parent on sight. Reading the raw key would call that
        item a sense and hide fields it is free to carry.
        """
        parent = self.tree.parent_of.get(item['id'])
        as_placed = {'metadata': {PARENT_KEY: parent} if parent else {}}
        shown = {f['name'] for f in fields_for_item(self.fields, as_placed)}
        return {f['name'] for f in self.fields} - shown

    def is_sense(self, item_id: str) -> bool:
        return self.tree.is_sense(item_id)

    def tree_has_form(self, form: str) -> bool:
        return any((r.get('form') or '').lower() == (form or '').lower() for r in self.tree.roots)

    def head_of(self, item_id: str) -> str:
        """The headword an item sits under, which is its own when it is an entry."""
        it = self.tree.by_id.get(item_id)
        root = self.tree.entry_of(item_id) if it is not None else None
        return ((root or it) or {}).get('form') or ''

    def label(self, item_id: str) -> str:
        """How a line names an entry, always spelled the way a tool takes it
        back, so a line can be copied into one: "kwatha", "gam#2" for the
        second entry spelled that way, "kwatha#1.2" for a sense.

        Never "gam (2)" or "kwatha" sense 1.2, which read as prose and then
        fail as input. A lone headword keeps its bare form, since the number
        it would carry is always 1 and says nothing.
        """
        it = self.tree.by_id.get(item_id)
        if it is None:
            return f'a deleted entry ({item_id})'
        if self.is_sense(item_id):
            return f'"{self.address(item_id)}"'
        num = self.number(item_id) if item_id in self.shared else ''
        form = it.get('form') or ''
        return f'"{form}#{num}"' if num else f'"{form}"'

    def address(self, item_id: str) -> str:
        """The entry_form that names this item back to a tool: "kwatha", or
        "kwatha#1.2" for a sense, or "gam#2" for the second entry of that form.
        Always the number the user is shown, never an internal one."""
        it = self.tree.by_id.get(item_id)
        if it is None:
            return item_id
        head = self.head_of(item_id) if self.is_sense(item_id) else (it.get('form') or '')
        num = self.number(item_id)
        return f'{head}#{num}' if num else head

    def ref_summary(self, it: dict) -> List[str]:
        """The reference fields an entry carries, as forms rather than ids."""
        out = []
        for f in self.ref_fields:
            ids = ref_ids(it, f)
            if ids:
                out.append(f'{f["name"]}=' + ', '.join(self.label(x) for x in ids))
        return out


def _num_key(num: str):
    """A dotted number as a sort key, so "2.10" follows "2.9"."""
    return tuple(int(p) for p in (num or '').split('.') if p.isdigit())


def _dict_hits(view: LexView, form: str, suffix: Optional[str], deep: bool = False) -> List[dict]:
    """The items a form names in a lexicon. Senses share their entry's headword,
    so a bare form means the ENTRY (or the entries, where several share it) and
    never the pile of its senses; a "#" suffix is the number the user sees,
    which tells apart both the senses under an entry ("kwatha#1.2") and entries
    that share a form ("gam#2"). A form that heads no entry falls back to any
    item carrying it, so a sense renamed away from its headword stays
    reachable.

    ``deep`` widens a bare form to the senses as well. It is for a caller that
    has something else to tell them apart with, such as entry_gloss: the gloss
    that singles one out usually IS a sense's."""
    roots = [r for r in view.tree.roots if (r.get('form') or '').lower() == (form or '').lower()]
    if not roots:
        others = [it for it in view.items if (it.get('form') or '').lower() == (form or '').lower()]
        return others if suffix is None else [it for it in others if view.number(it['id']) == suffix]
    family = list(roots)
    for r in roots:
        family.extend(descendants_of(view.tree, r['id']))
    if suffix is None:
        return family if deep else roots
    hits = [it for it in family if view.number(it['id']) == suffix]
    # A lone headword with no senses is shown with no number at all, and "#1"
    # is what the prompt teaches for a headword, so it names that one rather
    # than failing with a complaint about senses it does not have.
    if not hits and suffix == '1' and len(roots) == 1 and not view.number(roots[0]['id']):
        return roots
    return hits


def entry_line(it: dict, view: Optional[LexView] = None) -> str:
    """One entry as a line: its form, then its fields. The reserved keys are
    never fields (they are the sense tree and the promoted examples), so they
    are left out here and said in words instead when a view is at hand."""
    meta = it.get('metadata') or {}
    parts = [it.get('form') or '']
    # An entry this plan is creating has no id yet: it is placed by its
    # metadata alone, and its references still read as the entries they name.
    placed = view is not None and bool(it.get('id'))
    if placed and view.is_sense(it['id']):
        parts.append(f'sense {view.number(it["id"])} of "{view.head_of(it["id"])}"')
    if meta.get('morphType'):
        parts.append(f'type={meta["morphType"]}')
    ref_names = {f['name'] for f in (view.ref_fields if view is not None else [])}
    hidden = (view.hidden_fields(it) if placed
              else {f['name'] for f in (view.fields if view is not None else [])}
              - {f['name'] for f in fields_for_item(view.fields if view is not None else [], it)})
    for k, v in meta.items():
        if (k in RESERVED_ITEM_KEYS or k == 'morphType' or k in ref_names or k in hidden
                or k.startswith('prov') or v in (None, '', [], {})):
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        parts.append(f'{k}={v}')
    if view is not None:
        parts.extend(view.ref_summary(it))
    n_ex = len(all_examples(it))
    if n_ex:
        parts.append(f'{n_ex} example{"s" if n_ex != 1 else ""}')
    if placed:
        n_s = len(view.tree.senses_of(it['id']))
        if n_s:
            parts.append(f'{n_s} sense{"s" if n_s != 1 else ""} below')
    return ' | '.join(parts)


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


def _matcher(pattern: str, regex: bool):
    if regex:
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            raise ToolError(f'Bad regex: {e}')
        return lambda s: bool(rx.search(s or ''))
    p = (pattern or '').casefold()
    return lambda s: p in (s or '').casefold()


def _is_break_char(c: str, cfg) -> bool:
    """Does this character end a word (the editor's shouldTokenizeCharacter,
    with its exact punctuation class)? Unless whitelisted; or, under a
    blacklist config, exactly the listed characters."""
    punct = is_unicode_punctuation(c)
    if not cfg:
        return punct
    if cfg.get('type') == 'unicodePunctuation':
        return punct and c not in (cfg.get('whitelist') or [])
    if cfg.get('type') == 'blacklist':
        return c in (cfg.get('blacklist') or [])
    return punct


def split_sentences(text: str) -> List[tuple]:
    """(begin, end) code-point ranges, one sentence per line (newline plus
    following whitespace is the boundary), as the editor does."""
    out = []
    i, n = 0, len(text)
    start = 0
    while i <= n:
        if i == n or text[i] == '\n':
            if text[start:i].strip():
                out.append((start, i))
            i += 1
            while i < n and text[i].isspace():
                i += 1
            start = i
        else:
            i += 1
    return out


def split_words(text: str, begin: int, end: int, cfg) -> List[tuple]:
    """(begin, end) word ranges inside one sentence: whitespace and break
    characters separate words; break characters are not tokens (they stay in
    the gap), as in the editor."""
    out = []
    i = begin
    cur = begin
    while i < end:
        c = text[i]
        if c.isspace() or _is_break_char(c, cfg):
            if i > cur and text[cur:i].strip():
                out.append(_trimmed(text, cur, i))
            i += 1
            while i < end and text[i].isspace():
                i += 1
            cur = i
        else:
            i += 1
    if cur < end and text[cur:end].strip():
        out.append(_trimmed(text, cur, end))
    return out


def _trimmed(text, b, e):
    while b < e and text[b].isspace():
        b += 1
    while e > b and text[e - 1].isspace():
        e -= 1
    return (b, e)


def _truncate(s: str) -> str:
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS] + f'\n... [truncated: {len(s) - MAX_RESULT_CHARS} more characters; narrow the request]'


def _sentence_of(doc: IgtDoc, w: Word) -> Sentence:
    for s in doc.sentences:
        if w in s.words:
            return s
    raise ToolError('internal: word not in document')


# --- read tools ---------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    return render_overview(ws.project, ws.documents())


def t_list_documents(ws: Workspace, pattern: Optional[str] = None, metadata_field: Optional[str] = None,
                     value: Optional[str] = None, limit: int = 100, offset: int = 0) -> str:
    """The documents, filtered by a name pattern and/or a metadata value, a
    page at a time (the overview shows only the first hundred)."""
    docs = sorted(ws.documents(), key=lambda d: (d.get('name') or '').lower())
    if pattern:
        m = _matcher(pattern, False)
        docs = [d for d in docs if m(d.get('name') or '')]
    if metadata_field:
        name = next((n for n in ws.project.document_metadata if n.lower() == metadata_field.lower()), None)
        if not name:
            raise ToolError(f'No document metadata field "{metadata_field}". Fields: '
                            + (', '.join(ws.project.document_metadata) or '(none configured)'))
        metas = ws.corpus.document_metadata() if not ws.prefer_scan else {d.id: d.metadata for d in ws.all_docs()}
        want = (value or '').casefold()
        docs = [d for d in docs if str((metas.get(d['id']) or {}).get(name, '') or '').casefold() == want
                or (not want and not (metas.get(d['id']) or {}).get(name))]
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    page = docs[offset:offset + limit]
    head = f'{len(docs)} document{"s" if len(docs) != 1 else ""}' + (' matching' if pattern or metadata_field else '') \
        + (f', showing {offset + 1}-{offset + len(page)}' if len(docs) > len(page) else '') + ':'
    lines = [head] + document_lines(page)
    if offset + len(page) < len(docs):
        lines.append(f'  … list_documents(offset={offset + len(page)}) for the next page')
    return _truncate('\n'.join(lines))


def t_read_document(ws: Workspace, document: str, from_sentence: int = 1, to_sentence: Optional[int] = None) -> str:
    doc = ws.doc(document)
    return render_document(doc, ws.project, start=int(from_sentence or 1),
                           end=int(to_sentence) if to_sentence else None,
                           ref_name=ws.corpus.ref_name(doc.id))


def t_search(ws: Workspace, pattern: str = '', where: str = 'baseline', document: Optional[str] = None,
             regex: bool = False, limit: int = 40) -> str:
    if not pattern:
        raise ToolError('Give a pattern (to list items LACKING a value, use worklist).')
    match = _matcher(pattern, bool(regex))
    limit = max(1, min(int(limit or 40), 200))
    where_name = (where or 'baseline').strip()
    if where_name.lower().startswith('field:'):
        where_name = where_name[6:].strip()
    where_l = where_name.lower()
    out: List[str] = []
    total = 0

    if where_l == 'lexicon':
        for v in ws.project.vocabs:
            for it in ws.lexicon(v):
                line = entry_line(it)
                if match(line):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{line} ({v["name"]})')
        return _finish(out, total, limit, 'lexicon entries')

    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where_name)
    if not ws.use_scan(document):
        from .corpus import q_search
        out, total = q_search(ws, pattern, where_l, field, bool(regex), limit)
        return _finish(out, total, limit, 'hits')
    docs = [ws.doc(document)] if document else ws.all_docs()
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            if field and field.scope == 'Sentence':
                sp = s.fields.get(field.name)
                if sp and match(sp.value):
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}s{s.index} {field.name}={sp.value} | {s.text}')
                continue
            for w in s.words:
                hit = False
                if where_l == 'baseline':
                    hit = match(w.surface)
                elif where_l == 'morpheme':
                    hit = any(match(m.form) for m in w.morphemes)
                elif field.scope == 'Word':
                    sp = w.fields.get(field.name)
                    hit = bool(sp and match(sp.value))
                else:
                    hit = any(match(m.fields[field.name].value) for m in w.morphemes if field.name in m.fields)
                if hit:
                    total += 1
                    if len(out) < limit:
                        out.append(f'{tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    return _finish(out, total, limit, 'hits')


def _finish(out, total, limit, noun):
    if not out:
        return f'No {noun}.'
    head = f'{total} {noun}' + (f' (showing {limit})' if total > limit else '') + ':'
    return _truncate('\n'.join([head] + out))


def t_read_lexicon(ws: Workspace, lexicon: Optional[str] = None, pattern: Optional[str] = None,
                   limit: int = 80) -> str:
    vocabs = [ws.project.vocab(lexicon)] if lexicon else ws.project.vocabs
    if not vocabs:
        return 'This project has no lexicon.'
    match = _matcher(pattern, False) if pattern else (lambda s: True)
    limit = max(1, min(int(limit or 80), 500))
    lines = []
    for v in vocabs:
        view = ws.view(v)
        # Senses under their entry, each with the number it is shown with,
        # which is also how a tool is told which one. Entries spelled the same
        # carry one too, so they read in that order.
        items = sorted(view.items, key=lambda it: ((it.get('form') or '').casefold(),
                                                   _num_key(view.number(it['id']))))
        hits = [it for it in items if match(entry_line(it, view))]
        n_entries = len(view.tree.roots)
        n_senses = len(items) - n_entries
        head = (f'Lexicon "{v["name"]}": {n_entries} '
                f'headword{"s" if n_entries != 1 else ""}, {n_senses} sense{"s" if n_senses != 1 else ""}'
                + (f', {len(hits)} matching' if pattern else ''))
        lines.append(head)
        shown = 0
        for it, depth, context in arrange_as_tree(hits, view.tree):
            if shown >= limit:
                break
            # A context row is an entry above a hit, printed so a sense is not
            # read as a headword. It does not count against the limit's tally
            # of matches, but it does take a line.
            if not context:
                shown += 1
            num = view.number(it['id'])
            lines.append('  ' + '  ' * depth + (f'{num} ' if num else '')
                         + entry_line(it, view) + (' | (context)' if context else ''))
        if len(hits) > shown:
            lines.append(f'  ... {len(hits) - shown} more (narrow with pattern)')
    return _truncate('\n'.join(lines))


def _bracket_line(w: Word, hit: Morpheme, field: Optional[str]) -> str:
    """The word's segmentation (field=None) or one morpheme field's values,
    joined as in the interlinear view, with the hit morpheme in [brackets]."""
    out = ''
    for i, m in enumerate(w.morphemes):
        if i:
            out += joiner(w.morphemes[i - 1].morph_type, m.morph_type)
        if field is None:
            piece = m.form
        else:
            sp = m.fields.get(field)
            piece = sp.value if sp and sp.value != '' else '_'
        out += f'[{piece}]' if m is hit else piece
    return out


def t_concordance(ws: Workspace, pattern: str, where: str = 'morpheme', document: Optional[str] = None,
                  regex: bool = False, limit: int = 60) -> str:
    """Every occurrence of a morpheme form, word form, or field value with
    its aligned context: the containing word's segmentation and morpheme
    glosses (hit in brackets) and the neighbouring words, plus a tally of the
    distinct word patterns the hit occurs in. Built for morphotactic
    questions (what precedes/follows X, does X vary by context)."""
    if not pattern:
        raise ToolError('Give a pattern.')
    limit = max(1, min(int(limit or 60), 300))
    where_l = (where or 'morpheme').lower()
    field = None
    if where_l not in ('baseline', 'morpheme'):
        field = ws.project.field(where)
        if field.scope == 'Sentence':
            raise ToolError('concordance works on words and morphemes; use search for sentence fields')
    if not ws.use_scan(document):
        from .corpus import q_concordance_hits
        hits, total = q_concordance_hits(ws, pattern, where_l, field, bool(regex), limit)
    else:
        # Whole-form match by default (a concordance of "ar" must not include
        # "para"); regex for anything looser.
        if regex:
            match = _matcher(pattern, True)
        else:
            wanted = pattern.casefold()
            match = lambda s: (s or '').casefold() == wanted  # noqa: E731
        docs = [ws.doc(document)] if document else ws.all_docs()
        hits = []
        total = 0
        for doc in docs:
            for s in doc.sentences:
                for w in s.words:
                    hit_morphs: List[Morpheme] = []
                    if where_l == 'baseline':
                        if not match(w.surface):
                            continue
                    elif where_l == 'morpheme':
                        hit_morphs = [m for m in w.morphemes if match(m.form)]
                        if not hit_morphs:
                            continue
                    elif field.scope == 'Word':
                        sp = w.fields.get(field.name)
                        if not (sp and match(sp.value)):
                            continue
                    else:
                        hit_morphs = [m for m in w.morphemes
                                      if field.name in m.fields and match(m.fields[field.name].value)]
                        if not hit_morphs:
                            continue
                    for hit in (hit_morphs or [None]):
                        total += 1
                        if len(hits) < limit:
                            hits.append((doc, s, w, hit))
    if not total:
        return f'No occurrences of "{pattern}".'
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    patterns: Counter = Counter()
    lines_out: List[str] = []
    for doc, s, w, hit in hits:
        wi = w.index - 1
        prev = s.words[wi - 1].surface if wi > 0 else '#'
        nxt = s.words[wi + 1].surface if wi + 1 < len(s.words) else '#'
        seg = _bracket_line(w, hit, None) if w.morphemes else w.surface
        glosses = ' | '.join(f'{f}={_bracket_line(w, hit, f)}' for f in mfields
                             if any(f in m.fields for m in w.morphemes))
        pattern_key = seg if hit is None else f'{seg}' + (f'  {glosses}' if glosses else '')
        patterns[pattern_key] += 1
        wf = ' | '.join(f'{f.name}={w.fields[f.name].value}' for f in ws.project.fields_by_scope('Word')
                        if f.name in w.fields and w.fields[f.name].value != '')
        lines_out.append(f'{ws.corpus.tag(doc.id)}{word_ref(s, w)} {prev} [{w.surface}] {nxt} | seg={seg}'
                         + (f' | {glosses}' if glosses else '') + (f' | {wf}' if wf else '')
                         + f' || {s.text}')
    lines = [f'{total} occurrence{"s" if total != 1 else ""} of "{pattern}" in {where_l if not field else field.name}'
             + (f' (showing {limit})' if total > limit else '') + '.',
             'Word patterns (hit in [brackets]), by frequency' + (f', among the {len(hits)} shown' if total > len(hits) else '') + ':']
    for key, n in sorted(patterns.items(), key=lambda kv: (-kv[1], kv[0]))[:25]:
        lines.append(f'  {n}\t{key}')
    if len(patterns) > 25:
        lines.append(f'  ... {len(patterns) - 25} more patterns')
    lines.append('Occurrences (previous [word] next | segmentation | morpheme fields || sentence):')
    lines.extend('  ' + h for h in lines_out)
    return _truncate('\n'.join(lines))


MAX_FORMS_PER_CALL = 40


def t_analyses_of(ws: Workspace, form: Optional[str] = None, document: Optional[str] = None,
                  forms: Optional[list] = None) -> str:
    """How a word form and/or a morpheme form has been analyzed so far: the
    distinct analyses with counts and an example reference each. The same
    evidence the editor's precedent ranking uses. Several forms at once
    (``forms``) come back one block each, so glossing a sentence is one call."""
    wanted = [str(f).strip() for f in (forms or []) if str(f).strip()]
    if form and str(form).strip():
        wanted.insert(0, str(form).strip())
    wanted = list(dict.fromkeys(wanted))
    if not wanted:
        raise ToolError('Give a form, or forms (a list).')
    if len(wanted) > MAX_FORMS_PER_CALL:
        raise ToolError(f'At most {MAX_FORMS_PER_CALL} forms per call; split the list.')
    if len(wanted) > 1:
        return _truncate('\n\n'.join(_analyses_of_one(ws, f, document) for f in wanted))
    return _truncate(_analyses_of_one(ws, wanted[0], document))


def _analyses_of_one(ws: Workspace, form: str, document: Optional[str]) -> str:
    if not ws.use_scan(document):
        from .corpus import q_analyses_of
        return q_analyses_of(ws, form)
    key = form.casefold()
    docs = [ws.doc(document)] if document else ws.all_docs()
    mfields = [f.name for f in ws.project.fields_by_scope('Morpheme')]
    wfields = [f.name for f in ws.project.fields_by_scope('Word')]
    word_tally: Dict[str, List[str]] = {}
    morph_tally: Dict[str, List[str]] = {}
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            for w in s.words:
                ref = f'{tag}{word_ref(s, w)}'
                if w.surface.casefold() == key:
                    parts = []
                    seg = segmentation(w)
                    if len(w.morphemes) > 1 or (w.morphemes and seg != w.surface):
                        parts.append('seg=' + seg)
                        for f in mfields:
                            line = _bracket_line(w, None, f)
                            if line.replace('_', '').replace('-', '').replace('=', ''):
                                parts.append(f'{f}={line}')
                        types = [m.morph_type for m in w.morphemes if m.morph_type]
                        if types:
                            parts.append('types=' + ','.join(m.morph_type or '?' for m in w.morphemes))
                    for f in wfields:
                        sp = w.fields.get(f)
                        if sp and sp.value != '':
                            parts.append(f'{f}={sp.value}')
                    if w.link:
                        parts.append(f'link={w.link.form}')
                    for l in w.mwes:
                        parts.append(f'mwe={l.form}')
                    mlinks = [f'm{m.index}:{m.link.form}' for m in w.morphemes if m.link]
                    if mlinks:
                        parts.append('mlinks=' + ' '.join(mlinks))
                    word_tally.setdefault(' | '.join(parts) or '(unanalyzed)', []).append(ref)
                for m in w.morphemes:
                    if m.form.casefold() == key:
                        parts = []
                        if m.morph_type:
                            parts.append(f'type={m.morph_type}')
                        for f in mfields:
                            sp = m.fields.get(f)
                            if sp and sp.value != '':
                                parts.append(f'{f}={sp.value}')
                        if m.link:
                            parts.append(f'link={m.link.form}')
                        pos = 'only' if len(w.morphemes) == 1 else ('first' if m.index == 1 else
                                                                   'last' if m.index == len(w.morphemes) else 'middle')
                        morph_tally.setdefault((' | '.join(parts) or '(unglossed)') + f'  [{pos} in word]', []
                                               ).append(f'{ref}.m{m.index} ({segmentation(w)})')
    lines = []
    for title, tally in ((f'Word "{form}"', word_tally), (f'Morpheme "{form}"', morph_tally)):
        if not tally:
            lines.append(f'{title}: no occurrences.')
            continue
        n = sum(len(v) for v in tally.values())
        lines.append(f'{title}: {n} occurrence{"s" if n != 1 else ""}, {len(tally)} distinct analys{"es" if len(tally) != 1 else "is"}:')
        for analysis, refs in sorted(tally.items(), key=lambda kv: -len(kv[1])):
            lines.append(f'  {len(refs)}\t{analysis}  e.g. {", ".join(refs[:3])}')
    return '\n'.join(lines)


def t_lexicon_entry(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, examples: int = 3, entry_gloss: Optional[str] = None) -> str:
    """One lexicon entry in full: every field, where it is linked (words vs
    morphemes, how many), and example occurrences."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'new':
        e = ws.new_entries[target]
        return f'Entry "{e["form"]}" is new in this plan (not written yet): ' + entry_line({'form': e['form'], 'metadata': e['metadata']})
    # The plan's own copy of the entry, so a value set or an example promoted
    # a moment ago reads back the same whether the entry was named by id or
    # by form.
    meta = _meta_of(ws, target)
    view = ws.view_of_item(target['id'])
    if view is not None:
        num = view.number(target['id'])
        if view.is_sense(target['id']):
            where = f'Sense {num} of headword "{view.head_of(target["id"])}"'
        else:
            group = homograph_group(view.items, target['id'])
            where = (f'Headword "{target.get("form")}"'
                     + (f' ({num} of {len(group)} spelled that way)' if group else ''))
        lines = [f'{where} (id {target["id"]}, entry_form "{view.address(target["id"])}")']
    else:
        lines = [f'Entry "{target.get("form")}" (id {target["id"]})']  # a flat lexicon has no headwords
    ref_names = {f['name'] for f in (view.ref_fields if view is not None else [])}
    hidden = view.hidden_fields(target) if view is not None else set()
    for k, v in meta.items():
        if (k in RESERVED_ITEM_KEYS or k in ref_names or k in hidden or k.startswith('prov')
                or v in (None, '', [], {})):
            continue
        lines.append(f'  {k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v}')
    if view is not None:
        lines.extend(f'  {r}' for r in view.ref_summary(target))
        lines.extend(_dictionary_lines(ws, view, target))
    word_links, morph_links, mwes, exs = 0, 0, 0, []
    examples = max(0, min(int(examples or 3), 20))
    if not ws.prefer_scan:
        from .corpus import q_entry_usage
        word_links, morph_links, mwes, exs = q_entry_usage(ws, target['id'], examples)
    seen_mwes = set()
    for doc in (ws.all_docs() if ws.prefer_scan else []):
        tag = ws.doc_tag(doc)
        for s in doc.sentences:
            for w in s.words:
                hit = False
                if w.link and w.link.item_id == target['id']:
                    word_links += 1
                    hit = True
                for l in w.mwes:
                    if l.item_id == target['id']:
                        word_links += 1  # one per member word, as the query path counts tokens
                        seen_mwes.add(l.id)
                        hit = True
                for m in w.morphemes:
                    if m.link and m.link.item_id == target['id']:
                        morph_links += 1
                        hit = True
                if hit and len(exs) < examples:
                    exs.append(f'  {tag}{word_ref(s, w)} {render_word(w, ws.project)[len(w.ref) + 1:]} || {s.text}')
    if ws.prefer_scan:
        mwes = len(seen_mwes)
    lines.append(f'Linked from {word_links} word{"s" if word_links != 1 else ""} and {morph_links} morpheme{"s" if morph_links != 1 else ""}'
                 + (f' ({mwes} multi-word expression{"s" if mwes != 1 else ""})' if mwes else '') + '.')
    if exs:
        lines.append('Examples:')
        lines.extend(exs)
    return _truncate('\n'.join(lines))


def _dictionary_lines(ws: Workspace, view: LexView, target: dict) -> List[str]:
    """An entry's place in its lexicon: the senses under it, what refers to it,
    and its promoted examples."""
    out: List[str] = []
    senses = view.tree.senses_of(target['id'])
    if senses:
        out.append(f'Senses ({len(senses)}):')
        for c in senses:
            out.append(f'  {view.number(c["id"])} {entry_line(c, view)}')
    back = [r for r in references_to(view.items, view.fields, target['id'])]
    if back:
        out.append('Referred to by:')
        for r in back[:12]:
            how = r['field']['name'] if r['field'] else 'a sense of it'
            out.append(f'  {view.label(r["item"]["id"])} ({how})')
        if len(back) > 12:
            out.append(f'  ... {len(back) - 12} more')
    # The plan's own copy, so an example promoted a moment ago is listed
    # (and numbered) the same whether the entry was named by id or by form.
    exs = all_examples({'metadata': _meta_of(ws, target)})
    if exs:
        out.append(f'Usage examples ({len(exs)}):')
        for i, e in enumerate(exs):
            out.append(f'  [{i}] ' + _example_line(ws, e))
    return out


def _example_line(ws: Workspace, e: dict) -> str:
    """One promoted example, resolved to its sentence where it still exists.
    A FLEx import's text examples carry their own text and have no token."""
    if isinstance(e.get('text'), str):
        tr = f' || {e["translation"]}' if e.get('translation') else ''
        return f'{e["text"]}{tr} (imported text)'
    try:
        doc = ws.doc(e['document'])
    except ToolError:
        return f'a document that is gone ({e["document"]})'
    for sent in doc.sentences:
        for w in sent.words:
            if w.id == e['token']:
                return f'{ws.doc_tag(doc)}{word_ref(sent, w)} {w.surface} || {sent.text}'
    return f'{ws.doc_tag(doc)}a word that is gone ({e["token"]})'


def _norm_value(v: str) -> str:
    v = unicodedata.normalize('NFKC', v or '').casefold()
    return ''.join(ch for ch in v if ch.isalnum())


def linked_form(u) -> str:
    """The entry a word or morpheme is linked to, by form: its own link, else
    the multi-word expression it belongs to, else ``?``."""
    if u.link:
        return u.link.form
    mwes = getattr(u, 'mwes', None)
    return mwes[0].form if mwes else '?'


def t_check_consistency(ws: Workspace, field: str, document: Optional[str] = None) -> str:
    """A deterministic consistency report for one field: values that are
    spelling/case variants of each other, forms carrying several different
    values, and items annotated in this field but not linked to the lexicon
    (or linked but empty)."""
    f = ws.project.field(field)
    if not ws.use_scan(document):
        from .corpus import q_consistency
        values, by_form, (unlinked_n, unlinked), (linked_empty_n, linked_empty) = q_consistency(ws, f)
        return _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty)
    docs = [ws.doc(document)] if document else ws.all_docs()
    values: Counter = Counter()
    by_form: Dict[str, Counter] = {}
    unlinked: List[str] = []
    unlinked_n = 0
    linked_empty: List[str] = []
    linked_empty_n = 0
    for doc in docs:
        tag = ws.doc_tag(doc, len(docs) > 1)
        for s in doc.sentences:
            if f.scope == 'Sentence':
                sp = s.fields.get(f.name)
                if sp and sp.value != '':
                    values[sp.value] += 1
                continue
            for w in s.words:
                units = [(w, w.surface, f'{tag}{word_ref(s, w)}')] if f.scope == 'Word' else \
                    [(m, m.form, f'{tag}{word_ref(s, w)}.m{m.index}') for m in w.morphemes]
                for u, form, ref in units:
                    sp = u.fields.get(f.name)
                    val = sp.value if sp else ''
                    if val != '':
                        values[val] += 1
                        by_form.setdefault(form.casefold(), Counter())[val] += 1
                        if not u.link and not getattr(u, 'mwes', None):
                            unlinked_n += 1
                            if len(unlinked) < 15:
                                unlinked.append(f'{ref} {form} ({val})')
                    elif u.link or getattr(u, 'mwes', None):
                        linked_empty_n += 1
                        if len(linked_empty) < 15:
                            linked_empty.append(f'{ref} {form} → {linked_form(u)}')
    return _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty)


def _consistency_lines(ws, f, values, by_form, unlinked_n, unlinked, linked_empty_n, linked_empty) -> str:
    lines = [f'Consistency of {f.name} ({f.scope} field): {sum(values.values())} values, {len(values)} distinct.']
    groups: Dict[str, List[str]] = {}
    for v in values:
        groups.setdefault(_norm_value(v), []).append(v)
    variants = [g for g in groups.values() if len(g) > 1]
    if variants:
        lines.append(f'{len(variants)} value{"s" if len(variants) != 1 else ""} spelled more than one way:')
        for g in sorted(variants, key=lambda g: (-sum(values[v] for v in g), sorted(g)))[:40]:
            lines.append('  ' + ' / '.join(f'{v} ({values[v]})' for v in sorted(g, key=lambda v: (-values[v], v))))
    else:
        lines.append('No spelling or case variants among values.')
    if f.scope != 'Sentence':
        multi = {form: c for form, c in by_form.items() if len(c) > 1}
        if multi:
            lines.append(f'{len(multi)} {"morpheme" if f.scope == "Morpheme" else "word"} form{"s" if len(multi) != 1 else ""} with several {f.name} values (homonymy or inconsistency):')
            for form, c in sorted(multi.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))[:40]:
                lines.append(f'  {form}: ' + ', '.join(f'{v} ({n})' for v, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))))
        else:
            lines.append(f'Every form carries a single {f.name} value.')
        by_value: Dict[str, Counter] = {}
        for form, c in by_form.items():
            for v, n in c.items():
                by_value.setdefault(v, Counter())[form] += n
        shared = {v: c for v, c in by_value.items() if len(c) > 1}
        if shared:
            lines.append(f'{len(shared)} {f.name} value{"s" if len(shared) != 1 else ""} carried by several forms (allomorphy or a gloss collision):')
            for v, c in sorted(shared.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:25]:
                lines.append(f'  {v}: ' + ', '.join(f'{form} ({n})' for form, n in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[:8]) + (' …' if len(c) > 8 else ''))
        if ws.project.vocabs:
            lines.append(f'{unlinked_n} annotated but not linked to the lexicon'
                         + (': ' + '; '.join(unlinked) + (' …' if unlinked_n > len(unlinked) else '') if unlinked else '.'))
            lines.append(f'{linked_empty_n} linked but with no {f.name} value'
                         + (': ' + '; '.join(linked_empty) + (' …' if linked_empty_n > len(linked_empty) else '') if linked_empty else '.'))
    return _truncate('\n'.join(lines))


# How far back recent_changes looks when no `since` is given, widening until
# it has enough entries: the audit endpoint pages from the OLDEST entry, so
# an unbounded read of a long-lived project would fetch its whole history to
# show the newest twenty.
AUDIT_WINDOWS_DAYS = (7, 30, 180, 730, None)


def _audit_entries(ws: Workspace, document: Optional[str], start: Optional[str], keep) -> list:
    """The audit entries at or after ``start`` that ``keep`` accepts."""
    if document:
        did = ws.resolve_document_id(document)
        entries = ws.client.documents.audit(did, start_time=start)
    else:
        entries = ws.client.projects.audit(ws.project.id, start_time=start)
    return [e for e in entries or [] if keep(e)]


def t_recent_changes(ws: Workspace, document: Optional[str] = None, limit: int = 20,
                     since: Optional[str] = None, user: Optional[str] = None) -> str:
    """The newest entries of the audit log: who changed what, when, under
    which operation label (the assistant's own applied plans included).
    `since` is a date (YYYY-MM-DD) or timestamp; `user` matches the actor's
    name or email. Without `since`, recent windows are read first and
    widened until `limit` entries are in hand."""
    import datetime
    limit = max(1, min(int(limit or 20), 100))
    ws.on_progress('Reading the change history…')
    u = (user or '').casefold()

    def keep(e):
        return not u or u in ((e.get('user') or {}).get('display_name') or '').casefold() \
            or u in ((e.get('user') or {}).get('id') or '').casefold()

    if since:
        start = since.strip()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start):
            start += 'T00:00:00Z'
        entries = _audit_entries(ws, document, start, keep)
    else:
        now = datetime.datetime.now(datetime.timezone.utc)
        entries = []
        for days in AUDIT_WINDOWS_DAYS:
            start = (now - datetime.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ') if days else None
            entries = _audit_entries(ws, document, start, keep)
            if len(entries) >= limit:
                break
    entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=True)[:limit]
    if not entries:
        return 'No changes recorded.'
    lines = [f'{len(entries)} most recent change{"s" if len(entries) != 1 else ""}'
             + (f' since {since}' if since else '') + (f' by "{user}"' if user else '')
             + ' (newest first; as_of= is the moment right after that change, for restore_document):']
    for e in entries:
        who = (e.get('user') or {}).get('display_name') or (e.get('user') or {}).get('id') or '?'
        when = (e.get('time') or '')[:16].replace('T', ' ')
        after = e.get('end_time') or e.get('time') or ''
        ops = e.get('ops') or []
        kinds: Counter = Counter(o.get('type') for o in ops)
        what = e.get('message') or (ops[0].get('description') if len(ops) == 1 and ops else
                                    ', '.join(f'{n}× {k}' for k, n in kinds.most_common(4)))
        docs = ', '.join(f'"{d.get("name")}"' for d in (e.get('documents') or [])[:3])
        lines.append(f'  {when}  {who}: {what}' + (f'  [{docs}]' if docs else '')
                     + (f'  ({len(ops)} ops)' if len(ops) > 1 else '') + f'  as_of={after}')
    return _truncate('\n'.join(lines))


def t_plan_status(ws: Workspace) -> str:
    if not ws.ops:
        return 'The plan is empty.'
    lines = [f'{len(ws.ops)} planned change{"s" if len(ws.ops) != 1 else ""} (nothing written yet):']
    lines.extend(f'  {i + 1}. {op["label"]}' for i, op in enumerate(ws.ops[:200]))
    if len(ws.ops) > 200:
        lines.append(f'  ... {len(ws.ops) - 200} more')
    return '\n'.join(lines)


# --- write tools (plan only) ---------------------------------------------------

FLEX_MORPH_TYPES = ['stem', 'bound stem', 'root', 'bound root', 'prefix', 'suffix', 'infix', 'circumfix',
                    'simulfix', 'suprafix', 'infixing interfix', 'prefixing interfix', 'suffixing interfix',
                    'clitic', 'enclitic', 'proclitic', 'particle', 'phrase', 'discontiguous phrase']


def morph_type(t: str) -> str:
    """The editor's controlled morph-type vocabulary (FLEx's inventory)."""
    k = (t or '').strip().lower()
    if k in FLEX_MORPH_TYPES:
        return k
    raise ToolError(f'Unknown morph type "{t}". Types: ' + ', '.join(FLEX_MORPH_TYPES))


def _need(obj, kind, ref):
    if not isinstance(obj, kind):
        want = {Sentence: 'a sentence (sN)', Word: 'a word (sN.wN)', Morpheme: 'a morpheme (sN.wN.mN)'}[kind]
        raise ToolError(f'{ref} is not {want}')
    return obj


def t_set_field(ws: Workspace, document: str, refs, field: str, value: str) -> str:
    f = ws.project.field(field)
    doc = ws.doc(document)
    value = '' if value is None else str(value)
    kind = {'Word': Word, 'Morpheme': Morpheme, 'Sentence': Sentence}[f.scope]
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        obj = _need(resolve(doc, ref), kind, ref)
        old = obj.fields.get(f.name)
        if (old.value if old else '') == value:
            continue
        what = obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)
        staged.append(span_op(ws, doc, ref, what, f, obj.id, old, value))
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def span_op(ws: Workspace, doc, ref: str, what: str, f, token_id: str, old, value: str) -> Dict[str, Any]:
    """A set_span op with its human label. ``old`` is the current Span or None."""
    return {'kind': 'set_span', 'layer_id': f.layer_id, 'token_id': token_id,
            'span_id': old.id if old else None, 'value': value,
            'label': f'{ws.doc_label(doc.id)} {ref} "{what[:40]}": {f.name} '
                     + (f'"{old.value}" → "{value}"' if old and old.value != '' else f'= "{value}"')
                     + (' (cleared)' if value == '' else '')}


MAX_ANALYSES_PER_CALL = 200


def t_set_analysis(ws: Workspace, document: str, ref: Optional[str] = None, morphemes: Optional[list] = None,
                   analyses: Optional[list] = None) -> str:
    """PLAN: one word's analysis (``ref`` + ``morphemes``), or several words'
    at once (``analyses``: a list of {ref, morphemes}), so a whole sentence
    is one call. Staged together: a bad item leaves nothing planned."""
    if not ws.project.morpheme_layer_id:
        raise ToolError('This project has no morpheme layer.')
    doc = ws.doc(document)
    items = list(analyses or [])
    if ref or morphemes:
        items.insert(0, {'ref': ref, 'morphemes': morphemes})
    if not items:
        raise ToolError('Give ref and morphemes, or analyses (a list of {ref, morphemes}).')
    if len(items) > MAX_ANALYSES_PER_CALL:
        raise ToolError(f'At most {MAX_ANALYSES_PER_CALL} analyses per call; split the list.')
    staged: List[Dict[str, Any]] = []
    notes: List[str] = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not item.get('ref'):
            raise ToolError('each analysis needs a ref (sN.wN) and morphemes')
        r = str(item['ref']).strip()
        w = _need(resolve(doc, r), Word, r)
        if w.id in seen:
            raise ToolError(f'{r} is analysed twice in one call')
        seen.add(w.id)
        out = parse_analysis(ws, item.get('morphemes'))
        existing = [{'id': m.id, 'span_ids': [sp.id for sp in m.fields.values()]} for m in w.morphemes]
        had_values = sum(1 for m in w.morphemes for sp in m.fields.values() if sp.value != '')
        op, note = analysis_op(ws, f'{ws.doc_label(doc.id)} {r} "{w.surface}"', w.surface, w.id, w.text_id, w.begin,
                               w.end, existing, segmentation(w) if w.morphemes else '', had_values, out)
        staged.append(op)
        if note:
            notes.append(f'{r}{note}' if len(items) > 1 else note)
    ws.add_ops(staged)
    return ws.planned_note(len(staged)) + (' ' + ' '.join(notes) if notes else '')


def parse_analysis(ws: Workspace, morphemes: list) -> List[Dict[str, Any]]:
    """The validated morpheme list of a set_analysis call."""
    if not morphemes or not isinstance(morphemes, list):
        raise ToolError('morphemes must be a non-empty list of {form, type?, fields?}')
    out = []
    for m in morphemes:
        if not isinstance(m, dict) or not (m.get('form') or '').strip():
            raise ToolError('each morpheme needs a non-empty form')
        if m.get('type'):
            m = {**m, 'type': morph_type(m['type'])}
        fvals = []
        for name, val in (m.get('fields') or {}).items():
            f = ws.project.field(name)
            if f.scope != 'Morpheme':
                raise ToolError(f'"{f.name}" is a {f.scope} field, not a morpheme field; use set_field for it')
            fvals.append({'layer_id': f.layer_id, 'value': '' if val is None else str(val)})
        out.append({'form': m['form'].strip(), 'morph_type': m.get('type') or None, 'fields': fvals})
    return out


def analysis_op(ws: Workspace, head: str, surface: str, word_id: str, text_id: str, begin: int, end: int,
                existing: List[Dict[str, Any]], current_seg: str, had_values: int, out: List[Dict[str, Any]]):
    """A set_analysis op with its label, and the allomorphy note if the forms
    do not add up to the surface."""
    joined = ''.join(m['form'] for m in out)
    if joined.replace(' ', '') != surface.replace(' ', ''):
        note = f' (note: forms "{joined}" differ from the surface "{surface}"; that is allowed for allomorphy)'
    else:
        note = ''
    desc = '-'.join(m['form'] for m in out)
    gloss_bits = []
    for f in ws.project.fields_by_scope('Morpheme'):
        vals = [next((fv['value'] for fv in m['fields'] if fv['layer_id'] == f.layer_id), '_') for m in out]
        if any(v not in ('', '_') for v in vals):
            gloss_bits.append(f'{f.name} {"-".join(v or "_" for v in vals)}')
    op = {'kind': 'set_analysis', 'word_id': word_id, 'text_id': text_id, 'begin': begin, 'end': end,
          'morpheme_layer_id': ws.project.morpheme_layer_id, 'existing': existing, 'morphemes': out,
          'label': f'{head}: ' + (f'{current_seg} → ' if current_seg else '')
                   + desc + (', ' + ', '.join(gloss_bits) if gloss_bits else '')
                   + (f' (replaces {had_values} existing morpheme value{"s" if had_values != 1 else ""})' if had_values else '')}
    return op, note


def t_set_orthography(ws: Workspace, document: str, refs, orthography: str, value: str) -> str:
    o = ws.project.orthography(orthography)
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    for ref in _refs(refs):
        w = _need(resolve(doc, ref), Word, ref)
        old = w.orthographies.get(o, '')
        if old == (value or ''):
            continue
        staged.append({'kind': 'set_orthography', 'word_id': w.id, 'key': f'orthog:{o}', 'value': value or '',
                       'label': f'{ws.doc_label(doc.id)} {ref} "{w.surface}": {o} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


def has_own_form(m: Morpheme) -> bool:
    """A morpheme whose form is stored (not derived from the word's surface)."""
    return (m.metadata or {}).get('form') not in (None, '')


def morpheme_form_op(ws: Workspace, doc, ref: str, w: Word, m: Morpheme, new: str) -> Dict[str, Any]:
    return {'kind': 'set_morpheme_form', 'morpheme_id': m.id, 'form': new,
            'label': f'{ws.doc_label(doc.id)} {ref}.m{m.index} (in "{w.surface}"): morpheme form "{m.form}" → "{new}"'}


def t_respell(ws: Workspace, document: str, ref: str, new_text: str, morpheme_forms: bool = True) -> str:
    doc = ws.doc(document)
    w = _need(resolve(doc, ref), Word, ref)
    new_text = (new_text or '').strip()
    if not new_text:
        raise ToolError('new_text must not be empty (to remove a word from the text, retype_sentence without it; '
                        'delete_word removes only the token)')
    if new_text == w.surface:
        return ws.planned_note(0)
    check_respell_overlap(ws, w.text_id, w.begin, w.end, f'{ws.doc_label(doc.id)} {ref}')
    staged = [{'kind': 'respell', 'text_id': w.text_id, 'begin': w.begin, 'end': w.end, 'value': new_text,
               'label': f'{ws.doc_label(doc.id)} {ref}: respell "{w.surface}" → "{new_text}"'}]
    # A single-morpheme own form spelt like the word follows it; a longer
    # chain cannot be re-derived from a whole-word replacement.
    kept = []
    for m in w.morphemes:
        if not has_own_form(m):
            continue
        if morpheme_forms and m.form == w.surface:
            staged.append(morpheme_form_op(ws, doc, ref, w, m, new_text))
        else:
            kept.append(m.form)
    ws.add_ops(staged)
    note = ws.planned_note(len(staged))
    if kept:
        note += (f' Morpheme forms {", ".join(kept)} are kept as they are; use set_analysis to respell them, '
                 'or respell_all with a pattern to carry the change into morpheme forms.')
    return note


def check_respell_overlap(ws: Workspace, text_id: str, begin: int, end: int, where: str) -> None:
    """A respell may repeat an already planned range (last wins) but never
    overlap a different one: the server applies text edits sequentially and
    overlapping ranges would corrupt the text."""
    for b, e in ws.planned_respells(text_id):
        if (b, e) != (begin, end) and b < end and begin < e:
            raise ToolError(f'{where}: overlaps a respelling already planned for {b}-{e} in the same text; '
                            f'discard_plan or narrow the pattern')
    for op in ws.ops:
        if op.get('kind') == 'edit_text' and op.get('text_id') == text_id and op['begin'] < end:
            raise ToolError(f'{where}: a sentence before or at this point is retyped or appended in this plan; '
                            'respell it in a separate plan')


def t_link_entry(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                 lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                 entry_gloss: Optional[str] = None) -> str:
    doc = ws.doc(document)
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    staged: List[Dict[str, Any]] = []
    inside: List[str] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            raise ToolError(f'{ref}: link words (sN.wN) or morphemes (sN.wN.mN), not sentences')
        if _planned_phrase_over(ws, obj.id):
            raise ToolError(f'{ref} is part of a multi-word expression planned in this turn; a word keeps its own '
                            'link inside one, so drop that plan first if you meant to replace it')
        if kind == 'existing' and obj.link and obj.link.item_id == target['id']:
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        if isinstance(obj, Word) and obj.mwes:
            inside.append(f'{ref} stays inside ' + ', '.join(f'"{l.form}"' for l in obj.mwes))
        staged.append({'kind': 'link', 'token_id': obj.id,
                       'item_id': target['id'] if kind == 'existing' else None,
                       'new_entry_key': target if kind == 'new' else None,
                       'existing_link_id': obj.link.id if obj.link else None,
                       'label': f'{ws.doc_label(doc.id)} {ref} "{what}": link ' + (f'"{obj.link.form}" → ' if obj.link else '') + f'"{form}"'})
    ws.add_ops(staged)
    note = ws.planned_note(len(staged))
    if inside:
        note += ' (' + '; '.join(inside) + ': a word\'s own link and a multi-word expression are separate; unlink_phrase removes the latter)'
    return note


def _planned_phrase_over(ws: Workspace, token_id: str) -> bool:
    return any(op.get('kind') == 'link_phrase' and token_id in (op.get('token_ids') or []) for op in ws.ops)


def _mwe_desc(l: Link, s: Sentence) -> str:
    return f'"{l.form}" ({mwe_ref(l, s.index)})'


def t_unlink_entry(ws: Workspace, document: str, refs) -> str:
    doc = ws.doc(document)
    staged: List[Dict[str, Any]] = []
    only_mwe: List[str] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            continue
        if not obj.link:
            if isinstance(obj, Word) and obj.mwes:
                s = _sentence_of(doc, obj)
                only_mwe.append(f'{ref} has no link of its own; it is a member of the multi-word expression '
                                + ', '.join(_mwe_desc(l, s) for l in obj.mwes) + ' (unlink_phrase removes that)')
            continue
        what = obj.surface if isinstance(obj, Word) else obj.form
        staged.append({'kind': 'unlink', 'link_id': obj.link.id, 'token_id_hint': obj.id,
                       'label': f'{ws.doc_label(doc.id)} {ref} "{what}": unlink "{obj.link.form}"'})
    if only_mwe and not staged:
        raise ToolError('; '.join(only_mwe))
    ws.add_ops(staged)
    return ws.planned_note(len(staged)) + (' ' + '; '.join(only_mwe) if only_mwe else '')


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


def t_link_phrase(ws: Workspace, document: str, refs, entry_form: Optional[str] = None,
                  lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                  entry_gloss: Optional[str] = None) -> str:
    """PLAN: one lexicon link over two or more words (a multi-word
    expression), the editor's gather-and-link gesture. The words keep their
    own links; a multi-word expression already over exactly these words is
    replaced, any other one they belong to stays."""
    doc = ws.doc(document)
    words = _words_of(doc, refs)
    if len(words) < 2:
        raise ToolError('A multi-word expression needs two or more distinct words, e.g. ["s3.w2", "s3.w3"]')
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    form = target.get('form') if kind == 'existing' else ws.new_entries[target]['form']
    token_ids = [w.id for _, _, w in words]
    existing = None
    for _, _, w in words:
        for l in w.mwes:
            if sorted(l.tokens) == sorted(token_ids):
                existing = l
    if existing is not None and kind == 'existing' and existing.item_id == target['id']:
        return ws.planned_note(0)
    s = words[0][1]
    surfaces = ' '.join(w.surface for _, _, w in words)
    where = '+'.join(f'w{w.index}' for _, _, w in words) if all(sn is s for _, sn, _ in words) \
        else '+'.join(word_ref(sn, w) for _, sn, w in words)
    # A planned unlink of the link being replaced would delete it twice.
    if existing is not None:
        before = len(ws.ops)
        ws.ops = [op for op in ws.ops if not (op.get('kind') == 'unlink' and op.get('link_id') == existing.id)]
        ws.replaced += before - len(ws.ops)
    ws.add_op({'kind': 'link_phrase', 'token_ids': token_ids,
               'item_id': target['id'] if kind == 'existing' else None,
               'new_entry_key': target if kind == 'new' else None,
               'existing_link_id': existing.id if existing is not None else None,
               'label': f'{ws.doc_label(doc.id)} s{s.index} {where} "{surfaces}": link phrase '
                        + (f'"{existing.form}" → ' if existing is not None else '') + f'"{form}"'})
    return ws.planned_note(1)


def t_unlink_phrase(ws: Workspace, document: str, refs) -> str:
    """PLAN: remove a multi-word expression (the link shared by its member
    words); the words' own links stay. Name any member, or several members
    where a word sits in more than one expression."""
    doc = ws.doc(document)
    words = _words_of(doc, refs)
    if not words:
        raise ToolError('Name at least one member word, e.g. ["s3.w2"]')
    named = {w.id for _, _, w in words}
    candidates: Dict[str, Link] = {}
    for _, _, w in words:
        for l in w.mwes:
            candidates[l.id] = l
    s = words[0][1]
    if not candidates:
        raise ToolError(', '.join(r for r, _, _ in words) + ' belong to no multi-word expression'
                        + (' (unlink_entry removes a word\'s own link)' if any(w.link for _, _, w in words) else ''))
    # Every named word must be a member; among the expressions they name,
    # the one containing all of them wins, else ask.
    full = [l for l in candidates.values() if named <= set(l.tokens)]
    if len(full) != 1:
        raise ToolError('Several multi-word expressions include those words: '
                        + '; '.join(_mwe_desc(l, s) for l in candidates.values())
                        + '. Name a member set that belongs to just one of them.')
    l = full[0]
    ws.add_op({'kind': 'unlink', 'link_id': l.id, 'token_id_hint': l.tokens[0], 'token_ids': list(l.tokens),
               'label': f'{ws.doc_label(doc.id)} s{s.index} {mwe_ref(l, s.index)}: unlink phrase "{l.form}"'})
    return ws.planned_note(1)


def t_create_entry(ws: Workspace, form: str, lexicon: Optional[str] = None, fields: Optional[dict] = None,
                   type: Optional[str] = None) -> str:
    return _create_entry(ws, ws.project.vocab(lexicon), form, fields, type, None)


def _create_entry(ws: Workspace, v: dict, form: str, fields: Optional[dict],
                  morph: Optional[str], parent: Optional[dict]) -> str:
    """A new entry, or a new sense when ``parent`` is the entry it sits under."""
    form = (form or '').strip()
    if not form:
        raise ToolError('form must not be empty')
    view = ws.view(v)
    metadata: dict = {}
    for k, val in (fields or {}).items():
        f = lexicon_field(v, k)
        if parent is not None and f['scope'] == SCOPE_ENTRY:
            # The HEADWORD the sense will sit under, which is not the parent
            # when the parent is itself a sense: naming the parent sends the
            # reader to something that refuses the same write.
            head = view.tree.root_of.get(parent['id']) or parent['id']
            raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense, so a new sense '
                            f'cannot carry it. Set it on {view.label(head)}.')
        metadata = _entry_field_write(ws, v, f, val, metadata, None)
    if morph:
        metadata['morphType'] = morph_type(morph)
    if parent is not None:
        # The tree is the lexicon as the SERVER has it, so the senses this plan
        # has already added to the same entry are counted here as well: without
        # that, two add_sense calls in one plan both take the same number.
        planned = sum(1 for e in ws.new_entries.values()
                      if (e.get('metadata') or {}).get('parent') == parent['id'])
        metadata = with_parent(metadata, parent['id'],
                               next_sense_order(view.tree, parent['id']) + planned)
    # The key is a handle the model passes back; it must not contain spaces
    # (a phrase entry's form does).
    # CI runs Python 3.11, which refuses a backslash inside an f-string
    # expression, so the slug is made first.
    slug = re.sub(r'\s+', '_', form)
    key = f'new:{v["id"]}:{slug}#{len(ws.new_entries) + 1}'
    ws.new_entries[key] = {'form': form, 'vocab_id': v['id'], 'metadata': metadata}
    what = (f'new sense of {view.label(parent["id"])} ' if parent is not None else 'new entry ')
    ws.add_op({'kind': 'create_entry', 'vocab_id': v['id'], 'form': form, 'metadata': metadata, 'key': key,
               'label': f'{v["name"]}: ' + what + entry_line({'form': form, 'metadata': metadata}, view)})
    return ws.planned_note(1) + f'\nentry_id: {key}  (use it to link this entry in the same plan)'


# Which tool owns each reserved key, for the refusal when one is set as a field.
_RESERVED_HINTS = {
    'parent': 'Where an entry sits is changed with add_sense, make_sense_of or free_sense.',
    'senseorder': 'A sense is renumbered with move_sense.',
    'examples': 'Usage examples are added with promote_example and dropped with remove_example.',
    'form': 'A headword is changed with rename_entry.',
    'homograph': 'The order of entries spelled the same is set with order_homographs.',
}

_FREE_FIELD = {'name': '', 'inline': False, 'immutable': False, 'tagset': None, 'lang': None,
               'type': FIELD_TEXT, 'many': False, 'scope': SCOPE_SENSE}


def lexicon_field(vocab: dict, name: str) -> dict:
    """A lexicon's configured entry field, by case-insensitive name, as its full
    spec; any name when the lexicon declares no schema. morphType is always
    allowed. A reserved key is never a field, and says which tool owns it."""
    if is_reserved_field_name(name):
        hint = _RESERVED_HINTS.get(str(name).strip().lower(),
                                   'It is structure the app keeps on an entry, not a field.')
        raise ToolError(f'"{name}" is not an entry field. {hint}')
    fields = vocab.get('fields') or []
    hit = field_by_name(fields, name)
    if hit:
        return hit
    # A lexicon that declares nothing has no schema to break, so any name goes.
    # The core inventory rides along on every vocabulary and never counts as one.
    if not any(f.get('declared') for f in fields) or name == 'morphType':
        return {**_FREE_FIELD, 'name': name}
    raise ToolError(f'"{vocab["name"]}" has no entry field "{name}". Fields: '
                    + ', '.join(vocab_field_summary(vocab)))


def _hits_in(ws: Workspace, v: dict, form: str, suffix: Optional[str], has_gloss,
             deep: bool = False) -> List[dict]:
    """The entries a form names in one lexicon, by that lexicon's own rules."""
    view = ws.view(v)
    return [it for it in _dict_hits(view, form, suffix, deep) if has_gloss(it.get('metadata'), view)]


def _resolve_ref(ws: Workspace, vocab: dict, field: dict, value: str, own_id: Optional[str]) -> str:
    """The id of the entry a reference field should hold, from a form or an id.
    References never cross vocabularies, so only this lexicon is searched."""
    view = ws.view(vocab)
    if value in view.tree.by_id:
        target = value
    elif value in ws.new_entries:
        raise ToolError(f'"{field["name"]}" must name an entry that already exists. "{value}" is created by this '
                        'same plan and has no id until it is approved: approve the plan, then set the reference.')
    else:
        form, suffix = value, None
        if '#' in value:
            form, _, suffix = value.rpartition('#')
            suffix = suffix.strip()
        hits = _hits_in(ws, vocab, form, suffix, lambda m, v: True)
        if not hits:
            raise ToolError(f'"{vocab["name"]}" has no entry "{value}" for {field["name"]} to refer to. '
                            'read_lexicon lists them, and a reference always names an entry of the same lexicon.')
        if len(hits) > 1:
            lines = [f'"{value}" names several entries, so {field["name"]} cannot tell which. '
                     'Pass one of these forms, or its id:']
            for it in hits:
                addr = view.address(it['id'])
                shown = f' form={addr}' if addr != (it.get('form') or '') else ''
                lines.append(f'  id={it["id"]}{shown} {entry_line(it, view)}')
            raise ToolError('\n'.join(lines))
        target = hits[0]['id']
    if own_id and target == own_id:
        raise ToolError(f'{view.label(own_id)} cannot refer to itself through {field["name"]}.')
    return target


def _entry_field_write(ws: Workspace, vocab: Optional[dict], field: dict, value,
                       metadata: Optional[dict], own_id: Optional[str]) -> dict:
    """The metadata an entry carries once ``field`` is set to ``value``. A text
    field takes the string. A reference field holds entry ids, so a form is
    resolved to one here; a `many` field appends, and an empty value clears the
    field outright."""
    if field['type'] != FIELD_ITEM or vocab is None:
        return {**(metadata or {}), field['name']: '' if value is None else str(value)}
    v = '' if value is None else str(value).strip()
    if not v:
        return with_ref_ids(metadata, field, [])
    target = _resolve_ref(ws, vocab, field, v, own_id)
    held = ref_ids({'metadata': metadata}, field) if field.get('many') else []
    return with_ref_ids(metadata, field, held + [target])


def t_set_entry_field(ws: Workspace, field: str, value: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                      entry_gloss: Optional[str] = None) -> str:
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'existing':
        _refuse_doomed(ws, target['id'], 'take a value')
    vocab = (next((v for v in ws.project.vocabs if v['id'] == ws.new_entries[target]['vocab_id']), None)
             if kind == 'new' else ws.vocab_of_item(target['id']))
    f = lexicon_field(vocab, field) if vocab else {**_FREE_FIELD, 'name': field}
    if kind == 'new':
        e = ws.new_entries[target]
        if vocab and f['scope'] == SCOPE_ENTRY and parent_of(e):
            raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense.')
        e['metadata'] = _entry_field_write(ws, vocab, f, value, e['metadata'], None)
        for op in ws.ops:
            if op.get('kind') == 'create_entry' and op.get('key') == target:
                op['metadata'] = dict(e['metadata'])
        return ws.planned_note(0) + ' (updated the pending new entry)'
    view = ws.view(vocab) if vocab else None
    if view is not None and f['scope'] == SCOPE_ENTRY and view.is_sense(target['id']):
        head = view.tree.root_of.get(target['id'])
        raise ToolError(f'"{f["name"]}" belongs to a headword rather than to each sense, and '
                        f'{view.label(target["id"])} is a sense. Set it on {view.label(head)} instead.')
    before = ws.item_patches.get(target['id'], target.get('metadata') or {})
    meta = _entry_field_write(ws, vocab, f, value, before, target['id'])
    ws.patch_item(target['id'], meta)
    new_value = meta.get(f['name'])
    where = view.label(target['id']) if view is not None else f'"{target.get("form")}"'
    if f['type'] == FIELD_ITEM and view is not None:
        shown = ', '.join(view.label(x) for x in ref_ids({'metadata': meta}, f)) or '(cleared)'
    else:
        old = before.get(f['name'], '')
        shown = f'"{old}" → "{value}"' if old else f'= "{value}"'
    ws.add_op({'kind': 'set_entry_field', 'item_id': target['id'], 'field': f['name'],
               'value': new_value if new_value is not None else '',
               'label': f'entry {where}: {f["name"]} {shown}'})
    return ws.planned_note(1)


def _meta_patch(before: dict, after: dict) -> dict:
    """The patch turning one metadata map into another. A key the new map lacks
    is sent as null, which is how the API deletes it."""
    patch = {k: v for k, v in after.items() if before.get(k) != v}
    for k in before:
        if k not in after:
            patch[k] = None
    return patch


def _meta_op(ws: Workspace, item_id: str, before: dict, after: dict, label: str) -> Dict[str, Any]:
    """One entry's metadata change, recorded so later tools in the same turn
    read the tree this plan is building."""
    ws.patch_item(item_id, after)
    return {'kind': 'set_entry_metadata', 'item_id': item_id, 'patch': _meta_patch(before, after),
            'label': label}


def _dict_entry(ws: Workspace, entry_form, lexicon, entry_id, entry_gloss, what: str):
    """The entry a lexicon tool names, with its lexicon's view."""
    kind, target = ws.find_entry(entry_form, lexicon, entry_id, entry_gloss)
    if kind == 'new':
        raise ToolError(f'"{ws.new_entries[target]["form"]}" is created by this same plan and has no id until it '
                        f'is approved, so it cannot {what} yet.')
    # find_entry found this item by scanning the project's own lexicons, which
    # is the list vocab_of_item scans, so the lookup lands.
    vocab = ws.vocab_of_item(target['id'])
    view = ws.view(vocab)
    _refuse_doomed(ws, target['id'], what)
    return vocab, view, target


def _refuse_doomed(ws: Workspace, item_id: str, what: str):
    """A delete already planned takes the entry's senses and references with
    it, so anything hung on it afterwards would be written and then dropped."""
    doomed = ({op['item_id'] for op in ws.ops if op.get('kind') == 'delete_entry'}
              | {op['remove_id'] for op in ws.ops if op.get('kind') == 'merge_entries'})
    if item_id in doomed:
        view = ws.view_of_item(item_id)
        name = view.label(item_id) if view else item_id
        raise ToolError(f'{name} is deleted or merged away by this same plan, so it cannot '
                        f'{what}. Drop that change with drop_planned, or work on the entry that survives.')


def _meta_of(ws: Workspace, item: dict) -> dict:
    return ws.item_patches.get(item['id'], item.get('metadata') or {})


def t_add_sense(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                entry_id: Optional[str] = None, entry_gloss: Optional[str] = None,
                fields: Optional[dict] = None, form: Optional[str] = None,
                type: Optional[str] = None) -> str:
    """PLAN: add a sense under an entry, numbered after the senses it has."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'take a sense')
    # A sense is shown under its entry's headword and carries it unless told
    # otherwise, which is how an imported lexicon reads.
    return _create_entry(ws, vocab, form or target.get('form') or '', fields, type, target)


def t_move_sense(ws: Workspace, number, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                 entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: put a sense at the number it should be shown with, among its siblings."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renumbered')
    if not view.is_sense(target['id']):
        raise ToolError(f'{view.label(target["id"])} is a headword, and a headword is not numbered among '
                        'senses. make_sense_of moves it under another entry.')
    was = view.number(target['id'])
    # A sense is shown with a dotted number ("2.1.3"), but it moves among its
    # own siblings, so only the last segment says where it should land.
    raw = str(number).strip().rsplit('.', 1)[-1]
    try:
        wanted = int(round(float(raw)))
    except (TypeError, ValueError, OverflowError):
        raise ToolError(f'"{number}" is not a sense number. Give the place among the senses of '
                        f'{view.label(view.tree.root_of.get(target["id"]) or target["id"])}, '
                        'counting from 1.')
    patches = plan_sense_set_number(view.tree, target['id'], wanted)
    if not patches:
        sibs = len(view.tree.senses_of(view.tree.parent_of[target['id']]))
        return ws.planned_note(0) + (f' {view.label(target["id"])} is already sense {was}'
                                     + (' and has no siblings to move among.' if sibs < 2 else '.'))
    by_id = {x['id']: x for x in patches}
    # A number past either end lands at the nearest one, so the plan says where
    # the sense actually goes rather than what was asked for.
    landed = (by_id.get(target['id']) or {}).get('metadata', {}).get(SENSE_ORDER_KEY, wanted)
    # Said as the DOTTED number the user will see, not the raw order: a move
    # only ever changes the last segment, so "1.1" going to place 2 is "1.2".
    landed_shown = '.'.join(was.split('.')[:-1] + [str(landed)])
    # The entry's own name, not its bare form: two entries can share the form.
    head = view.label(view.tree.root_of.get(target['id']) or target['id'])
    others = len(patches) - 1
    moved = f'entry {head}: sense {was} becomes sense {landed_shown}'
    ops = []
    for x in patches:
        # The line describing the move belongs on the sense that moves, not on
        # whichever sibling the renumbering happens to list first.
        if x['id'] == target['id']:
            label = moved + (f' ({others} sibling{"s" if others != 1 else ""} renumbered)'
                             if others else '')
        else:
            label = f'entry {head}: sense {view.number(x["id"])} renumbered'
        ops.append(_meta_op(ws, x['id'], _meta_of(ws, view.tree.by_id[x['id']]), x['metadata'], label))
    ws.add_ops(ops)
    # A sense already carrying the order it lands on gets no patch of its own,
    # so nothing above would say it moved. It did: the siblings around it are
    # what changed, and the plan has to name the gesture that caused them.
    if target['id'] not in by_id:
        ops[0]['label'] = f'{moved} ({ops[0]["label"]})' if ops else moved
    return ws.planned_note(len(ops))


def t_make_sense_of(ws: Workspace, under_form: Optional[str] = None, under_id: Optional[str] = None,
                    entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                    entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: move an entry (with everything under it) to be a sense of another."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be moved')
    _, under_view, under = _dict_entry(ws, under_form, lexicon, under_id, None, 'take a sense')
    if under_view.vocab['id'] != vocab['id']:
        raise ToolError('A sense sits under an entry of the same lexicon; these are in different ones.')
    if under['id'] == target['id']:
        raise ToolError('An entry cannot be a sense of itself.')
    if under['id'] in {d['id'] for d in descendants_of(view.tree, target['id'])}:
        raise ToolError(f'{under_view.label(under["id"])} is already below {view.label(target["id"])}, so moving '
                        'it there would make a loop. Free it first.')
    before = _meta_of(ws, target)
    # Senses this same plan adds under the entry take the orders after its
    # own, so two writes never claim one place.
    planned = sum(1 for e in ws.new_entries.values()
                  if (e.get('metadata') or {}).get('parent') == under['id'])
    after = with_parent(before, under['id'], next_sense_order(view.tree, under['id']) + planned)
    if before.get('parent') == under['id']:
        return ws.planned_note(0) + f' {view.label(target["id"])} is already a sense of {view.label(under["id"])}.'
    kept = len(descendants_of(view.tree, target['id']))
    # A headword-only field's value stays on the entry but is shown on a
    # headword alone, so the card says which values go out of sight.
    hidden = sorted(k for k in view.hidden_fields({**target, 'metadata': after})
                    if before.get(k) not in (None, ''))
    ws.add_op(_meta_op(ws, target['id'], before, after,
                       f'{view.label(target["id"])} becomes a sense of {view.label(under["id"])}'
                       + (f' (with {kept} below it)' if kept else '')
                       + (f'; {", ".join(hidden)} shown on a headword only' if hidden else '')))
    return ws.planned_note(1)


def t_free_sense(ws: Workspace, entry_form: Optional[str] = None, lexicon: Optional[str] = None,
                 entry_id: Optional[str] = None, entry_gloss: Optional[str] = None) -> str:
    """PLAN: make a sense a headword of its own, keeping everything under it."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be freed')
    if not view.is_sense(target['id']):
        return ws.planned_note(0) + f' {view.label(target["id"])} is already a headword of its own.'
    before = _meta_of(ws, target)
    kept = len(descendants_of(view.tree, target['id']))
    ws.add_op(_meta_op(ws, target['id'], before, with_parent(before, None, None),
                       f'{view.label(target["id"])} becomes a headword of its own'
                       + (f' (with {kept} sense{"s" if kept != 1 else ""} below it)' if kept else '')))
    return ws.planned_note(1)


def t_order_homographs(ws: Workspace, order, entry_form: Optional[str] = None,
                       lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                       entry_gloss: Optional[str] = None) -> str:
    """PLAN: set the order of the entries spelled the same, which is the first
    segment of the number every one of their senses is shown with."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'be renumbered')
    group = homograph_group(view.items, target['id'])
    if not group:
        raise ToolError(f'{view.label(target["id"])} is the only headword spelled that way, so there is '
                        'no order to set.')
    wanted = [str(x).strip() for x in (order if isinstance(order, list) else [order]) if str(x).strip()]
    by_num = {view.number(r['id']): r for r in group}
    ids = []
    for token in wanted:
        # Each entry is named by the number it is shown with now, or by its id.
        r = by_num.get(token.rpartition('#')[2] or token) or next(
            (x for x in group if x['id'] == token), None)
        if r is None:
            raise ToolError(f'"{token}" is not one of the {len(group)} headwords spelled '
                            f'"{group[0].get("form")}". They are numbered '
                            + ', '.join(view.number(r['id']) for r in group) + '.')
        if r['id'] in ids:
            raise ToolError(f'"{token}" is named twice; give each entry once.')
        ids.append(r['id'])
    if len(ids) != len(group):
        raise ToolError(f'Give all {len(group)} headwords spelled "{group[0].get("form")}" in the order they '
                        'should be numbered; ' + str(len(ids)) + ' were given.')
    patches = plan_homograph_order(group, ids)
    if not patches:
        return ws.planned_note(0) + ' They already stand in that order.'
    ops = []
    for x in patches:
        item = view.tree.by_id[x['id']]
        before = _meta_of(ws, item)
        # The STORED number, which is what changes: the number shown is the
        # entry's place in the group, and the write is what puts it there.
        was = homograph_of(item)
        ops.append(_meta_op(ws, x['id'], before, x['metadata'],
                            f'{view.label(x["id"])}: homograph number {was if was is not None else "none"} → '
                            f'{x["metadata"]["homograph"]}'))
    ws.add_ops(ops)
    return ws.planned_note(len(ops))


def t_promote_example(ws: Workspace, document: str, ref: str, entry_form: Optional[str] = None,
                      lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                      entry_gloss: Optional[str] = None) -> str:
    """PLAN: mark a word in a document as a usage example of an entry."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'take an example')
    doc = ws.doc(document)
    found = _words_of(doc, ref)
    if len(found) != 1:
        raise ToolError('Give one word reference, e.g. "s3.w2".')
    _, sent, word = found[0]
    before = _meta_of(ws, target)
    after = with_example_added(before, {'document': doc.id, 'token': word.id})
    if after == before:
        return ws.planned_note(0) + f' {view.label(target["id"])} already has that example.'
    ws.add_op(_meta_op(ws, target['id'], before, after,
                       f'entry {view.label(target["id"])}: usage example '
                       f'{ws.doc_label(doc.id, quote=True)} {word_ref(sent, word)} "{word.surface}"'))
    return ws.planned_note(1)


def t_remove_example(ws: Workspace, index: int, entry_form: Optional[str] = None,
                     lexicon: Optional[str] = None, entry_id: Optional[str] = None,
                     entry_gloss: Optional[str] = None) -> str:
    """PLAN: drop one of an entry's usage examples, by its position."""
    vocab, view, target = _dict_entry(ws, entry_form, lexicon, entry_id, entry_gloss, 'lose an example')
    before = _meta_of(ws, target)
    exs = all_examples({'metadata': before})
    i = int(index)
    if not exs:
        raise ToolError(f'{view.label(target["id"])} has no usage examples.')
    if i < 0 or i >= len(exs):
        raise ToolError(f'{view.label(target["id"])} has {len(exs)} example(s), numbered 0 to {len(exs) - 1}; '
                        'lexicon_entry lists them with their numbers.')
    ws.add_op(_meta_op(ws, target['id'], before, with_example_removed(before, i),
                       f'entry {view.label(target["id"])}: drop usage example [{i}] '
                       + _example_line(ws, exs[i])))
    return ws.planned_note(1)


def t_set_document_metadata(ws: Workspace, document: str, field: str, value: str) -> str:
    names = ws.project.document_metadata
    name = next((n for n in names if n.lower() == (field or '').lower()), None)
    if not name:
        raise ToolError(f'No document metadata field "{field}". Fields: ' + (', '.join(names) or '(none configured)'))
    doc = ws.doc(document)
    old = doc.metadata.get(name, '')
    value = '' if value is None else str(value)
    if (old or '') == value:
        return ws.planned_note(0)
    ws.add_op({'kind': 'set_doc_metadata', 'document_id': doc.id, 'field': name, 'value': value,
               'label': f'{ws.doc_label(doc.id)}: {name} ' + (f'"{old}" → "{value}"' if old else f'= "{value}"')})
    return ws.planned_note(1)


def t_create_document(ws: Workspace, name: str, text: str, metadata: Optional[dict] = None) -> str:
    """PLAN: a new document from raw text. One sentence per line; words are
    split on whitespace and punctuation the way the editor's tokenizer does."""
    name = (name or '').strip()
    if not name:
        raise ToolError('name must not be empty')
    if any((d.get('name') or '').casefold() == name.casefold() for d in ws.documents()):
        raise ToolError(f'A document named "{name}" already exists.')
    text = (text or '').replace('\r\n', '\n')
    if not text.strip():
        raise ToolError('text must not be empty')
    meta = {}
    for k, v in (metadata or {}).items():
        n = next((x for x in ws.project.document_metadata if x.lower() == k.lower()), None)
        if not n:
            raise ToolError(f'No document metadata field "{k}". Fields: ' + (', '.join(ws.project.document_metadata) or '(none)'))
        meta[n] = '' if v is None else str(v)
    sents = split_sentences(text)
    words = sum(len(split_words(text, b, e, ws.project.ignored_cfg)) for b, e in sents)
    ws.add_op({'kind': 'create_document', 'name': name, 'text': text, 'metadata': meta,
               'label': f'New document "{name}": {len(sents)} sentence{"s" if len(sents) != 1 else ""}, {words} words'})
    return ws.planned_note(1) + f' ({len(sents)} sentences, {words} words will be tokenized.)'


def _is_machine(meta) -> bool:
    return prov_state(meta) == MACHINE


def _needs_review(meta) -> bool:
    """Unconfirmed machine output, or a contributor's unreviewed work."""
    return prov_state(meta) in REVIEWABLE


def _review_pieces(obj, f=None, into=None) -> Dict[str, list]:
    """Ids of the pieces of a sentence, word, or morpheme (a sentence includes
    its words) that await review: spans (only field ``f`` when given), links,
    multi-word expressions, and token metadata (only when no field is named).
    A multi-word expression is listed once however many members are seen."""
    out = into if into is not None else {'span_ids': [], 'token_ids': [], 'link_ids': []}
    for name, sp in obj.fields.items():
        if (f is None or name == f.name) and _needs_review(sp.metadata):
            out['span_ids'].append(sp.id)
    if isinstance(obj, Sentence):
        if f is None or f.scope != 'Sentence':
            for w in obj.words:
                _review_pieces(w, f, out)
        return out
    if f is None:
        if obj.link and _needs_review(obj.link.metadata):
            out['link_ids'].append(obj.link.id)
        for l in getattr(obj, 'mwes', ()):
            if _needs_review(l.metadata) and l.id not in out['link_ids']:
                out['link_ids'].append(l.id)
        if _needs_review(obj.metadata):
            out['token_ids'].append(obj.id)
    if isinstance(obj, Word):
        for m in obj.morphemes:
            _review_pieces(m, f, out)
    return out


def _pieces_label(pieces: Dict[str, list]) -> str:
    bits = []
    for key, noun in (('span_ids', 'value'), ('link_ids', 'link'), ('token_ids', 'segmentation')):
        n = len(pieces[key])
        if n:
            bits.append(f'{n} {noun}{"s" if n != 1 else ""}')
    return ', '.join(bits)


def _what(obj) -> str:
    return obj.text if isinstance(obj, Sentence) else (obj.surface if isinstance(obj, Word) else obj.form)


MAX_CONFIRM_DOCS = 100


def _document_confirm_op(ws: Workspace, doc: IgtDoc, f) -> Optional[Dict[str, Any]]:
    pieces = {'span_ids': [], 'token_ids': [], 'link_ids': []}
    for s in doc.sentences:
        _review_pieces(s, f, pieces)
    if not any(pieces.values()):
        return None
    return {'kind': 'confirm', **pieces, 'doc': doc.id,
            'label': f'{ws.doc_label(doc.id)}: confirm {_pieces_label(pieces)}' + (f' ({f.name})' if f else '')}


def t_confirm(ws: Workspace, document: Optional[str] = None, refs=None, field: Optional[str] = None) -> str:
    """PLAN: mark annotations awaiting review (machine-made and unconfirmed,
    or a contributor's) as verified, after checking them. Without a
    document, every document with such material in the project."""
    f = ws.project.field(field) if field else None
    staged: List[Dict[str, Any]] = []
    refs = _refs(refs)
    if refs and not document:
        raise ToolError('refs need a document')
    if not document:
        # The documents with reviewable spans or morphemes by query, then
        # each is read so links and multi-word expressions count too.
        if ws.prefer_scan:
            docs = ws.all_docs()
        else:
            from .corpus import q_review_docs
            ids = q_review_docs(ws, f)
            if len(ids) > MAX_CONFIRM_DOCS:
                raise ToolError(f'{len(ids)} documents have annotations awaiting review, more than the {MAX_CONFIRM_DOCS} '
                                'one plan covers; confirm document by document, or narrow with field.')
            docs = [ws.doc(i) for i in ids]
        for doc in docs:
            op = _document_confirm_op(ws, doc, f)
            if op:
                staged.append(op)
    elif refs:
        doc = ws.doc(document)
        for ref in refs:
            obj = resolve(doc, ref)
            pieces = _review_pieces(obj, f)
            if not any(pieces.values()):
                continue
            staged.append({'kind': 'confirm', **pieces,
                           'label': f'{ws.doc_label(doc.id)} {ref} "{_what(obj)[:40]}": confirm {_pieces_label(pieces)}'
                                    + (f' ({f.name})' if f else '')})
    else:
        op = _document_confirm_op(ws, ws.doc(document), f)
        if op:
            staged.append(op)
    ws.add_ops(staged)
    n = sum(len(v) for op in staged for k, v in op.items() if k.endswith('_ids'))
    if not staged:
        return 'Nothing to confirm: no annotations awaiting review there.'
    return ws.planned_note(len(staged)) + f' ({n} annotation{"s" if n != 1 else ""} will be marked verified' \
        + (f' across {len(staged)} documents' if not document and len(staged) > 1 else '') + '.)'


def t_discard_analysis(ws: Workspace, document: str, refs) -> str:
    """PLAN: delete a word's unverified machine-made analysis (the editor's
    discard gesture): its machine links, values, and morphemes go; human and
    verified pieces stay."""
    doc = ws.doc(document)
    words: List[tuple] = []
    for ref in _refs(refs):
        obj = resolve(doc, ref)
        if isinstance(obj, Sentence):
            words.extend((f'{ref}.{w.ref}', w) for w in obj.words)
        elif isinstance(obj, Word):
            words.append((ref, obj))
        else:
            raise ToolError(f'{ref}: discard_analysis works on words (sN.wN), not single morphemes')
    staged: List[Dict[str, Any]] = []
    for ref, w in words:
        link_ids, span_ids, morpheme_ids = [], [], []
        reset_first = None

        def attached(t):
            if t.link and _is_machine(t.link.metadata):
                link_ids.append(t.link.id)
            span_ids.extend(sp.id for sp in t.fields.values() if _is_machine(sp.metadata))
        attached(w)
        survivors = []
        for i, m in enumerate(w.morphemes):
            if _is_machine(m.metadata) and i > 0:
                morpheme_ids.append(m.id)  # spans and links cascade with the token
                continue
            survivors.append(m)
            attached(m)
            if _is_machine(m.metadata):
                reset_first = m.id
        renumber = [{'id': m.id, 'precedence': i + 1} for i, m in enumerate(survivors) if m.index != i + 1]
        if not (link_ids or span_ids or morpheme_ids or reset_first):
            continue
        bits = _pieces_label({'span_ids': span_ids, 'link_ids': link_ids, 'token_ids': []})
        if morpheme_ids or reset_first:
            bits = (bits + ', ' if bits else '') + 'the segmentation'
        staged.append({'kind': 'discard_analysis', 'word_id': w.id, 'link_ids': link_ids, 'span_ids': span_ids,
                       'morpheme_ids': morpheme_ids, 'reset_first_id': reset_first, 'renumber': renumber,
                       'label': f'{ws.doc_label(doc.id)} {ref} "{w.surface}": discard unverified {bits}'})
    ws.add_ops(staged)
    if not staged:
        return 'Nothing to discard: no machine-made, unconfirmed analysis there.'
    return ws.planned_note(len(staged))


def t_set_morpheme(ws: Workspace, document: str, ref: str, form: Optional[str] = None,
                   type: Optional[str] = None) -> str:
    """PLAN: change one morpheme's form and/or type in place, keeping the
    chain and every value on it (set_analysis replaces the whole chain)."""
    doc = ws.doc(document)
    ref = (ref or '').strip()
    m = _need(resolve(doc, ref), Morpheme, ref)
    word_ref_ = ref.rsplit('.', 1)[0]
    w = resolve(doc, word_ref_)
    if form is None and type is None:
        raise ToolError('Give form and/or type.')
    staged: List[Dict[str, Any]] = []
    if form is not None:
        new = str(form).strip()
        if not new:
            raise ToolError('form must not be empty (set_analysis to remove a morpheme from the chain)')
        if new != m.form:
            staged.append(morpheme_form_op(ws, doc, word_ref_, w, m, new))
    if type is not None:
        t = morph_type(type) if str(type).strip() else None
        if t != (m.morph_type or None):
            staged.append({'kind': 'set_morph_type', 'morpheme_id': m.id, 'morph_type': t,
                           'label': f'{ws.doc_label(doc.id)} {ref} (in "{w.surface}"): morpheme type '
                                    + (f'"{m.morph_type}" → ' if m.morph_type else '= ') + (f'"{t}"' if t else '(cleared)')})
    ws.add_ops(staged)
    return ws.planned_note(len(staged))


# --- comments -------------------------------------------------------------------

MAX_COMMENTS = 200


def _anchor(ws: Workspace, doc: IgtDoc, ref: Optional[str], field: Optional[str]) -> tuple:
    """(entity_type, entity_id, caption, what) for a comment on the document,
    a sentence, a word, a morpheme, or one of their field values. The caption
    is the editor's own (commentAnchors.js), so a thread reads the same in
    the Comments tab whoever posted it."""
    if not ref:
        if field:
            raise ToolError('field needs a ref (the annotated sentence, word, or morpheme)')
        return 'document', doc.id, doc.name or 'This document', doc.name
    obj = resolve(doc, ref)
    if isinstance(obj, Sentence):
        s, w, m = obj, None, None
    else:
        s = resolve(doc, ref.split('.')[0])
        w = obj if isinstance(obj, Word) else resolve(doc, ref.rsplit('.', 1)[0])
        m = obj if isinstance(obj, Morpheme) else None
    where = f'sentence {s.index}'
    if field:
        f = ws.project.field(field)
        sp = obj.fields.get(f.name)
        if not sp:
            raise ToolError(f'{ref} has no {f.name} value to comment on')
        if isinstance(obj, Sentence):
            return 'span', sp.id, f'{f.name} of sentence {s.index}', s.text
        head = f'{f.name} of {m.form}' if m else f'{f.name} of {w.surface}'
        detail = f'in {w.surface}, {where}' if m else where
        return 'span', sp.id, f'{head}, {detail}', m.form if m else w.surface
    if isinstance(obj, Sentence):
        return 'token', s.id, f'Sentence {s.index}', s.text
    if m:
        return 'token', m.id, f'{m.form}, in {w.surface}, {where}', m.form
    return 'token', w.id, f'{w.surface}, {where}', w.surface


def t_comments(ws: Workspace, document: Optional[str] = None, ref: Optional[str] = None,
               field: Optional[str] = None, limit: int = 50) -> str:
    """The comments people have left: on one thing (document + ref, and
    field for one of its values), in one document, or in the whole project;
    oldest first, the newest `limit` shown."""
    limit = max(1, min(int(limit or 50), MAX_COMMENTS))
    ws.on_progress('Reading the comments…')
    doc = ws.doc(document) if document else None
    if ref and doc is None:
        raise ToolError('ref needs a document')
    if doc is not None and ref:
        etype, eid, caption, _ = _anchor(ws, doc, ref, field)
        rows = ws.client.comments.list(ws.project.id, entity_type=etype, entity_id=eid)
        head = f'on {ws.doc_label(doc.id)} {ref}' + (f' {field}' if field else '')
    elif doc is not None:
        rows = ws.client.comments.list(ws.project.id, document_id=doc.id)
        head = f'in {ws.doc_label(doc.id)}'
    else:
        rows = ws.client.comments.list(ws.project.id)
        head = 'in the project'
    rows = sorted(rows or [], key=lambda c: c.get('created_at') or '')
    total = len(rows)
    rows = rows[-limit:]
    if not rows:
        return f'No comments {head}.'
    lines = [f'{total} comment{"s" if total != 1 else ""} {head}' + (f' (newest {limit} shown)' if total > limit else '')
             + ', oldest first:']
    loaded = set()
    for c in rows:
        when = (c.get('created_at') or '')[:16].replace('T', ' ')
        who = c.get('author_id') or '?'
        anchor = ''
        did = c.get('document_id')
        if did and (did in ws._docs or ws.corpus.may_load(did, loaded)):
            d = ws.doc(did)
            hit = d.find(c.get('entity_id'))
            tag = ws.corpus.tag(d.id)
            if hit:
                s, w, m = hit
                anchor = f'{tag}s{s.index}' + (f'.w{w.index}' if w else '') + (f'.m{m.index}' if m else '')
                if c.get('entity_type') == 'span':
                    anchor += ' ' + (c.get('anchor_label') or 'value')
            elif c.get('entity_type') == 'document' and c.get('entity_id') == did:
                anchor = f'{tag}(the document)'
        if not anchor:
            anchor = (c.get('anchor_label') or c.get('entity_type') or '?') + (' [outdated]' if did else '')
        body = (c.get('body') or '').strip().replace('\n', ' ')
        lines.append(f'  {when}  {who}  @ {anchor}: {body}' + (' (edited)' if c.get('edited') else ''))
    return _truncate('\n'.join(lines))


def t_add_comment(ws: Workspace, document: str, body: str, ref: Optional[str] = None,
                  field: Optional[str] = None) -> str:
    """PLAN: post a comment, under the user's name, on a document, a
    sentence, a word, a morpheme, or one of their field values."""
    body = (body or '').strip()
    if not body:
        raise ToolError('body must not be empty')
    if len(body) > 10000:
        raise ToolError('a comment holds at most 10000 characters')
    doc = ws.doc(document)
    etype, eid, caption, what = _anchor(ws, doc, ref, field)
    where = f'{ws.doc_label(doc.id)} {ref} "{(what or "")[:40]}"' if ref else f'"{ws.doc_label(doc.id)}"'
    ws.add_op({'kind': 'add_comment', 'entity_type': etype, 'entity_id': eid, 'body': body, 'anchor_label': caption,
               'document_id': doc.id,
               'label': f'{where}: comment "{body[:60]}{"…" if len(body) > 60 else ""}"'
                        + (f' (on {field})' if field else '')})
    return ws.planned_note(1)


# --- restore ------------------------------------------------------------------------

def _restore_lines(ws: Workspace, summary: dict) -> List[str]:
    """The dry run's counts, one line per kind of change, as the editor's
    restore dialog lists them."""
    def changed(c):
        return sum((c or {}).get(k) or 0 for k in ('inserted', 'updated', 'deleted'))
    roles = {ws.project.sentence_layer_id: 'sentence', ws.project.word_layer_id: 'word',
             ws.project.morpheme_layer_id: 'morpheme'}
    lines = []
    if summary.get('name'):
        lines.append('the document name')
    if changed(summary.get('texts')):
        lines.append('the text')
    for e in (summary.get('tokens') or {}).get('by_layer') or []:
        n = changed(e)
        if n:
            lines.append(f'{n} {roles.get(e.get("layer_id"), "token")}{"s" if n != 1 else ""}')
    for e in (summary.get('spans') or {}).get('by_layer') or []:
        n = changed(e)
        if n:
            f = ws.project.field_by_layer(e.get('layer_id'))
            lines.append(f'{n} {f.name if f else "annotation"} value{"s" if n != 1 else ""}')
    n = changed(summary.get('relations'))
    if n:
        lines.append(f'{n} relation{"s" if n != 1 else ""}')
    n = changed(summary.get('vocab_links'))
    if n:
        lines.append(f'{n} lexicon link{"s" if n != 1 else ""}')
    if summary.get('document_metadata'):
        lines.append('the document metadata')
    for k in summary.get('skipped') or []:
        lines.append(f'{k.get("count")} {k.get("kind")}(s) cannot come back ({k.get("reason")})')
    return lines


def t_restore_document(ws: Workspace, document: str, as_of: str) -> str:
    """PLAN: put a document back as it was at a moment in its history (every
    layer, ids kept), in one operation. The plan shows what would change,
    from the server's dry run. Maintainers only; nothing else can share the
    plan, since the restore rewrites what the other changes would address."""
    as_of = (as_of or '').strip()
    if not re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', as_of):
        raise ToolError('as_of must be an ISO-8601 instant, e.g. 2026-09-05T18:45:49Z (recent_changes prints one '
                        'per change as as_of=)')
    if ws.ops:
        raise ToolError('A restore must be a plan of its own: discard_plan first, or let the user approve the '
                        'plan so far and ask for the restore afterwards.')
    doc = ws.doc(document)
    ws.on_progress(f'Checking what a restore of "{doc.name}" would change…')
    try:
        summary = ws.client.documents.restore(doc.id, as_of, dry_run=True)
    except Exception as e:  # noqa: BLE001 - the server's reason is the model's answer
        msg = str(e)
        if '403' in msg or 'orbidden' in msg:
            raise ToolError('Restoring a document needs maintainer access to the project.')
        raise ToolError(f'The restore was refused: {msg[:400]}')
    summary = summary if isinstance(summary, dict) else {}
    total = summary.get('total') or 0
    lines = _restore_lines(ws, summary)
    if not total:
        return f'Nothing to restore: "{doc.name}" is as it was at {as_of}.'
    ws.add_op({'kind': 'restore_document', 'document_id': doc.id, 'as_of': as_of, 'doc': doc.id,
               'label': f'{ws.doc_label(doc.id)}: restore to {as_of} ({total} change{"s" if total != 1 else ""}: '
                        + ', '.join(lines) + ')'})
    return ws.planned_note(1) + '\nWhat changes (from the server\'s dry run): ' + ', '.join(lines) + '.'


def t_discard_plan(ws: Workspace) -> str:
    n = len(ws.ops)
    ws.ops.clear()
    ws.new_entries.clear()
    return f'Discarded {n} planned change{"s" if n != 1 else ""}.'


def t_drop_planned(ws: Workspace, indexes) -> str:
    """Drop some planned changes by their plan_status numbers, keeping the rest."""
    if isinstance(indexes, (int, str)):
        indexes = [indexes]
    try:
        wanted = {int(i) for i in (indexes or [])}
    except (TypeError, ValueError):
        raise ToolError('indexes must be the numbers shown by plan_status, e.g. [2, 5]')
    bad = sorted(i for i in wanted if not 1 <= i <= len(ws.ops))
    if bad:
        raise ToolError(f'No planned change number {", ".join(map(str, bad))}; the plan holds {len(ws.ops)} (see plan_status)')
    if not wanted:
        raise ToolError('Give at least one number.')
    dropped = [ws.ops[i - 1] for i in sorted(wanted)]
    # A dropped new entry takes the links to it along: they could not be written.
    keys = {op['key'] for op in dropped if op.get('kind') == 'create_entry'}
    for k in keys:
        ws.new_entries.pop(k, None)
    ws.ops = [op for i, op in enumerate(ws.ops, start=1)
              if i not in wanted and not (op.get('kind') == 'link' and op.get('new_entry_key') in keys)]
    return f'Dropped {len(dropped)} planned change{"s" if len(dropped) != 1 else ""}.' + \
        (' Links to the dropped new entries were dropped with them.' if keys else '') + '\n' + t_plan_status(ws)


# --- schema + dispatch ----------------------------------------------------------

def _fn(name, description, properties, required):
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_GLOSS = {'type': 'string', 'description': 'Singles out one of several entries with the same form: a value one of '
                                           'its fields has (e.g. its gloss).'}
_ENTRY_FORM = {'type': 'string',
               'description': 'A headword, with an optional "#" and the number shown beside it. One segment '
                              'is a headword ("gam#2", the second spelled that way), two or more a sense '
                              '("kwatha#1.2", "gam#2.1.3"). A bare "kwatha" is the headword. read_lexicon '
                              'shows every number.'}
_ENTRY_ADDR = {'entry_form': _ENTRY_FORM,
               'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
               'entry_id': {'type': 'string'}}

_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Positional references, e.g. ["s3.w2", "s3.w4"]. Words are sN.wN, morphemes sN.wN.mN, sentences sN.'}
_MORPHEMES = {'type': 'array', 'items': {'type': 'object', 'properties': {
    'form': {'type': 'string'}, 'type': {'type': 'string'},
    'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}

TOOLS = [
    _fn('project_overview',
        'The project: its annotation fields by scope (Word / Morpheme / Sentence), orthographies, lexicons, and the '
        'list of documents. Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a name substring and/or a document metadata '
        'value (metadata_field + value; an empty value lists documents lacking it).',
        {'pattern': {'type': 'string'}, 'metadata_field': {'type': 'string'}, 'value': {'type': 'string'},
         'limit': {'type': 'integer'}, 'offset': {'type': 'integer'}}, []),
    _fn('read_document',
        'Read a document as compact interlinear text: baseline sentences, sentence fields, and one line per word '
        'with its segmentation, glosses, word fields, orthographies, and lexicon links. Up to 40 sentences per call.',
        {'document': _DOC,
         'from_sentence': {'type': 'integer', 'description': 'First sentence number to show (default 1).'},
         'to_sentence': {'type': 'integer', 'description': 'Last sentence number to show.'}},
        ['document']),
    _fn('search',
        'Find words, morphemes, field values, or lexicon entries matching a pattern (case-insensitive substring, '
        'or a regex). Returns positional references with each hit\'s word line and sentence. Scans every '
        'document unless one is named. (For items LACKING a value use worklist; for aligned context use concordance.)',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"baseline" (word forms, default), "morpheme" (morpheme forms), '
                                                    '"lexicon" (entries), or a field name (e.g. "Gloss", "Translation").'},
         'document': _DOC,
         'regex': {'type': 'boolean', 'description': 'Treat pattern as a regular expression.'},
         'limit': {'type': 'integer', 'description': 'Max hits to return (default 40, max 200).'}},
        ['pattern']),
    _fn('read_lexicon',
        'List lexicon entries (form, morph type, and their fields such as gloss), optionally filtered by a '
        'substring pattern over the whole entry line. Senses are drawn under their entry with the number '
        'they are shown with.',
        {'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
         'pattern': {'type': 'string'},
         'limit': {'type': 'integer', 'description': 'Max entries (default 80).'}},
        []),
    _fn('set_field',
        'PLAN: set a field\'s value on words, morphemes, or sentences (the references must match the field\'s '
        'scope). Empty value clears it. Nothing is written until the user approves the plan.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'field', 'value']),
    _fn('set_analysis',
        'PLAN: replace a word\'s morpheme segmentation and morpheme-level fields. Morphemes are given in order; '
        'each has a form, an optional type (stem, root, prefix, suffix, infix, enclitic, proclitic, ...), and '
        'fields mapping morpheme field names to values, e.g. [{"form":"kitab","type":"stem","fields":{"Gloss":"book"}}, '
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. REPLACES the word\'s whole chain: every existing '
        'morpheme field value on it, human-made ones included, is dropped. To change one morpheme\'s value keep the '
        'chain and use set_field with sN.wN.mN; to change one morpheme\'s form or type, set_morpheme. Several words '
        'at once: analyses=[{"ref":"s3.w1","morphemes":[...]}, ...] (one call per sentence, not per word).',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': _MORPHEMES,
         'analyses': {'type': 'array', 'description': 'Several words at once: [{ref, morphemes}, ...].',
                      'items': {'type': 'object', 'properties': {'ref': {'type': 'string'}, 'morphemes': _MORPHEMES},
                                'required': ['ref', 'morphemes']}}},
        ['document']),
    _fn('set_morpheme',
        'PLAN: change one morpheme\'s stored form and/or type in place, keeping the chain and every value on it '
        '(e.g. make sN.wN.m2 an enclitic). type "" clears the type.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The morpheme, sN.wN.mN.'},
         'form': {'type': 'string'}, 'type': {'type': 'string'}}, ['document', 'ref']),
    _fn('set_orthography',
        'PLAN: set an orthography value (an alternative transcription tier, not the baseline) on words.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the BASELINE spelling of one word (its analysis, glosses, and links are kept; a lone '
        'morpheme form spelt like the word follows it unless morpheme_forms=false). For an alternative '
        'transcription tier use set_orthography.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'}, 'new_text': {'type': 'string'},
         'morpheme_forms': {'type': 'boolean'}},
        ['document', 'ref', 'new_text']),
    _fn('link_entry',
        'PLAN: link words or morphemes to a lexicon entry, by the entry\'s form ("ама", or "ама#2" for homograph 2), '
        'or entry_id (also the id returned by create_entry). Replaces the item\'s own link; a multi-word expression '
        'the word belongs to is separate and stays (link_phrase / unlink_phrase for those).',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_entry', 'PLAN: remove the own lexicon link of words or morphemes (not a multi-word expression: '
                        'unlink_phrase).',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('link_phrase',
        'PLAN: link two or more words of one sentence to ONE lexicon entry as a multi-word expression (an idiom, a '
        'compound written apart, a phrasal verb; reads show it as mwe=entry (w2+w3)). The words keep their own '
        'links. A new phrase entry is created with create_entry (type "phrase") and linked here in the same plan.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_phrase',
        'PLAN: remove a multi-word expression (the link its member words share); their own links stay. refs: '
        'any member word (several where a word sits in more than one expression).',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('create_entry',
        'PLAN: add a lexicon entry. fields maps entry field names (e.g. "gloss", "pos") to values; type is the '
        'morph type (stem, suffix, enclitic, ...). The returned entry_id can be used by link_entry in the same '
        'plan. Use add_sense for a sense of an existing entry.',
        {'form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}, 'type': {'type': 'string'}},
        ['form']),
    _fn('set_entry_field',
        'PLAN: set a field (e.g. gloss) on a lexicon entry. A field that holds a reference to another entry '
        '(project_overview marks them) takes that entry\'s form or id, not free text; passing an empty value '
        'clears it, and a field holding several appends. Where an entry sits, its examples and its headword are '
        'not fields: use add_sense, make_sense_of, move_sense, promote_example or rename_entry.',
        {'field': {'type': 'string'}, 'value': {'type': 'string'}, 'entry_form': _ENTRY_FORM,
         'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['field', 'value']),
    _fn('concordance',
        'Every occurrence of a morpheme form (default), word form, or field value (whole-form match, case-insensitive; '
        'regex=true for partial matches), with aligned context: the '
        'word\'s segmentation and morpheme glosses with the hit in [brackets], the neighbouring words, and a '
        'tally of the distinct word patterns the hit appears in. Use this for morphotactic and distributional '
        'questions (what precedes/follows X, does X vary by context) instead of reading whole documents.',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"morpheme" (default), "baseline" (word forms), or a Word/Morpheme field name.'},
         'document': _DOC, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer', 'description': 'Max occurrences to list (default 60); the pattern tally always covers all.'}},
        ['pattern']),
    _fn('analyses_of',
        'How a form has been analyzed so far, as a word (segmentation, glosses, links) and as a morpheme (type, '
        'glosses, link, position in the word): each distinct analysis with its count and example references. '
        'Check this before proposing an analysis, and follow the majority unless there is reason not to. Pass '
        'forms (a list, up to 40) to check every word of a sentence in one call.',
        {'form': {'type': 'string'}, 'forms': {'type': 'array', 'items': {'type': 'string'}}, 'document': _DOC}, []),
    _fn('lexicon_entry',
        'One lexicon entry in full: all its fields, how many words and morphemes link to it, and example '
        'occurrences. It also says where the entry sits, the senses under it, what refers to it, and its '
        'promoted usage examples with their numbers.',
        {'entry_form': _ENTRY_FORM, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
         'entry_gloss': _GLOSS, 'examples': {'type': 'integer', 'description': 'Example occurrences to show (default 3).'}},
        []),
    _fn('check_consistency',
        'A consistency report for a field: values that are case/spelling variants of one another, forms that carry '
        'several different values, and items annotated but not linked to the lexicon (or linked but empty).',
        {'field': {'type': 'string'}, 'document': _DOC}, ['field']),
    _fn('recent_changes',
        'The newest entries of the change history: who changed what and when, including plans this assistant applied. '
        'Each line ends with as_of=<instant>, the moment right after that change, which restore_document takes.',
        {'document': _DOC, 'limit': {'type': 'integer', 'description': 'Entries to show (default 20, max 100).'},
         'since': {'type': 'string', 'description': 'Only changes at or after this date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Only changes by this person (name or email substring).'}}, []),
    _fn('comments',
        'The comments people have left (not annotation data: notes to each other). Whole project, one document, '
        'or one item (document + ref, plus field for a comment on one of its values). Oldest first.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'sN, sN.wN, or sN.wN.mN.'},
         'field': {'type': 'string'}, 'limit': {'type': 'integer', 'description': 'Newest entries to show (default 50).'}},
        []),
    _fn('add_comment',
        'PLAN: post a comment under the user\'s name on a document (no ref), a sentence, a word, a morpheme, or, '
        'with field, on one of their values. Comments are notes to people; they change no annotation.',
        {'document': _DOC, 'body': {'type': 'string'}, 'ref': {'type': 'string', 'description': 'sN, sN.wN, or sN.wN.mN.'},
         'field': {'type': 'string'}}, ['document', 'body']),
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history (as_of, an instant recent_changes prints), '
        'every layer at once, in one operation the user can undo the same way. The plan lists what would change. '
        'Maintainers only, and a plan of its own.',
        {'document': _DOC, 'as_of': {'type': 'string', 'description': 'ISO-8601 instant, e.g. 2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _fn('plan_status', 'List the changes planned so far in this turn.', {}, []),
    _fn('set_document_metadata',
        'PLAN: set one of the project\'s document metadata fields (see project_overview) on a document.',
        {'document': _DOC, 'field': {'type': 'string'}, 'value': {'type': 'string'}}, ['document', 'field', 'value']),
    _fn('create_document',
        'PLAN: create a new document from raw text, one sentence per line; words are tokenized like the editor does. '
        'metadata maps document metadata field names to values.',
        {'name': {'type': 'string'}, 'text': {'type': 'string'},
         'metadata': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
        ['name', 'text']),
    _fn('discard_plan', 'Drop every change planned so far in this turn.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their plan_status numbers; the rest stay.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
    _fn('confirm',
        'PLAN: mark annotations awaiting review as verified, after checking them: machine-made ones (other services, '
        'earlier assistant plans; ~ in reads) and contributors\' work (^ in reads); see worklist kind="unverified" / '
        '"contributed". refs: sentences, words, or morphemes (a sentence covers its words); field: only that '
        'field\'s values; no refs: the whole document; no document: every document in the project.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}}, []),
    _fn('discard_analysis',
        'PLAN: delete the unverified machine-made analysis of words (their machine links, values, and morphemes); '
        'human-made, contributed, and verified pieces stay. refs: words or sentences.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('add_sense',
        'PLAN: add a sense under an entry, numbered after the senses it already has. The new sense carries the '
        'entry\'s headword unless form says otherwise.',
        {**_ENTRY_ADDR, 'entry_gloss': _GLOSS,
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'},
                    'description': 'Field values for the new sense, e.g. {"gloss": "to simmer"}.'},
         'form': {'type': 'string', 'description': 'A form for the sense, when it differs from the headword.'},
         'type': {'type': 'string', 'description': 'Morph type (stem, suffix, ...).'}},
        []),
    _fn('move_sense',
        'PLAN: put a sense at the number it should be shown with among its siblings, renumbering them to match. '
        'Senses count from 1 at every level.',
        {'number': {'type': 'string', 'description': 'Its place among its own siblings, counting from 1. The '
                                                     'last segment of a dotted number is taken, so "2" and '
                                                     '"1.2" both mean second among its siblings.'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['number']),
    _fn('make_sense_of',
        'PLAN: move an entry, with everything under it, to sit as a sense of another entry of the same lexicon.',
        {'under_form': {'type': 'string', 'description': 'The entry it should sit under.'},
         'under_id': {'type': 'string'}, **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        []),
    _fn('free_sense',
        'PLAN: make a sense a headword of its own, keeping the senses below it.',
        {**_ENTRY_ADDR, 'entry_gloss': _GLOSS}, []),
    _fn('promote_example',
        'PLAN: mark a word in a document as a usage example of an entry. The example is a reference, so it '
        'follows the word and is shown with its sentence.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One word reference, e.g. "s3.w2".'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['document', 'ref']),
    _fn('order_homographs',
        'PLAN: set the order of the headwords spelled the same. That order is the first segment of the number '
        'they and all their senses are shown with, so it renumbers the whole group. Name every one of them, in '
        'the order they should be numbered, by the number each is shown with now (or by id).',
        {'order': {'type': 'array', 'items': {'type': 'string'},
                   'description': 'Every headword of the group, in their new order, e.g. ["2", "1", "3"].'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['order']),
    _fn('remove_example',
        'PLAN: drop one of an entry\'s usage examples, by the number lexicon_entry shows beside it.',
        {'index': {'type': 'integer', 'description': 'The example\'s position, as lexicon_entry lists it.'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['index']),
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'list_documents': t_list_documents,
    'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_morpheme': t_set_morpheme,
    'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'link_phrase': t_link_phrase, 'unlink_phrase': t_unlink_phrase,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
    'concordance': t_concordance, 'analyses_of': t_analyses_of, 'lexicon_entry': t_lexicon_entry,
    'check_consistency': t_check_consistency, 'recent_changes': t_recent_changes, 'plan_status': t_plan_status,
    'comments': t_comments, 'add_comment': t_add_comment, 'restore_document': t_restore_document,
    'set_document_metadata': t_set_document_metadata, 'create_document': t_create_document,
    'confirm': t_confirm, 'discard_analysis': t_discard_analysis, 'drop_planned': t_drop_planned,
    'add_sense': t_add_sense, 'move_sense': t_move_sense, 'make_sense_of': t_make_sense_of,
    'free_sense': t_free_sense, 'promote_example': t_promote_example, 'remove_example': t_remove_example,
    'order_homographs': t_order_homographs,
}



def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool; every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    try:
        return _truncate(fn(ws, **(args or {})))
    except (ToolError, ValueError) as e:  # ValueError: a name/reference lookup failed, message is for the model
        return f'Error: {e}'
    except (TypeError, AttributeError) as e:
        return f'Error: an argument has the wrong type ({e}); check the tool\'s parameter types'
    except Exception as e:  # noqa: BLE001 - the model gets the failure as text; the log gets the trace
        import traceback
        traceback.print_exc()
        return f'Error: {type(e).__name__}: {e}'


# --- corpus-wide reads and bulk plan tools live in their own modules --------------
from .stats import (t_corpus_stats, t_frequency_list, t_worklist, t_check_lexicon,  # noqa: E402
                    t_check_integrity, t_sequence_search)
from .bulk import (t_replace_in_field, t_respell_all, t_copy_to_orthography, t_set_analysis_for_form,  # noqa: E402
                   t_set_field_for_form, t_merge_entries, t_delete_entry, t_rename_entry, t_rename_document)

_ENTRY = {'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
          'entry_gloss': _GLOSS}

TOOLS += [
    _fn('corpus_stats',
        'Totals and coverage: documents, sentences, words, distinct forms, hapax, type/token ratio, morphemes, the '
        'share of words analysed and linked, and every field\'s fill rate. by="document" gives a per-document '
        'table (with metadata columns); by=<metadata field> (e.g. "Genre") breaks the corpus down by that field.',
        {'document': _DOC, 'by': {'type': 'string'}}, []),
    _fn('frequency_list',
        'Ranked counts with document dispersion for wordforms (default), morpheme forms, or a field\'s values.',
        {'what': {'type': 'string', 'description': '"wordform" (default), "morpheme", or a field name.'},
         'document': _DOC, 'limit': {'type': 'integer', 'description': 'Rows (default 100, max 1000).'},
         'min_count': {'type': 'integer'}}, []),
    _fn('worklist',
        'The unfinished work, grouped by form and ordered by frequency: kind="unlinked" (no lexicon link), '
        '"unglossed" (no value in `field`, default the first morpheme field), "unanalyzed" (no analysis at all), '
        '"unverified" (annotations awaiting review: machine-made and unconfirmed, or a contributor\'s), or '
        '"contributed" (contributors\' unreviewed work only; user= narrows to one person). Use this to decide what '
        'to do next. Across the project each form shows a few examples; NAME A DOCUMENT and it lists every '
        'reference instead, which is the list to plan from and saves reading the document to find them.',
        {'kind': {'type': 'string', 'enum': ['unlinked', 'unglossed', 'unanalyzed', 'unverified', 'contributed']},
         'field': {'type': 'string'},
         'level': {'type': 'string', 'enum': ['word', 'morpheme'], 'description': 'For unlinked: which level to list (default morpheme when there is a morpheme layer). For unglossed the field\'s scope decides.'},
         'user': {'type': 'string', 'description': 'For contributed: only this contributor (their user id, an email).'},
         'document': _DOC, 'limit': {'type': 'integer'}}, []),
    _fn('check_lexicon',
        'Lexicon hygiene report, worst first with counts. section: "unused" (entries never linked), "fields" (missing '
        'gloss/pos), "homographs" (same form; groups with the same gloss first), "near" (forms one character apart), '
        '"glosses" (lexicon gloss disagrees with the corpus), "spread" (one corpus gloss over several entries), '
        '"stale" (link form no longer contains the entry form), "single" (attested in one document), "refs" (an '
        'entry whose sense or reference points at an entry that is gone), or "all" (default, each section '
        'capped).',
        {'lexicon': {'type': 'string'}, 'section': {'type': 'string'}}, []),
    _fn('check_integrity',
        'Data-shape report: segmentations that do not add up to the word, duplicate and empty sentences, non-NFC '
        'text, mixed apostrophe characters, and unusual characters in the baseline. Reads every document; on a large '
        'project name one.',
        {'document': _DOC}, []),
    _fn('sequence_search',
        'Sentences containing a sequence of words, each described by conditions on its form, morphemes, morph type, '
        'or field values, e.g. [{"POS":"v"},{"POS":"n"}] or [{"Gloss":"ERG"},{"form":"ava"}]; conditions match whole '
        'values (regex=true for patterns). adjacent=false lets other words come between, in order. Counts are '
        'sentences (first match per sentence). For constituent-order and construction questions.',
        {'sequence': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
         'adjacent': {'type': 'boolean'}, 'document': _DOC, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer'}}, ['sequence']),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of a field, project-wide or in one document: substring by default, '
        'whole_value=true for exact values, regex=true for patterns with backreferences (\\1). field="morpheme form" '
        'rewrites stored morpheme forms instead of a field. One call plans every change; the plan lists each.',
        {'field': {'type': 'string'}, 'pattern': {'type': 'string'}, 'replacement': {'type': 'string'},
         'regex': {'type': 'boolean'}, 'whole_value': {'type': 'boolean'}, 'document': _DOC},
        ['field', 'pattern', 'replacement']),
    _fn('respell_all',
        'PLAN: change the baseline spelling of every word matching a pattern (an orthography change), keeping each '
        'word\'s analysis, glosses, and links. The same replacement is carried into the stored morpheme forms of '
        'those words (morpheme_forms=false to leave them) and into lexicon headwords (lexicon=false to leave them; '
        'the pattern is applied to every entry, not only linked ones). Patterns apply within words only.',
        {'pattern': {'type': 'string'}, 'replacement': {'type': 'string'}, 'regex': {'type': 'boolean'},
         'whole_word': {'type': 'boolean'}, 'document': _DOC, 'morpheme_forms': {'type': 'boolean'},
         'lexicon': {'type': 'boolean'}}, ['pattern', 'replacement']),
    _fn('copy_to_orthography',
        'PLAN: fill an orthography for every word that lacks a value, from the baseline or another orthography.',
        {'orthography': {'type': 'string'}, 'source': {'type': 'string'}, 'document': _DOC,
         'overwrite': {'type': 'boolean'}}, ['orthography']),
    _fn('set_field_for_form',
        'PLAN: set a field value on every occurrence of a form: a morpheme form for a morpheme field, a word form for '
        'a word field (e.g. Gloss (Morpheme) = "OBL" on every morpheme "ди"). only_empty=true (default) fills gaps '
        'and leaves existing values alone; false overwrites them.',
        {'form': {'type': 'string'}, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'only_empty': {'type': 'boolean'}, 'document': _DOC}, ['form', 'field', 'value']),
    _fn('set_analysis_for_form',
        'PLAN: apply one analysis (same shape as set_analysis\'s morphemes) to every occurrence of a word form; '
        'skip_analyzed=true leaves already-analysed words alone.',
        {'form': {'type': 'string'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}},
         'document': _DOC, 'skip_analyzed': {'type': 'boolean'}}, ['form', 'morphemes']),
    _fn('merge_entries',
        'PLAN: fold one lexicon entry into another (links move to the kept entry, the other is deleted).',
        {'keep_form': {'type': 'string'}, 'remove_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'keep_id': {'type': 'string'}, 'remove_id': {'type': 'string'},
         'keep_gloss': _GLOSS, 'remove_gloss': _GLOSS}, []),
    _fn('delete_entry', 'PLAN: delete a lexicon entry and its links; the words and morphemes stay, unlinked.',
        _ENTRY, []),
    _fn('rename_entry', 'PLAN: change a lexicon entry\'s headword form.',
        {'new_form': {'type': 'string'}, **_ENTRY}, ['new_form']),
    _fn('rename_document', 'PLAN: rename a document.',
        {'document': _DOC, 'new_name': {'type': 'string'}}, ['document', 'new_name']),
]
_IMPL.update({
    'corpus_stats': t_corpus_stats, 'frequency_list': t_frequency_list, 'worklist': t_worklist,
    'check_lexicon': t_check_lexicon, 'check_integrity': t_check_integrity, 'sequence_search': t_sequence_search,
    'replace_in_field': t_replace_in_field, 'respell_all': t_respell_all, 'copy_to_orthography': t_copy_to_orthography,
    'set_analysis_for_form': t_set_analysis_for_form, 'set_field_for_form': t_set_field_for_form, 'merge_entries': t_merge_entries, 'delete_entry': t_delete_entry,
    'rename_entry': t_rename_entry, 'rename_document': t_rename_document,
})
from .shape import (t_split_word, t_merge_words, t_delete_word, t_split_sentence,  # noqa: E402
                    t_merge_sentences, t_append_text, t_retype_sentence)

TOOLS += [
    _fn('split_word',
        'PLAN: split one word token into two. at: the left part ("Ali") or the number of characters in it. The '
        'word\'s morpheme analysis is deleted (re-analyse both parts after); its values and link stay on the left part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'at': {'type': 'string', 'description': 'The left part, or its length.'}}, ['document', 'ref', 'at']),
    _fn('merge_words',
        'PLAN: merge adjacent words of one sentence into one token. Their morpheme analyses are deleted; word '
        'values are combined losslessly (distinct values joined with " | "); one lexicon link is kept.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('delete_word',
        'PLAN: delete word tokens. The text is unchanged (use respell to change spelling); the words\' analyses, '
        'values, and links go with them.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('split_sentence',
        'PLAN: split a sentence so that word before_word starts a new sentence. Words and their analyses are '
        'untouched; sentence values (translation) stay with the first part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'},
         'before_word': {'type': 'integer', 'description': 'Number of the word that starts the new sentence (2 or more).'}},
        ['document', 'ref', 'before_word']),
    _fn('merge_sentences',
        'PLAN: merge a sentence into the one before it. Sentence values are combined losslessly.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The later sentence, sN (N ≥ 2).'}},
        ['document', 'ref']),
    _fn('append_text',
        'PLAN: add text at the end of a document, one sentence per line, tokenized into words like the editor.',
        {'document': _DOC, 'text': {'type': 'string'}}, ['document', 'text']),
    _fn('retype_sentence',
        'PLAN: replace the baseline text of one sentence (fix a transcript: insert, remove, or respell words). '
        'Unchanged words keep their analyses; changed text is re-tokenized without analysis; the sentence\'s '
        'own fields stay. Newlines in the new text split it into several sentences.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'}, 'text': {'type': 'string'}},
        ['document', 'ref', 'text']),
]
_IMPL.update({'split_word': t_split_word, 'merge_words': t_merge_words, 'delete_word': t_delete_word,
              'split_sentence': t_split_sentence, 'merge_sentences': t_merge_sentences,
              'append_text': t_append_text, 'retype_sentence': t_retype_sentence})
from .query import t_query, t_query_help  # noqa: E402
from ..core.web import WebError  # noqa: E402

from ..core import webtools  # noqa: E402

WEB_FENCE_TOP, WEB_FENCE_END, WEB_WARNING = webtools.FENCE_TOP, webtools.FENCE_END, webtools.WARNING


def _need_web(ws: Workspace):
    if ws.web is None:
        raise ToolError('Web lookup is not configured on this assistant.')
    return ws.web


def t_web_search(ws: Workspace, query: str, limit: int = 5) -> str:
    """Search the web. Titles, links and snippets only."""
    _need_web(ws)
    try:
        return _truncate(webtools.web_search(ws, query, limit))
    except WebError as e:
        raise ToolError(str(e))


def t_read_url(ws: Workspace, url: str) -> str:
    """Read one web page that this conversation has already turned up."""
    _need_web(ws)
    try:
        return _truncate(webtools.read_url(ws, url))
    except WebError as e:
        raise ToolError(str(e))



TOOLS += [
    _fn('query_help',
        'The reference for the query language used by `query`, plus the layer names of this project. Call it once '
        'before writing a query; it is long, so only when the other tools cannot express the question.',
        {}, []),
    _fn('query',
        'Run a read-only query in Plaid\'s query language over this project (structure across layers, joins, '
        'negation, aggregates). Name layers by their names from query_help. Prefer the specialised tools when they '
        'fit; this is the escape hatch for questions they cannot express.',
        {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, order_by.'},
         'limit': {'type': 'integer', 'description': 'Rows to show (default 50, max 500).'}},
        ['query']),
]
_IMPL.update({'query_help': t_query_help, 'query': t_query})

# Offered only when the operator configured a search backend (see tools_for).
TOOLS += [
    _fn('web_search',
        'Search the WEB (not this project) for background the project cannot answer: what a gloss '
        'abbreviation conventionally means, how a construction is described in related languages, a '
        'reference for a claim. Returns titles, links and snippets. Use the project tools for '
        'anything about this corpus.',
        {'query': {'type': 'string'},
         'limit': {'type': 'integer', 'description': 'Results to return (default 5, max 10).'}},
        ['query']),
    _fn('read_url',
        'Read one web page in full. Only a link that web_search returned in this conversation, or one '
        'the user pasted, can be opened. HTML and plain text only: a PDF cannot be read, and you must '
        'say so rather than guess at its contents.',
        {'url': {'type': 'string'}}, ['url']),
]
_IMPL.update({'web_search': t_web_search, 'read_url': t_read_url})
WEB_TOOLS = ('web_search', 'read_url')

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
