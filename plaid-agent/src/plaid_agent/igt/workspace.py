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
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from ..core import docload, opkind
from ..core.plan import change_of, docs_of_op, labelled
from ..core.tools import ToolError
from ..core.workspace import BaseWorkspace

from .plan import (ANALYSIS, KIND, MORPHEME_KEY, MORPHEME_WRITERS, TEXT_SHAPE, analysed_morphemes,
                   planned_morpheme, removed_entries, settle_merges)

# What only a maintainer of the lexicon may do to its entries (a merge deletes
# the entry it folds away), and what a tool says to anyone else.
ENTRY_REMOVALS = ('rename_entry', 'delete_entry')
MAINTAINERS_ONLY = ('Only a maintainer of the lexicon "{lexicon}" can rename, delete or merge its entries, '
                    'and the person you are acting for does not maintain it. Nothing was planned. '
                    'Tell them a maintainer of that lexicon has to make this change.')
from .project import IgtProject, IgtDoc, Morpheme, Sentence, Word, load_document, render_document, resolve
from .lexview import LexView, _dict_hits, entry_line
from .vocab import RESERVED_ITEM_KEYS, fields_for_item

MAX_DOCS_PER_SEARCH = 1000

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ('A corpus-wide replace or respell counts as one change, and so does a whole '
             "document's confirm, however many values it covers.")

# Parsed documents, shared across turns and users of this process. See
# plaid_agent.core.docload for what the key covers and what it does not.
_DOC_CACHE = docload.DocCache()


# The kinds that rewrite the text itself.
TEXT_KINDS = frozenset(opkind.shaped(KIND, TEXT_SHAPE))

# Documents a plan reaches only through query results that are read when the
# plan is made, to pin them by sentence. Past it the rest are pinned whole, by
# the version the query saw: reading every document of a corpus-wide change to
# spare its approval an edit elsewhere is not worth the wait.
PIN_LOAD_MAX = 50

# The keys of a change that name the entry it writes a link to: a link's
# entry, and the entry a merge moves every link onto.
ENTRY_TARGET_KEYS = ('item_id', 'keep_id')


def _sentence_linking(doc, entry_id: str) -> Optional[str]:
    """The id of the first sentence of ``doc`` holding a link to the entry
    ``entry_id`` (a word's own, a multi-word expression, a morpheme's)."""
    for s in doc.sentences:
        for w in s.words:
            for link in [w.link, *w.mwes, *(m.link for m in w.morphemes)]:
                if link is not None and link.item_id == entry_id:
                    return s.id
    return None


