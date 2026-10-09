"""The projects one turn may read.

A conversation belongs to one project, its home: where it is filed, what the
panel beside it shows, and the only project a plan may change. The reader may
add other projects to a conversation, and a turn may then READ them too, each
through a workspace of its own, built by the app's own loader exactly as the
home workspace is. No tool learns about several projects: a tool is handed the
workspace of the project it was asked about, and :func:`route` is the one place
that decides which.

Three rules hold the whole of it.

- Only what the reader added, and only what the token reaches. The set comes
  from the user's own message (``projects`` on its display item) and nothing
  else, capped at :data:`MAX_PROJECTS` with the home project counted, and
  narrowed to the projects the requester's delegated token is scoped to
  (``delegated_projects``: the browser names the joined projects with the
  request, and the server scopes the token to those the user can read). The
  model cannot name a project into reach. :func:`reachable` is the ONE place
  the set is computed.
- Only with the user's own rights. Every other project is read through the
  requester's client, the same one the home project is read through, so the
  server checks each read against the user's own role in that project.
- Only where this assistant runs. A project joins a turn only when the same
  service is online there, so an operator who kept a model off a project keeps
  that project's text away from the model. The service answers that in
  ``open_project``, which raises for a project it will not open.

Other projects are read-only here. Their workspaces refuse to stage anything
(see ``BaseWorkspace.writable``), whichever path a change comes by.
"""

import traceback
from typing import Any, Callable, Dict, Iterable, List, Tuple

from plaid_client.http import PlaidAPIError

from . import filetools, sandbox, webtools
from .limits import MAX_PROJECTS
from .tools import ToolError

# The tools that act on the plan rather than on a project. The plan is the home
# project's, so these always act there, whatever project they are handed.
PLAN_TOOLS = ('plan_status', 'discard_plan', 'drop_planned')

# The tools that never read a project: the web, the attached files, and the
# code worker, which is one per turn and reaches other projects through its
# own host functions. A ``project`` handed to one of these is dropped.
LOCAL_TOOLS = frozenset(webtools.NAMES) | frozenset(filetools.NAMES) | frozenset(sandbox.NAMES)


