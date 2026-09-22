"""The per-request workspace an app's tools run against.

One turn, one workspace. It holds what the turn has loaded, the plan the turn
is building, and whatever the turn opened and has to release. Reads answer
from it; a tool that proposes a change appends to ``ops`` instead of writing,
and the service hands that list to the user to approve.

What is here is the half that is the same whatever an app annotates: the
document list and how a name resolves against it, the plan's size budget, the
rule that a second change to one target replaces the first, the refusals a
plan owes itself, and the note a tool ends with. An app subclasses this and
adds how ITS documents are loaded, what a plan payload looks like, and the
refusals only it owes (:meth:`BaseWorkspace.guard_op`).
"""

from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from . import docload, opkind
from .plan import PLAN_MAX_OPS, PlanFull, docs_of_op, reserve as core_reserve
from .tools import ToolError

# A turn that has read a page from the web plans nothing. The page is text by
# a stranger, and nothing it says gets to become a proposed change in the same
# breath: the user sees what was found first, and asks for the change
# separately if they want it.
WEB_READ_REFUSAL = (
    'This turn has read the web, so it cannot also plan changes. Tell the user what you '
    'found and what you would change, and let them ask for it. The next turn can plan it '
    'without looking anything up.')


class BaseWorkspace:
    """What one turn holds while its tools run.

    An app answers six things: ``KIND``, its op-kind registry; ``PLAN_NOTE``,
    what counts as one change here, appended to the plan-is-full refusal;
    ``SPAN_KIND``, the kind that sets one value on one token;
    :meth:`make_corpus`, its query helper; :meth:`guard_op`, the refusals
    only it owes when something is staged; and :meth:`clash_message`, its own
    words for a change the plan deletes out from under.
    """

    KIND: Dict[str, opkind.OpKind] = {}
    PLAN_NOTE = ''
    # The app's kind for "one value on one token", which is the only kind
    # :meth:`planned_value` reads. An op of it carries ``layer_id``,
    # ``token_id`` and ``value``. Named by the app rather than here, so no kind
    # of any app's is written into the base.
    SPAN_KIND = ''
    # The app's process-wide cache of parsed documents (a docload.DocCache).
    # An app that sets none reads every document afresh every turn.
    DOC_CACHE = None
    # The app's tool for putting a document back as it was at an instant, named
    # so the change history can say what its `as_of` is for. None where the app
    # has no such tool: the instant is still printed, it is just not offered.
    RESTORE_TOOL = None

    def __init__(self, client, project, on_progress=None):
        self.client = client
        self.project = project
        self.on_progress = on_progress or (lambda msg: None)
        self._doc_list: Optional[List[dict]] = None
        self._docs: Dict[str, Any] = {}
        self.ops: List[Dict[str, Any]] = []
        # Ops superseded by a later op on the same target this turn, and how
        # many of them a note has already told the model about. Two counters
        # rather than one that is zeroed on being read, because a bulk tool
        # stages through the single-item tool and throws its notes away: what
        # those notes reported would go with them.
        self.replaced = 0
        self.reported_replaced = 0
        # What the plan certainly deletes, kept in step with `ops` as it grows
        # so the doomed-target guard is not a scan of the whole plan per op.
        self._gone: set = set()
        self._gone_at = 0
        self._corpus = None  # the query helper, made on the first corpus-wide read
        # Set when the operator configured web search. None means the web tools
        # are not offered to the model at all.
        self.web = None
        # The files the user attached to this conversation (a files.Attachments),
        # set by the service before the turn runs. Empty means the file tools are
        # not offered to the model at all, on the same rule as the web tools: a
        # model told it can read a file when there is none goes looking for one.
        self.files = None
        # The turn's code worker (core.sandbox.Session), opened by the first
        # run_code call and released by close().
        self.code = None
        # The turn's document reads. Made on first use so a turn that reads no
        # document opens no thread pool.
        self._reader = None

    def close(self) -> None:
        """Release what the turn held: the code worker and any reads still
        running, if either was opened."""
        if self.code is not None:
            self.code.close()
            self.code = None
        if self._reader is not None:
            self._reader.close()
            self._reader = None

    # --- reading documents ------------------------------------------------

    def load_doc(self, doc_id: str):
        """Read and parse one document. The app answers this. Called on worker
        threads as well as this one, so it may touch the client and the
        project and nothing else on the workspace."""
        raise NotImplementedError

    @property
    def reader(self) -> docload.Reader:
        if self._reader is None:
            cache = self.DOC_CACHE or docload.DocCache(0)
            self._reader = docload.Reader(self.load_doc, cache, self.on_progress)
        return self._reader

    def _version_of(self, entry: dict):
        """The version to cache a listed document under, or None to read it
        afresh. A client may opt out, which test doubles do: they reuse ids
        across different content, so a version means nothing there."""
        if getattr(self.client, 'no_doc_cache', False):
            return None
        return (entry or {}).get('version')

    def read_ahead(self, wanted, *, once: bool = False) -> None:
        """Start reading documents in the background, a bounded few at a time.

        ``wanted`` is document ids or entries from :meth:`documents`, in the
        order they will be used. The ones already cached or already running are
        skipped, so passing the whole list when only some are wanted costs
        nothing for the rest.

        Only call it where every document WILL be read. A caller that stops
        early leaves a window's worth of reads that nobody wanted, which is
        exactly the cost this is supposed to save.
        """
        listed = None
        pairs = []
        for item in wanted:
            if isinstance(item, str):
                if listed is None:
                    listed = {d['id']: d for d in self.documents()}
                item = listed.get(item) or {'id': item}
            pairs.append((item['id'], self._version_of(item)))
        self.reader.read_ahead(pairs, once=once)

    # --- the corpus helper ------------------------------------------------

    def make_corpus(self):
        """The app's query helper, bound to this workspace."""
        raise NotImplementedError

    @property
    def corpus(self):
        if self._corpus is None:
            self._corpus = self.make_corpus()
        return self._corpus

    def forget_clipping(self) -> None:
        """Forget whether an earlier read in this turn was cut short by the
        engine. Called once per tool call, so each tool answers for its own
        reads rather than for the turn's."""
        if self._corpus is not None:
            self._corpus.forget_clipping()

    # --- loading ----------------------------------------------------------

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

    # --- the plan ---------------------------------------------------------

    def render(self, doc, **kw) -> str:
        """One of this app's documents as the model reads it. Takes
        ``from_sentence``/``to_sentence`` or ``indexes``, and a ``budget`` in
        characters."""
        raise NotImplementedError

    def comment_anchor(self, doc, ref: str) -> str:
        """The id a comment on ``ref`` hangs off, or a refusal saying what a
        comment may sit on. A comment is anchored on a TOKEN in every app."""
        raise NotImplementedError

    def touched_documents(self) -> List[Dict[str, Any]]:
        """The documents the plan refers to, with the version each was read at,
        so approval can refuse a plan made against data that has moved on."""
        out: List[Dict[str, Any]] = []
        listed = {d['id']: d for d in self.documents()}
        touched: List[str] = []
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
                out.append({'id': did, 'name': listed[did].get('name'),
                            'version': listed[did].get('version')})
        return out

    def op_target(self, op: Dict[str, Any]):
        """What an op writes to, for last-wins replacement within one plan.
        Each kind declares its own; a kind that can supersede nothing has
        none."""
        return opkind.target_of(self.KIND, op)

    def replacing(self, op: Dict[str, Any]) -> Optional[int]:
        """The index of the planned op this one supersedes, if any: they write
        to the same thing, and the later one wins."""
        key = self.op_target(op)
        if key is None:
            return None
        return next((i for i, prev in enumerate(self.ops) if self.op_target(prev) == key), None)

    def add_op(self, op: Dict[str, Any]) -> None:
        """Append a plan op. An op on a target the plan already touches
        REPLACES the earlier op (last wins), so a corrected instruction never
        yields two writes to one thing. The target key comes from the op's
        kind.

        Every tool that proposes anything comes through here, which is why the
        refusals a plan owes itself live here rather than in the tools.
        """
        if self.web is not None and getattr(self.web, 'read', False):
            raise ToolError(WEB_READ_REFUSAL)
        at = self.replacing(op)
        self.refuse_doomed(op, replacing=at)
        self.guard_op(op, replacing=at)
        if at is not None:
            self.ops[at] = op
            self.replaced += 1
            self._gone_at = -1
            return
        self.reserve(1)
        self.ops.append(op)
        if self._gone_at == len(self.ops) - 1:
            self._gone |= opkind.removed_ids(self.KIND, [op], only_certain=True)
            self._gone_at = len(self.ops)

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        """Stage a tool's whole batch, or none of it.

        Both refusals are asked of the batch BEFORE any of it is staged: the
        size cap, and the change-to-something-deleted guard. Asked op by op,
        a tool naming four words where the plan deletes the fourth staged
        three of them and then answered with an error, so the user would have
        approved a change the model never told them about.
        """
        self.reserve(len(ops))
        # Each op against the plan AS IT STANDS, never against the batch's own
        # earlier ops, so a tool naming four words is refused here before any
        # of them is staged rather than half-way through the loop below.
        for op in ops:
            self.refuse_doomed(op, replacing=self.replacing(op))
        # And whatever the loop still refuses (an app guard that turns on what
        # the batch holds, a clash with the batch's own earlier ops) puts the
        # plan back as it was rather than leaving part of the batch in it.
        with self.staging():
            for op in ops:
                self.add_op(op)

    @contextmanager
    def staging(self):
        """All of one tool call's changes, or none of them.

        A tool that stages more than once (a loop over documents, a change and
        the reference repairs it carries, a plan op beside a change to the
        plan itself) leaves the first half in the plan when the second is
        refused, while the model is told the call failed. The user is then
        offered changes nobody described to them, which is the outcome an
        approval card exists to prevent.

        :meth:`add_ops` is the same promise for one batch of like ops. Use
        this where a tool stages in more than one call.
        """
        saved = self.snapshot()
        try:
            yield
        except BaseException:
            self.restore(saved)
            raise

    def snapshot(self) -> Dict[str, Any]:
        """What :meth:`restore` puts back. An app whose tools carry state
        beside the plan (entries a plan creates, patches it builds up) adds it
        here and in :meth:`restore`, in one pair, so no tool has to remember
        which halves of the turn a rollback owes."""
        return {'ops': list(self.ops), 'replaced': self.replaced,
                'reported_replaced': self.reported_replaced}

    def restore(self, saved: Dict[str, Any]) -> None:
        self.ops[:] = saved['ops']
        self.replaced = saved['replaced']
        self.reported_replaced = saved['reported_replaced']
        # The plan changed by something other than add_op, and a restore can
        # land on the length the watermark holds with different ops under it.
        self._gone_at = -1

    def refuse_exclusive(self, kind: Optional[str], replacing: Optional[int] = None) -> None:
        """An op of a kind tagged EXCLUSIVE is the only op in its plan, BOTH
        WAYS ROUND: nothing joins a plan that holds one, and one does not join
        a plan that holds anything.

        The two halves were written apart, the first in each app's
        ``guard_op`` and the second in each app's restore tool, so a second
        exclusive kind would have got the first half by being declared and the
        second not at all. ``kind`` is what is being staged, or None where the
        caller is asking the question early, before it has built an op.
        """
        exclusive = opkind.shaped(self.KIND, opkind.EXCLUSIVE)
        planned = [o for i, o in enumerate(self.ops) if i != replacing]
        if kind in exclusive:
            if planned:
                raise ToolError(self.exclusive_message(staging_it=True))
        elif any(o.get('kind') in exclusive for o in planned):
            raise ToolError(self.exclusive_message(staging_it=False))

    def refuse_exclusive_early(self, op: Dict[str, Any]) -> None:
        """:meth:`refuse_exclusive` asked of the op a tool is ABOUT to stage,
        for a tool with expensive work to do first (a restore asks the server
        what it would change).

        It asks with the ``replacing`` the funnel will use, so the early
        answer and the real one cannot differ. Asked without it, an early
        refusal was stricter than the staging one: it refused a second change
        of a kind whose registry entry says the second REPLACES the first, so
        a model correcting what it had just planned had to discard the plan.
        """
        self.refuse_exclusive(op.get('kind'), replacing=self.replacing(op))

    def exclusive_message(self, staging_it: bool) -> str:
        """What to tell the model about a change that owns its whole plan.
        ``staging_it`` is True when that change is the one being staged and
        the plan already holds something else. An app names the change."""
        if staging_it:
            return ('This change rewrites what everything else in the plan addresses, so it must be a '
                    'plan of its own. Discard the plan first (discard_plan), or let the user approve '
                    'it and ask for this afterwards.')
        return ('The plan holds a change that rewrites what this one addresses, and it must be '
                'approved on its own. discard_plan first, or let the user approve it and plan this '
                'afterwards.')

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """The refusals only this app owes when something is staged. The
        ``replacing`` index is the op this one supersedes, which is not part of
        the plan any more."""
        self.refuse_exclusive(op.get('kind'), replacing=replacing)

    def reserve(self, n: int) -> None:
        """Refuse BEFORE staging what would push the plan past what a record
        can hold, so a tool never leaves half of its changes behind."""
        try:
            core_reserve(len(self.ops), n, self.PLAN_NOTE, PLAN_MAX_OPS)
        except PlanFull as e:
            raise ToolError(str(e)) from None

    def certainly_gone(self) -> set:
        """What the plan certainly deletes. Rebuilt whenever the plan was
        changed by something other than :meth:`add_op` (a dropped change, a
        discarded plan), which the length or the invalidated watermark says."""
        if self._gone_at != len(self.ops):
            self._gone = opkind.removed_ids(self.KIND, self.ops, only_certain=True)
            self._gone_at = len(self.ops)
        return self._gone

    def refuse_doomed(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A change to something this plan certainly deletes, or a delete of
        something this plan already changes, in either order.

        The same clash used to be found only when the plan was applied, and
        the change was then dropped from a card the user had already approved.
        """
        if replacing is None:
            planned, gone = self.ops, self.certainly_gone()
        else:
            planned, gone = [o for i, o in enumerate(self.ops) if i != replacing], None
        clash = opkind.delete_clash(self.KIND, planned, op, gone)
        if clash:
            raise ToolError(self.clash_message(*clash))

    def clash_message(self, victim: Dict[str, Any], killer: Optional[Dict[str, Any]]) -> str:
        """What to tell the model when one change in the plan writes to what
        another deletes. The registry names the pair; an app overrides this
        where its own kinds have a clearer way to say what happened, so the
        wording is the app's and the rule stays the funnel's."""
        return opkind.clash_message(victim, killer)

    def planned_value(self, layer_id: str, token_id: str, current: str) -> str:
        """The value a span will have once the plan runs (a planned op wins
        over the stored value), so a second tool in the same turn reads what
        the first one planned."""
        if not self.SPAN_KIND:
            raise NotImplementedError('this app has declared no kind that sets a value on a token')
        for op in self.ops:
            if op.get('kind') == self.SPAN_KIND and op.get('layer_id') == layer_id \
                    and op.get('token_id') == token_id:
                return op.get('value') or ''
        return current

    def superseded_note(self) -> str:
        """The earlier changes this turn superseded that nothing has reported
        yet, and '' when there are none.

        A watermark rather than a counter it empties: a bulk tool stages
        through the single-item tool and throws its notes away, so a counter
        read there would take what those notes would have said with it.
        """
        new = self.replaced - self.reported_replaced
        if new <= 0:
            return ''
        self.reported_replaced = self.replaced
        return (f' {new} earlier planned change{"s" if new != 1 else ""} on the same '
                f'target{"s" if new != 1 else ""} superseded.')

    def planned_note(self, n: int) -> str:
        """What a tool that staged ``n`` changes says back."""
        return (f'Planned {n} change{"s" if n != 1 else ""} (nothing is written until the user approves; '
                f'the plan now holds {len(self.ops)}). Describe the plan to the user in your reply.'
                + self.superseded_note())
