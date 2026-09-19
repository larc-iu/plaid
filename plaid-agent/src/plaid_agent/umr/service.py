"""The UMR assistant: what the shared service needs to know about UMR.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is UMR's half.
"""

from typing import Any, Dict, List, Optional

from ..core.agent import Toolkit
from ..core.service import BaseAssistantService, build_web_config, check_hint, stale_documents  # noqa: F401
from .citations import resolve_citations
from .plan import execute_plan, summarize
from .project import load_project
from .prompt import build_system_prompt
from .toolkit import call_tool, tools_for
from .tools import Workspace
from .trace import TRACER

SUMMARY = """\
**UMR Assistant** is a chat assistant over this corpus, powered by whatever
model the Plaid operator configured (any provider litellm supports).

Ask it analytic questions (which concepts carry which aspect, where a roleset
takes an unusual argument, what the document graph says about a referent), or
ask it to make changes: rewrite a sentence's graph, set a node's attributes,
and add or remove a temporal, modal or coreference relation. It never writes on
its own: a request that changes data comes back as a **plan** you approve or
discard. Approved changes are applied under your own account, in one audit-log
entry, and recorded as **verified** (made by the assistant, confirmed by you),
or as human-made if you say so when approving.

Readers can use it for questions. Planning and applying changes needs write
access.
"""


class AssistantService(BaseAssistantService):
    APP = 'umr'
    APP_LABEL = 'Plaid UMR'
    DESCRIPTION = 'Chat about the meaning graphs and plan edits, with the operator\'s model'
    SUMMARY = SUMMARY
    PING_QUERY = 'uniform meaning representation'
    reference_shape = 'a bare reference like s3 or s3.s3e'

    def toolkit(self) -> Toolkit:
        return Toolkit(tools_for=tools_for, call_tool=call_tool, tracer=TRACER)

    def load_project(self, client, project_id):
        return load_project(client, project_id)

    def make_workspace(self, client, project, on_progress):
        return Workspace(client, project, on_progress=on_progress)

    def system_prompt(self, project, web: bool) -> str:
        return build_system_prompt(project, web=web)

    def place(self, ws, where: Optional[dict]) -> Optional[tuple]:
        # A document is the only thing this app docks the assistant beside.
        # The name is the one the tools accept back: two documents may share
        # one, and resolve_document_id refuses an ambiguous name, so those are
        # named by id instead.
        where = where or {}
        if where.get('kind') != 'document':
            return None
        document_id = where.get('id')
        names = [d.get('name') or '' for d in ws.documents() if d['id'] == document_id]
        if not names:
            return None
        name = names[0]
        clashes = sum(1 for d in ws.documents() if (d.get('name') or '').lower() == name.lower())
        return self.document_place(name if clashes == 1 else document_id)

    def citations(self, ws, text: str) -> List[Dict[str, Any]]:
        return resolve_citations(ws, text)

    def execute_plan(self, client, ops: List[Dict[str, Any]], *, source: str, label: str, project,
                     stamp_mode: str, contributor: Optional[str]) -> Dict[str, int]:
        return execute_plan(client, ops, source=source, label=label, project=project,
                            stamp_mode=stamp_mode, contributor=contributor)

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        return summarize(ops)


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
