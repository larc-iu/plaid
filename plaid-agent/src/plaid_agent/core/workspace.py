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

from typing import Any, Dict, List, Optional

from . import opkind
from .plan import PLAN_MAX_OPS, PlanFull, reserve as core_reserve
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

    An app answers five things: ``KIND``, its op-kind registry; ``PLAN_NOTE``,
    what counts as one change here, appended to the plan-is-full refusal;
    ``SPAN_KIND``, the kind that sets one value on one token;
    :meth:`make_corpus`, its query helper; and :meth:`guard_op`, the refusals
    only it owes when something is staged.
    """

    KIND: Dict[str, opkind.OpKind] = {}
    PLAN_NOTE = ''
    # The app's kind for "one value on one token", which is the only kind
    # :meth:`planned_value` reads. An op of it carries ``layer_id``,
    # ``token_id`` and ``value``. Named by the app rather than here, so no kind
    # of any app's is written into the base.
    SPAN_KIND = ''

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
        # The turn's code worker (core.sandbox.Session), opened by the first
        # run_code call and released by close().
        self.code = None

    def close(self) -> None:
        """Release what the turn held: the code worker, if one was opened."""
        if self.code is not None:
            self.code.close()
            self.code = None

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
        # earlier ops, and guard_op is not asked here at all. Nothing reaches
        # that gap today: no tool builds a batch that deletes one of its own
        # subjects, and no app guard turns on what a batch holds. One that did
        # would stage part of its batch and then raise from add_op below, which
        # is the outcome this pre-check exists to prevent.
        for op in ops:
            self.refuse_doomed(op, replacing=self.replacing(op))
        for op in ops:
            self.add_op(op)

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """The refusals only this app owes when something is staged. The
        ``replacing`` index is the op this one supersedes, which is not part of
        the plan any more."""

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
            raise ToolError(opkind.clash_message(*clash))

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