def reachable(home_id: str, joined: Any, token_reaches: Iterable[str]
              ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """``(allowed, refused)``: the other projects a turn may open, as
    ``{id, name}`` in the order the reader added them, and those it may not.

    THE place the set of projects a turn reaches is decided. Everything that
    opens a project for a turn is handed this answer and opens nothing else.

    ``joined`` is what the user's message carries. Entries without an id and
    repeats are dropped, the home project is not counted twice. A project the
    requester's token does not reach (``token_reaches``, the ids the server
    scoped it to) is refused, and so is every one past the cap, rather than
    silently left out.
    """
    reaches = {str(pid).lower() for pid in token_reaches or ()}
    allowed: List[Dict[str, str]] = []
    refused: List[Dict[str, str]] = []
    seen = {home_id}
    for entry in joined if isinstance(joined, list) else []:
        pid = entry.get('id') if isinstance(entry, dict) else None
        if not isinstance(pid, str) or not pid or pid in seen:
            continue
        seen.add(pid)
        name = entry.get('name')
        item = {'id': pid, 'name': name if isinstance(name, str) and name else pid}
        ok = pid.lower() in reaches and len(allowed) < MAX_PROJECTS - 1
        (allowed if ok else refused).append(item)
    return allowed, refused


class Reach:
    """The projects one turn may read: its home workspace and the others the
    reader joined, each a workspace of its own, built on first use.

    ``token_reaches`` is the ids the requester's token is scoped to.
    ``open_project(id)`` loads a project for reading or raises: the service's
    check that the project is readable, served by this assistant, and one the
    app can read. ``make_workspace(project)`` is the app's own workspace
    constructor with the requester's client already bound.
    """

    def __init__(self, home_ws, joined: Any, token_reaches: Iterable[str],
                 open_project: Callable[[str], Any], make_workspace: Callable[[Any], Any]):
        self.home = home_ws
        self._make_workspace = make_workspace
        self._projects: Dict[str, Any] = {}
        self._workspaces: Dict[str, Any] = {}
        #: [{'id', 'name'}] of the projects that could not be opened this turn.
        self.unavailable: List[Dict[str, str]] = []
        #: The names of the plan tools offered this turn (core.tools.tools_for).
        self.writers: frozenset = frozenset()
        allowed, refused = reachable(home_ws.project.id, joined, token_reaches)
        self.unavailable.extend(refused)
        for entry in allowed:
            try:
                project = open_project(entry['id'])
            except Exception as e:  # noqa: BLE001 - any failure means the same thing to the model: not this turn
                print(f'Project {entry["id"]} was not opened for this turn: {e}')
                if not isinstance(e, (ValueError, LookupError, PlaidAPIError)):
                    traceback.print_exc()
                self.unavailable.append(entry)
                continue
            self._projects[project.id] = project
        home_ws.reach = self
        home_ws.home = True

    @property
    def home_project(self):
        return self.home.project

    @property
    def others(self) -> List[Any]:
        """The other projects that opened, in the order the reader added them."""
        return list(self._projects.values())

    def labels(self) -> List[str]:
        """What the model writes to name each project, home first: its name,
        or its id where two projects share a name (as documents are named)."""
        projects = [self.home_project, *self.others]
        names = [(p.name or '').casefold() for p in projects]
        return [p.name if p.name and names.count((p.name or '').casefold()) == 1 else p.id
                for p in projects]

    def plan_project(self) -> Dict[str, str]:
        """The project a plan made in this turn changes, as ``{id, name}``
        for the plan record, so the card can name it where the conversation
        reads other projects. Always the home project."""
        p = self.home_project
        return {'id': p.id, 'name': p.name or p.id}

    def resolve(self, project: Any):
        """The project a tool was asked about: by id, exact name, or a unique
        prefix of a name, among the projects this turn may read."""
        wanted = str(project if project is not None else '').strip()
        projects = [self.home_project, *self.others]
        if not wanted:
            return self.home_project
        for p in projects:
            if p.id == wanted:
                return p
        key = wanted.casefold()
        named = [p for p in projects if (p.name or '').casefold() == key]
        if len(named) == 1:
            return named[0]
        if len(named) > 1:
            raise ToolError(f'Several projects in this conversation are named "{wanted}"; use an id: '
                            + ', '.join(p.id for p in named))
        starts = [p for p in projects if (p.name or '').casefold().startswith(key)]
        if len(starts) == 1:
            return starts[0]
        raise ToolError(f'No project "{wanted}" in this conversation. It reads: '
                        + ', '.join(f'"{label}"' for label in self.labels()) + '.')

    def workspace(self, project: Any):
        """The workspace for ``project`` (see :meth:`resolve`), made on first
        use. Another project's workspace shares the home workspace's web
        session and attachments, so what the turn has read from the web and
        what the user attached are one per turn, and it never stages."""
        p = self.resolve(project)
        if p.id == self.home_project.id:
            return self.home
        ws = self._workspaces.get(p.id)
        if ws is None:
            ws = self._make_workspace(p)
            ws.reach = self
            ws.home = False
            ws.writable = False
            ws.web = self.home.web
            ws.files = self.home.files
            self._workspaces[p.id] = ws
        return ws

    def workspaces(self) -> List[Any]:
        """The home workspace and every other one made so far this turn."""
        return [self.home, *self._workspaces.values()]

    def close(self) -> None:
        """Release what the other workspaces held (a read pool). The home
        workspace is the service's to close. The workspaces themselves stay,
        with what they read, for the reply's citations, exactly as the home
        workspace does."""
        for ws in self._workspaces.values():
            try:
                ws.close()
            except Exception:  # noqa: BLE001 - releasing must never fail a finished turn
                traceback.print_exc()


def target(ws, project: Any):
    """The workspace ``project`` names, from a turn's workspace. Without a
    reach, the turn reads its own project only, so naming that is allowed and
    naming anything else is refused."""
    if project is None or project == '':
        return ws
    reach = getattr(ws, 'reach', None)
    if reach is not None:
        return reach.workspace(project)
    wanted = str(project).strip()
    if wanted == ws.project.id or wanted.casefold() == (ws.project.name or '').casefold():
        return ws
    raise ToolError(f'No project "{wanted}" in this conversation. It reads "{ws.project.name}" only.')


def route(ws, name: str, args: Any) -> Tuple[Any, Any]:
    """``(workspace, args)`` for one tool call: the workspace of the project the
    call names, and its arguments without ``project``. Called first in every
    app's ``call_tool``, so the model's calls and the code's ``plan()`` both
    come through it. Raises :class:`ToolError` for a project the turn cannot
    read.

    A turn that reads one project has no reach, and its calls pass through
    untouched. The arguments are copied rather than changed, because the
    caller records them in the step trace as the model wrote them.
    """
    reach = getattr(ws, 'reach', None)
    if reach is None or not isinstance(args, dict) or 'project' not in args:
        return ws, args
    rest = {k: v for k, v in args.items() if k != 'project'}
    if name in LOCAL_TOOLS or name in PLAN_TOOLS:
        reach.home.reads = ws.reads
        return reach.home, rest
    there = reach.workspace(args['project'])
    # What the call reads is noted where the loop looks for it.
    there.reads = ws.reads
    if name in reach.writers:
        # Refused before the tool runs, not only where it stages: a tool
        # that reads its target first answered about the other project's
        # fields ("No field named ...") and never reached the refusal.
        there.refuse_read_only()
    return there, rest
