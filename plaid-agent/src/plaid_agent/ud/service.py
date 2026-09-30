"""The UD assistant: what the shared service needs to know about UD.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is UD's half.
"""

from typing import Any, Dict, List, Optional

from ..core.agent import Toolkit
from ..core.service import BaseAssistantService, build_web_config, check_hint, stale_documents  # noqa: F401
from .citations import resolve_citations
from ..core.plan import documents_to_lock
from .plan import REWRITES_DOCUMENT, execute_plan, summarize
from .project import load_project
from .prompt import CODE, SYSTEM, WEB, build_system_prompt, project_brief
from .toolkit import TOOLS, call_tool, tools_for
from .tools import Workspace
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
    reference_shape = 'a bare reference like s3 or s3.w2'
    # What a proposed change is kept as once its plan is settled: the word,
    # relation or sentence it lands on, and its new value (a head's is its
    # relation label).
    proposed_keys = (('word_id', 'token_id', 'span_id', 'relation_id', 'sentence_id', 'entity_id', 'guideline_id',
                      'document_id', 'document_ids', 'text_id'),
                     ('value', 'deprel', 'replacement', 'title', 'body', 'as_of'),
                     # The second thing a change joins: a dependent's head (the
                     # word itself for the root), and the sentence a merge takes in.
                     {'set_head': 'head_id', 'merge_sentences': 'previous_id'})

    def toolkit(self) -> Toolkit:
        return Toolkit(tools_for=tools_for, call_tool=call_tool, tracer=TRACER)

    def load_project(self, client, project_id):
        return load_project(client, project_id)

    def make_workspace(self, client, project, on_progress):
        return Workspace(client, project, on_progress=on_progress)

    def system_prompt(self, project, web: bool) -> str:
        return build_system_prompt(project, web=web)

    def prompt_template(self):
        return [SYSTEM, WEB, CODE], TOOLS

    def project_brief(self, project) -> str:
        return project_brief(project)

    def citations(self, ws, text: str) -> List[Dict[str, Any]]:
        return resolve_citations(ws, text)

    def execute_plan(self, client, ops: List[Dict[str, Any]], *, source: str, label: str, project,
                     stamp_mode: str, contributor: Optional[str],
                     requester: Optional[str] = None,
                     detail: Optional[Dict[str, Any]] = None,
                     seed: Optional[str] = None) -> Dict[str, int]:
        return execute_plan(client, ops, source=source, label=label, project=project,
                            stamp_mode=stamp_mode, contributor=contributor, detail=detail,
                            seed=seed)

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        return summarize(ops)

    def documents_to_lock(self, ops: List[Dict[str, Any]], documents: List[Dict[str, Any]]) -> List[str]:
        # The parser locks the document it rewrites itself, as another
        # service, so holding it here would refuse the parse.
        return documents_to_lock(ops, documents, exclude=REWRITES_DOCUMENT)


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
