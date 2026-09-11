"""The UD assistant: what the shared service needs to know about UD.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is UD's half.
"""

from typing import Any, Dict, List, Optional

from ..core.agent import Toolkit
from ..core.service import BaseAssistantService, build_web_config, check_hint, stale_documents  # noqa: F401
from .citations import resolve_citations
from .plan import execute_plan, summarize
from .project import load_project
from .prompt import build_system_prompt
from .tools import Workspace, call_tool, tools_for
from .trace import TRACER

SUMMARY = """\
**UD Assistant** is a chat assistant over this treebank, powered by whatever
model the Plaid operator configured (any provider litellm supports).

Ask it analytic questions (which words are missing a lemma, where one lemma
takes several parts of speech, how a relation is used across the corpus), or
ask it to make changes: set a lemma, a part of speech, features, or a word's
head and relation, and confirm or discard what a parser produced. It never
writes on its own: a request that changes data comes back as a **plan** you
approve or discard. Approved changes are applied under your own account, in
one audit-log entry, and recorded as **verified** (made by the assistant,
confirmed by you), or as human-made if you say so when approving.

Readers can use it for questions. Planning and applying changes needs write
access.
"""


class AssistantService(BaseAssistantService):
    APP = 'ud'
    APP_LABEL = 'UD Assistant'
    DESCRIPTION = 'Chat about the treebank and plan edits, with the operator\'s model'
    SUMMARY = SUMMARY
    PING_QUERY = 'universal dependencies treebank'

    def toolkit(self) -> Toolkit:
        return Toolkit(tools_for=tools_for, call_tool=call_tool, tracer=TRACER)

    def load_project(self, client, project_id):
        return load_project(client, project_id)

    def make_workspace(self, client, project, on_progress):
        return Workspace(client, project, on_progress=on_progress)

    def system_prompt(self, project, web: bool) -> str:
        return build_system_prompt(project, web=web)

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