class Workspace(BaseWorkspace):
    """One turn's view of an interlinear project: what it has loaded, the
    lexicon it is building on, and the plan it is proposing."""

    KIND = KIND
    PLAN_NOTE = PLAN_NOTE
    SPAN_KIND = 'set_span'
    DOC_CACHE = _DOC_CACHE
    RESTORE_TOOL = 'restore_document'
    # An analysis names the text as well as its word, at the word's own
    # offsets, which the word's sentence's fingerprint holds.
    NOT_CONTENT_KEYS = ('text_id',)

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
        # The version of each document a change was staged in from a query
        # without the turn loading it, read as the change was staged
        # (``note_versions``), so the plan is pinned to what the query saw.
        self._query_versions: Dict[str, Optional[int]] = {}
        # Corpus-wide tools ask the query engine unless told to scan every
        # document instead (tests compare the two).
        self.prefer_scan = False
        # Links to morphemes of a planned analysis that a later change to that
        # word's analysis took out of the plan, and how many a note has told
        # the model about (the same watermark pair as `replaced`).
        self.unlinked = 0
        self.reported_unlinked = 0
        # How many links a planned merge leaves to another change (see
        # plan.settle_merges) a note has told the model about. Worked out from
        # the plan whenever a note is written, so it follows the plan down as
        # well as up.
        self.reported_left = 0
        # Changes a planned analysis took out of the plan (see `superseding`)
        # and how many of them a note has told the model about.
        self.analysis_took = 0
        self.reported_took = 0

    def make_corpus(self):
        from .corpus import Corpus
        return Corpus(self)

    def op_sentences(self, op: Dict[str, Any], doc) -> Optional[set]:
        """A change to the text itself is placed by offsets into the whole
        text, which may run past the sentence it names, so it stays pinned
        to the whole document.

        A link names the entry it points at, which lives outside every
        document. Deleting that entry, merging it away or renaming it
        rewrites each link to it and moves the version of each document that
        holds one, so a sentence here that already holds a link to the entry
        is pinned beside the linked word's: one is enough to tell the entry
        is gone. Where no sentence of the document holds one, the entry's
        fate never moved this document's version either."""
        if op.get('kind') in TEXT_KINDS:
            return None
        found = super().op_sentences(op, doc)
        if found is None:
            return None
        for entry_id in {op.get(k) for k in ENTRY_TARGET_KEYS} - {None, ''}:
            holder = _sentence_linking(doc, entry_id)
            if holder is not None:
                found.add(holder)
        return found

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

    def render(self, doc, from_sentence: int = 1, to_sentence: Optional[int] = None,
               indexes: Optional[List[int]] = None, budget: Optional[int] = None) -> str:
        return render_document(doc, self.project, start=from_sentence, end=to_sentence, indexes=indexes,
                               ref_name=self.corpus.ref_name(doc.id), budget=budget)

    def use_scan(self, document: Optional[str]) -> bool:
        """Scan (one document, or everything when asked) rather than query."""
        return bool(document) or self.prefer_scan

    # --- what a comment sits on ------------------------------------------

    def comment_caption(self, doc: IgtDoc, ref: Optional[str], field: Optional[str]) -> tuple:
        """(entity_type, entity_id, caption, what) for a comment on the
        document, a sentence, a word, a morpheme, or one of their field values.
        The caption is the editor's own (commentAnchors.js), so a thread reads
        the same in the Comments tab whoever posted it."""
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
            f = self.project.field(field)
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

    def comment_target(self, doc: IgtDoc, ref: str, field: Optional[str] = None) -> tuple:
        return self.comment_caption(doc, ref, field)[:2]

    def comment_ref(self, doc: IgtDoc, comment: Dict[str, Any]) -> Optional[str]:
        """A sentence, word or morpheme by its reference, and a value by its
        thing's reference and the caption it was posted with."""
        hit = doc.find(comment.get('entity_id'))
        if not hit:
            return super().comment_ref(doc, comment)
        s, w, m = hit
        ref = f's{s.index}' + (f'.w{w.index}' if w else '') + (f'.m{m.index}' if m else '')
        if comment.get('entity_type') == 'span':
            ref += ' ' + (comment.get('anchor_label') or 'value')
        return ref

    # --- loading ---------------------------------------------------------

    def load_doc(self, doc_id: str) -> IgtDoc:
        return load_document(self.client, self.project, doc_id)

    def doc(self, document: str) -> IgtDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            entry = next((d for d in self.documents() if d['id'] == did), {})
            self._docs[did] = self.reader.get(did, self._version_of(entry),
                                              entry.get('name') or '')
        return self._docs[did]

    def all_docs(self) -> List[IgtDoc]:
        docs = self.documents()
        if len(docs) > MAX_DOCS_PER_SEARCH:
            raise ToolError(f'{len(docs)} documents is too many to scan at once; name a document.')
        # Every one of them is wanted, so there is nothing to guess at: start
        # them all and take them in order as they land.
        self.read_ahead(docs)
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
        return removed_entries(self.ops)

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

    def view_of_item(self, item_id: str, removed: bool = False) -> Optional['LexView']:
        v = self.vocab_of_item(item_id)
        return self.view(v, removed=removed) if v else None

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
        # A "#" number is a POSITION: the headword's among the entries spelled
        # alike, then its own place under that headword. It is read against the
        # plan's view, which leaves out what this plan deletes, so after a
        # planned delete the same suffix names the NEXT item along: "gam#1"
        # names the other gam, and "kwatha#1.1" the sense that was 1.2. Writing
        # to that is a change to an entry nobody asked for, with nothing said,
        # so compare what the suffix names now with what it named before the
        # plan and refuse when they differ. A number whose referent has moved
        # within the turn is not a name.
        gone = self.doomed_entries()
        if suffix is not None and gone:
            for v in vocabs:
                names_now = [it['id'] for it in _dict_hits(self.view(v), form, suffix)]
                named_before = [it['id'] for it in _dict_hits(self.view(v, removed=True), form, suffix)]
                # It still names only the entry this plan removes. Saying THAT
                # is more use than saying the numbers moved, so it is left to
                # the refusal every caller makes about a doomed entry.
                if names_now == named_before or (not names_now and named_before
                                                 and all(i in gone for i in named_before)):
                    continue
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

    def can_manage_vocab(self, v: dict) -> bool:
        """Whether the user the turn acts for may rename, delete or merge
        entries of lexicon ``v``: a maintainer of it or an administrator. The
        server refuses anyone else (a writer of a project that links it adds
        entries and edits their fields, and no more)."""
        if self.requester_id is None:
            return True
        return self.requester_id in (v.get('maintainers') or []) or self.requester_is_admin()

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        super().guard_op(op, replacing=replacing)
        self.guard_morpheme_change(op, replacing=replacing)
        item = op.get('remove_id') if op.get('kind') == 'merge_entries' else (
            op.get('item_id') if op.get('kind') in ENTRY_REMOVALS else None)
        v = self.vocab_of_item(item) if item else None
        if v is not None and not self.can_manage_vocab(v):
            raise ToolError(MAINTAINERS_ONLY.format(lexicon=v['name']))

    # --- plan --------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """The plan, plus the two things a lexicon tool builds up beside it:
        the entries the plan creates and the metadata it is patching. A
        rollback that put only the ops back left a created entry with no op to
        create it, and the next tool read a lexicon holding it.

        Both are copied all the way down: an entry a tool creates and then
        sets a field on is one dict, edited in place, so a shallow copy came
        back from a rollback carrying the edit."""
        return {**super().snapshot(), 'new_entries': copy.deepcopy(self.new_entries),
                'item_patches': copy.deepcopy(self.item_patches),
                'unlinked': self.unlinked, 'reported_unlinked': self.reported_unlinked,
                'reported_left': self.reported_left, 'analysis_took': self.analysis_took,
                'reported_took': self.reported_took}

    def restore(self, saved: Dict[str, Any]) -> None:
        super().restore(saved)
        self.new_entries = saved['new_entries']
        self.item_patches = saved['item_patches']
        self.unlinked = saved['unlinked']
        self.reported_unlinked = saved['reported_unlinked']
        self.reported_left = saved['reported_left']
        self.analysis_took = saved['analysis_took']
        self.reported_took = saved['reported_took']
        self._patch_version += 1

    def add_op(self, op: Dict[str, Any]) -> None:
        with self.superseding([op]):
            super().add_op(op)
            # A new analysis of a word (or a discard of it) replaces the one a
            # link to one of its morphemes was made against.
            spec = KIND.get(op.get('kind'))
            if spec is not None and spec.shape == ANALYSIS:
                self.unlink_orphans()

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        # Before the funnel asks whether any of them clashes with the plan: a
        # value planned on a morpheme the analysis deletes is superseded by
        # it, not a reason to refuse it.
        with self.superseding(ops):
            super().add_ops(ops)

    @staticmethod
    def moot_under(op: Dict[str, Any], rewritten: set) -> bool:
        """Whether ``op`` changes one of the stored morphemes ``rewritten``
        on its own (a value, a form, a type), which an analysis of its word
        replaces along with the rest of the chain."""
        kind = op.get('kind')
        return ((kind == 'set_span' and op.get('token_id') in rewritten)
                or (kind in MORPHEME_WRITERS and op.get(MORPHEME_KEY) in rewritten))

    @contextmanager
    def superseding(self, ops: List[Dict[str, Any]]):
        """Take out of the plan what the analyses among ``ops`` make moot
        (a value, form or type planned on a morpheme of the word they
        re-analyse), then stage them, and put the plan back if staging them is
        refused. Counted in `analysis_took`, so the note says so, rather than left
        on the card for approval to drop (a type or a form) or to fail on (a
        value on a span the analysis deletes)."""
        rewritten = analysed_morphemes(ops)
        keep = [o for o in self.ops if not self.moot_under(o, rewritten)] if rewritten else self.ops
        if len(keep) == len(self.ops):
            yield
            return
        with self.staging():
            self.analysis_took += len(self.ops) - len(keep)
            self.ops[:] = keep
            self._gone_at = -1
            yield

    def guard_morpheme_change(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A value, form or type for a stored morpheme a planned analysis
        rewrites: the analysis replaces that morpheme and every value on it,
        whichever runs first in the batch. The tools that read sN.wN.mN change
        the planned analysis instead, so this is any other way in."""
        planned = [o for i, o in enumerate(self.ops) if i != replacing]
        if self.moot_under(op, analysed_morphemes(planned)):
            raise ToolError(f'{op.get("label") or "That change"}: the analysis planned for this word replaces this '
                            'morpheme and every value on it. Change the planned analysis instead: set_field and '
                            'set_morpheme with sN.wN.mN name the morphemes it plans.')

    def unlink_orphans(self) -> int:
        """Take out of the plan every link to a morpheme of a planned analysis
        that the plan no longer holds as the link read it: the analysis was
        dropped, discarded, or replaced by one without that morpheme at that
        place. Every path that changes a word's planned analysis ends here, and
        approval refuses what is left (``plan.validate_ops``)."""
        keep = [op for op in self.ops
                if not (op.get('kind') == 'link' and op.get('analysis_word_id')
                        and planned_morpheme(self.ops, op) is None)]
        gone = len(self.ops) - len(keep)
        if gone:
            self.ops[:] = keep
            self._gone_at = -1
            self.unlinked += gone
        return gone

    def superseded_note(self) -> str:
        out = super().superseded_note()
        took = self.analysis_took - self.reported_took
        if took > 0:
            self.reported_took = self.analysis_took
            out += (f' {took} change{"s" if took != 1 else ""} planned on the morphemes of a word this analysis '
                    f'replaces {"were" if took != 1 else "was"} taken out: the analysis writes only the forms, types '
                    'and values it gives. To keep one, give it in the analysis, or use set_field or set_morpheme '
                    'with sN.wN.mN, which now name the planned morphemes.')
        new = self.unlinked - self.reported_unlinked
        if new > 0:
            self.reported_unlinked = self.unlinked
            out += (f' {new} planned link{"s" if new != 1 else ""} to a morpheme of a planned analysis '
                    f'{"were" if new != 1 else "was"} dropped: the analysis now planned for that word has no such '
                    'morpheme at that place. Link again with link_entry sN.wN.mN if it should be.')
        _ops, left = settle_merges(self.ops)
        if len(left) > self.reported_left:
            takers = sorted({t['label'] for _m, _l, t in left if t and t.get('label')})
            out += (f' A planned merge leaves {len(left)} link{"s" if len(left) != 1 else ""} to another change in '
                    'this plan' + (f' ({"; ".join(takers)})' if takers else '')
                    + f', which replaces or removes {"them" if len(left) != 1 else "it"}, rather than moving '
                    f'{"them" if len(left) != 1 else "it"} too: a word or morpheme keeps one link. Drop that change '
                    'if the merge should move it.')
        self.reported_left = len(left)
        return out

    def exclusive_message(self, staging_it: bool) -> str:
        """A restore rewrites a document wholesale, so nothing else can be
        planned against the ids and offsets read before it: a restore is
        always a plan of its own, whichever of the two is staged first."""
        if staging_it:
            return ('A restore must be a plan of its own: discard_plan first, or let the user approve the '
                    'plan so far and ask for the restore afterwards.')
        return ('The plan holds a restore, which must be approved on its own; discard_plan first, '
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
        # Each merge as it will run: less the links another change takes.
        ops = self.mark_replaced_work(copy.deepcopy(settle_merges(self.ops)[0]))
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
            out += self._pin_unloaded(unloaded)
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
            mine = [op for op in self.ops
                    if _op_mentions(op, ids) or did in docs_of_op(op) or op.get('doc') == did]
            if any(_op_mentions(op, ids) for op in mine):
                out.append(self.pinned({'id': doc.id, 'name': doc.name, 'version': doc.version},
                                       doc, mine))
        return self.cap_pins(out)

    def note_versions(self, doc_ids) -> None:
        """Read, as changes are staged from a query, the version of each
        document they land in that the turn has not loaded. The first reading
        stands, so a plan is pinned to the document the query saw, not to
        whatever it has become by the end of the turn."""
        wanted = [d for d in dict.fromkeys(doc_ids)
                  if d and d not in self._docs and d not in self._query_versions]
        if wanted:
            got = self.corpus.versions(wanted)
            for d in wanted:
                self._query_versions[d] = got.get(d)

    def _pin_unloaded(self, doc_ids: set) -> List[Dict[str, Any]]:
        """The records of the documents the plan reaches only through query
        results. Each is pinned by sentence like a loaded one: it is read now
        (up to :data:`PIN_LOAD_MAX` of them), and when it is still the version
        the query saw, the sentences its changes depend on are fingerprinted
        from it. A document read at another version, or past the budget, is
        pinned whole by the version the query saw."""
        missing = [d for d in sorted(doc_ids) if d not in self._query_versions]
        versions = dict(self.corpus.versions(missing)) if missing else {}
        versions.update({d: self._query_versions[d] for d in doc_ids if d in self._query_versions})
        order = [d for d in sorted(doc_ids) if d in versions]
        ops = {d: [op for op in self.ops if op.get('doc') == d or d in (op.get('documents') or [])
                   or d in docs_of_op(op)] for d in order}
        # A corpus-wide change stored as one is found again when approved, so
        # its documents stay pinned whole and are not read for it.
        readable = [d for d in order if versions[d] is not None
                    and not any(opkind.resolver(self.KIND, op) for op in ops[d])][:PIN_LOAD_MAX]
        # Cached by the version the query saw, so a document already read at
        # that version is not read again.
        key = {d: self._version_of({'version': versions[d]}) for d in readable}
        self.reader.read_ahead([(d, key[d]) for d in readable])
        out = []
        for did in order:
            entry = {'id': did, 'name': self.corpus.doc_name(did), 'version': versions[did]}
            if did in readable:
                try:
                    doc = self.reader.get(did, key[did], entry['name'] or '')
                except Exception:  # noqa: BLE001 - unreadable now: the version alone decides
                    doc = None
                if doc is not None and doc.version == versions[did]:
                    entry = self.pinned(entry, doc, ops[did])
            out.append(entry)
        return out

def _op_mentions(value, ids: set) -> bool:
    if isinstance(value, str):
        return value in ids
    if isinstance(value, dict):
        return any(_op_mentions(v, ids) for k, v in value.items() if k != 'label')
    if isinstance(value, list):
        return any(_op_mentions(v, ids) for v in value)
    return False


# Distinct changes a group's line spells out before "… n more".
GROUP_LINE_CHANGES = 5


def compact_spec(ws: Workspace) -> Dict[str, Dict[str, Any]]:
    """How like ops fold into one stored op (core.plan.compact_ops), read off
    the registry: each kind says which of its keys vary per member (the
    document among them, so a bulk change over a whole corpus is one group
    and not one per document, most of which held too few to fold at all).
    The line is headed by the document when the group has one, the way every
    label is, so the card can place it the same way. Each member's change is
    read from where its label says it starts (``core.plan.labelled``), never
    by splitting the label, since a document name may hold ``": "``; and the
    same change made many times is one entry with its count."""
    def label(first, members):
        n = len(members)
        counts: Dict[str, int] = {}
        for m in members:
            change = change_of(m)
            change = change if change is not None else (m.get('label') or '')
            counts[change] = counts.get(change, 0) + 1
        distinct = list(counts.items())
        parts = [f'{k} × {c}' if k > 1 else c for c, k in distinct[:GROUP_LINE_CHANGES]]
        left = sum(k for _, k in distinct[GROUP_LINE_CHANGES:])
        listing = '; '.join(parts) + (f'; … {left} more' if left else '')
        # One change made n times says so in its count alone.
        body = listing if len(distinct) == 1 else f'{n} changes: {listing}'
        docs = {m.get('doc') for m in members} - {None}
        if len(docs) == 1:
            return labelled(ws.doc_label(next(iter(docs))), body)
        if docs:
            return labelled(f'{n} changes in {len(docs)} documents', listing)
        return labelled('', body)

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
            raise ToolError(f'That is not a valid regular expression: {e}')
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


def _sentence_of(doc: IgtDoc, w: Word) -> Sentence:
    for s in doc.sentences:
        if w in s.words:
            return s
    raise ToolError('internal: word not in document')


# --- whose work a change replaces -----------------------------------------------
#
# What each kind rewrites or removes, for the card's "replace accepted work"
# line (core/work.py). A value's provenance sits on its span, a link's on the
# link, a segmentation's on its morpheme tokens. A word token is the text's
# own division, not anybody's analysis, so it never counts by itself.

def _found(ws: Workspace, entity_id: str):
    """(sentence, word, morpheme) for an id in a document this turn read."""
    for doc in ws._docs.values():
        hit = doc.find(entity_id)
        if hit:
            return hit
    return None


def _analysis(morphemes) -> List[str]:
    """The ids of a word's analysis: each morpheme's values and link, and the
    morphemes themselves where there is a segmentation (more than one). A
    word's single morpheme is the word itself until someone segments it."""
    morphemes = [m for m in morphemes if m is not None]
    out = [sp.id for m in morphemes for sp in m.fields.values()]
    out += [m.link.id for m in morphemes if m.link]
    if len(morphemes) > 1:
        out += [m.id for m in morphemes]
    return out


def _morphemes(ws: Workspace, ids) -> List[Morpheme]:
    return [hit[2] for hit in (_found(ws, i) for i in ids or []) if hit and hit[2] is not None]


def _word_and_analysis(ws: Workspace, op: Dict[str, Any]) -> List[str]:
    """A word that goes, with its values, its link and its analysis."""
    hit = _found(ws, op.get('word_id'))
    w = hit[1] if hit else None
    out = list(op.get('link_ids') or [])
    if w is not None:
        out += [sp.id for sp in w.fields.values()] + ([w.link.id] if w.link else [])
        out += _analysis(w.morphemes)
    return out


def _replaced_orthography(ws: Workspace, op: Dict[str, Any]) -> List[str]:
    """An orthography value is kept on the word token. Replacing one a word
    already has, with something else, replaces what someone wrote there."""
    hit = _found(ws, op.get('word_id'))
    w = hit[1] if hit else None
    if w is not None:
        metadata = w.metadata
    else:
        # A word a query returned, in a document the turn never loaded.
        _found_it, metadata = ws.metadata_of(op.get('word_id'))
    old = (metadata or {}).get(op.get('key'))
    return [op.get('word_id')] if old and old != (op.get('value') or '') else []


def _replaced_analysis(ws: Workspace, op: Dict[str, Any]) -> List[str]:
    existing = [m.get('id') for m in op.get('existing') or []]
    found = _morphemes(ws, existing)
    out = _analysis(found)
    # Morphemes a query returned from a document the turn never loaded: a
    # segmentation is theirs where there is more than one, as above.
    known = {m.id for m in found}
    if len(existing) > 1:
        out += [i for i in existing if i and i not in known]
    return out + [sid for m in op.get('existing') or [] for sid in m.get('span_ids') or []]


_NONE = None
REPLACES = {
    'set_span': lambda ws, op: [op.get('span_id')],
    'set_analysis': _replaced_analysis,
    'discard_analysis': lambda ws, op: (list(op.get('span_ids') or []) + list(op.get('link_ids') or [])
                                        + _analysis(_morphemes(ws, op.get('morpheme_ids')))),
    'set_morpheme_form': lambda ws, op: [op.get('morpheme_id')],
    'set_morph_type': lambda ws, op: [op.get('morpheme_id')],
    'set_orthography': _replaced_orthography,
    'link': lambda ws, op: [op.get('existing_link_id')],
    'link_phrase': lambda ws, op: [op.get('existing_link_id')],
    'unlink': lambda ws, op: [op.get('link_id')],
    'delete_word': _word_and_analysis,
    'split_word': lambda ws, op: _analysis(_morphemes(ws, op.get('morpheme_ids'))),
    'merge_words': lambda ws, op: (_analysis(_morphemes(ws, op.get('morpheme_ids')))
                                   + [sid for sp in op.get('spans') or [] for sid in sp.get('delete_ids') or []]
                                   + list((op.get('links') or {}).get('delete_ids') or [])
                                   + list(op.get('mwe_ids') or [])),
    'merge_sentences': lambda ws, op: [sid for sp in op.get('spans') or []
                                       for sid in sp.get('delete_ids') or []],
    # Confirming takes nothing away, a comment adds, and a new document or a
    # new sentence boundary replaces nothing anyone annotated.
    'confirm': _NONE, 'add_comment': _NONE, 'create_document': _NONE, 'split_sentence': _NONE,
    'rename_document': _NONE, 'set_doc_metadata': _NONE,
    # The lexicon: an entry is not a document's annotation.
    'create_entry': _NONE, 'set_entry_field': _NONE, 'set_entry_metadata': _NONE,
    'rename_entry': _NONE, 'merge_entries': _NONE,
    # Deleting an entry takes every link to it, and a link is a person's
    # judgment that this word is that entry. A merge keeps each link, moved.
    'delete_entry': lambda ws, op: list(op.get('links') or []),
    # The text itself and prose: the card's Rewrite line says so already.
    'edit_text': _NONE, 'respell': _NONE,
    'add_guideline': _NONE, 'revise_guideline': _NONE, 'rewrite_guideline': _NONE,
    # Resolved when approved, from the documents as they are then, and a
    # restore puts back what was there: neither names what it replaces now.
    'bulk_scope': _NONE, 'restore_document': _NONE,
}
Workspace.REPLACES = REPLACES
