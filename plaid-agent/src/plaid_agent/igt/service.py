"""The IGT assistant: what the shared service needs to know about IGT.

The request lifecycle, the conversation record, the model loop and the plan
mechanics are all in :mod:`plaid_agent.core`. What is here is IGT's half: the
project it loads, the workspace its tools run against, its prompt, how a
citation resolves to an example card, and how an approved plan is applied.
"""

from typing import Dict, Optional

from ..core.service import BaseAssistantService, build_web_config, check_hint, stale_documents  # noqa: F401
from ..core.plan import PlanError, PlanOutOfDate
from . import plan, prompt, toolkit
from .citations import resolve_citations
from .project import load_project
from .tagsets import SETTINGS_KINDS, verify_settings
from .prompt import lexicon_focus_note
from .trace import TRACER
from .workspace import Workspace

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


NO_SENTENCE_NOTE = ('A word or morpheme named by its place ("the third word") or by a form the text holds more '
                    'than once, with no sentence named, is in no particular sentence: ask which sentence before '
                    'planning anything.')


class AssistantService(BaseAssistantService):
    APP = 'igt'
    APP_LABEL = 'IGT Assistant'
    DESCRIPTION = 'Chat about the project and plan edits, with the operator\'s model'
    SUMMARY = SUMMARY
    PING_QUERY = 'interlinear glossed text'
    TOOLKIT, PROMPT, PLAN, TRACER, WORKSPACE = toolkit, prompt, plan, TRACER, Workspace
    load_project = staticmethod(load_project)
    citations = staticmethod(resolve_citations)
    reference_shape = 'a bare reference like s3, s3.w2 or s3.w2.m1'
    # What a proposed change is kept as once its plan is settled: the word,
    # morpheme, entry or text it lands on, and its new value (a link's is the
    # entry form it links to). A phrase link is at its first word, whether its
    # entry exists or not.
    proposed_keys = (('token_id', 'analysis_word_id', 'word_id', 'morpheme_id', 'span_id', 'link_id', 'token_ids',
                      'item_id', 'keep_id', 'guideline_id', 'sentence_id', 'entity_id', 'document_id',
                      'vocab_id', 'text_id', 'key', 'owner'),
                     ('value', 'form', 'entry_form', 'new', 'name', 'morph_type', 'title', 'body', 'as_of', 'after'),
                     # The second thing a change joins: the entry a word is
                     # linked to (None for one the plan makes), and what a
                     # merge takes in.
                     {'link': 'item_id', 'link_phrase': 'item_id', 'merge_entries': 'remove_id',
                      'merge_words': 'other_ids', 'merge_sentences': 'other_id'})

    def page_wrote(self, client, project_id: str, ops) -> Optional[Dict[str, int]]:
        # Tagset changes, always a plan of their own, are written by the app
        # (plaid-igt domain/tagsetPlan.js) before it sends the approval.
        if not ops or not all(op.get('kind') in SETTINGS_KINDS for op in ops):
            return None
        try:
            return verify_settings(client, self.load_project(client, project_id), ops)
        except (PlanError, PlanOutOfDate):
            return None

    def may_approve(self, client, project_id: str, user_id: str, ops) -> Optional[str]:
        # Settings are a maintainer's: of the project, or of the lexicon whose
        # tagsets they are. An administrator may approve any.
        if not ops or not all(op.get('kind') in SETTINGS_KINDS for op in ops):
            return None
        try:
            if (client.users.get(user_id) or {}).get('is_admin'):
                return None
        except Exception:  # noqa: BLE001 - a delegated token may not read users: counted by role
            pass
        for owner in dict.fromkeys(op.get('owner') for op in ops):
            if owner == 'project':
                held, what = client.projects.get(project_id) or {}, 'this project'
            else:
                held = client.vocab_layers.get(owner) or {}
                what = f'the lexicon "{held.get("name") or owner}"'
            if user_id not in (held.get('maintainers') or []):
                return (f'Only a maintainer of {what} may approve its tagset changes. '
                        'Nothing was written.')
        return None

    def place(self, ws, where: Optional[dict]) -> Optional[tuple]:
        where = where or {}
        # The Entries screen docks the assistant too, and what is in front of
        # the user there is a vocabulary rather than a text. "Vocabulary" is
        # the word the app puts on screen, and the stamp goes in front of the
        # user's own question, so it is the word the model should read there.
        # How to treat one also differs from how to treat a document, so the
        # note is its own.
        if where.get('kind') == 'lexicon':
            name = next((v['name'] for v in ws.project.vocabs if v['id'] == where.get('id')), None)
            return ('vocabulary', name, lexicon_focus_note(name)) if name else None
        if where.get('kind') == 'document':
            # The name a printed reference uses here is the corpus tag's, not
            # the document's own, so this app answers for a document too.
            return self.document_place(ws.corpus.ref_name(where.get('id')))
        return super().place(ws, where)

    def document_place(self, name: Optional[str]) -> Optional[tuple]:
        # The open text is a default for WHICH DOCUMENT, never for which
        # sentence. Said here as well as in the prompt, beside the note that
        # names the document, since the model otherwise read "the third word"
        # as the third word of sentence 1 and planned it.
        place = super().document_place(name)
        return (*place[:2], place[2] + ' ' + NO_SENTENCE_NOTE) if place else None


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
