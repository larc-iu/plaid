"""The IGT assistant: what the shared service needs to know about IGT.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is IGT's half: the
project it loads, the workspace its tools run against, its prompt, how a
citation resolves to an example card, and how an approved plan is applied.
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
**IGT Assistant** is a chat assistant over this project, powered by whatever
model the Plaid operator configured (any provider litellm supports).

Ask it analytic questions (how is X glossed, which words are unanalyzed, are
these glosses consistent), or ask it to make changes: fix a gloss across the
corpus, segment and gloss words, link words to lexicon entries, add entries,
respell words, fill in an orthography, confirm or discard what another service
produced. It never writes on its own: a request that changes data comes back
as a **plan** you approve or discard. Approved changes are applied under your
own account, in one audit-log entry, and recorded as **verified** (made by the
assistant, confirmed by you), or as human-made if you say so when approving.

Readers can use it for questions; planning and applying changes needs write
access.
"""


class AssistantService(BaseAssistantService):
    APP = 'igt'
    APP_LABEL = 'IGT Assistant'
    DESCRIPTION = 'Chat about the project and plan edits, with the operator\'s model'
    SUMMARY = SUMMARY
    PING_QUERY = 'interlinear glossed text'
    reference_shape = 'a bare reference like s3, s3.w2 or s3.w2.m1'

    def toolkit(self) -> Toolkit:
        return Toolkit(tools_for=tools_for, call_tool=call_tool, tracer=TRACER)

    def load_project(self, client, project_id):
        return load_project(client, project_id)

    def make_workspace(self, client, project, on_progress):
        return Workspace(client, project, on_progress=on_progress)

    def system_prompt(self, project, web: bool) -> str:
        return build_system_prompt(project, web=web)

    def document_name(self, ws, document_id: str) -> Optional[str]:
        # The name a printed reference uses, so what the model is told matches
        # what a tool will accept back.
        return ws.corpus.ref_name(document_id)

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
