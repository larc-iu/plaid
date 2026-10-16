"""The UMR assistant: what the shared service needs to know about UMR.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is UMR's half.
"""


from ..core.service import BaseAssistantService
from . import plan, prompt, toolkit
from .citations import resolve_citations
from .project import load_project
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
    TOOLKIT, PROMPT, PLAN, TRACER, WORKSPACE = toolkit, prompt, plan, TRACER, Workspace
    load_project = staticmethod(load_project)
    citations = staticmethod(resolve_citations)
    reference_shape = 'a bare reference like s3 or s3.s3e'
    # What a proposed change is kept as once its plan is settled: the node or
    # relation it lands on (an edge at its source, a new node at its sentence),
    # and its new value (a node's attributes as one line, empty when a change
    # removes them all).
    proposed_keys = (('span_id', 'relation_id', 'token_ids', 'source_span_id', 'guideline_id', 'entity_id',
                      'sentence_id', 'document_id', 'text_id'),
                     ('value', 'concept', 'role', 'rel', 'attr_line', 'order', 'title', 'body', 'as_of'),
                     # The second thing a relation joins: its target node
                     # (None for a node the plan makes).
                     {'create_edge': 'target_span_id', 'create_triple': 'target_span_id'})


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
