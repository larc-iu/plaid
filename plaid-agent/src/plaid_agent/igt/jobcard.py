"""Drafting an unattended job with the user: the ``propose_job`` tool.

The chat scopes a job (SPEC of the jobs round, BRIEF-JB 2026-11-13): the model
reads the documents, asks what the data shows matters, and ends by drafting
the job. The draft is a JOB CARD on the reply (``ws.job_card``, carried as the
reply's ``job``): the documents and the brief, the job's instructions, which
its model reads with every piece of its work. It writes nothing and starts nothing. The page
starts the job as the signed-in user, under the card's id, so its starter is
the person and every rule of who may start one is core's.

Staging asks what core asks at the start, so the model hears a refusal while
it can still change the draft: documents of this project, at most the number
core publishes, the brief within the instructions' limit core publishes,
and no job already active on the project, and a user who may start one (a writer, as the page's Start job
asks). A turn holds a job card or a plan of changes, never both: whichever
is staged first stands (``core.workspace.JOB_CARD_REFUSAL`` for the other way
round).
"""

from typing import Any, Dict, List, Optional

from plaid_client import uuid7

from ..core.history import doc_label
from ..core.plan import held_changes
from ..core.scope import is_all, resolve_documents
from ..core.tools import ToolError

#: What a job's states are called in a refusal.
_STATE_WORDS = {'waiting': 'waiting to start', 'running': 'running', 'stopping': 'stopping'}


def _help(facts: Dict[str, Any]) -> str:
    brief_max = facts.get('instructions_max_chars')
    docs_max = facts.get('documents_max')
    within = f' At most {brief_max:,} characters.' if brief_max else ''
    most = f', at most {docs_max:,}' if docs_max else ''
    return '\n'.join([
        'propose_job drafts an unattended job: the assistant works the documents in the background, with its '
        'tools, by the brief alone. Every change it plans in the documents and the lexicons is written, deletions '
        'included, each value an unverified machine proposal that people check in the grid. Project setup and a '
        'few other kinds of change are listed in the job\'s report for a person to approve. The draft writes '
        'nothing and starts nothing. The user reads the card, may edit the '
        'brief, and starts the job or discards it.',
        f'- documents: names or ids{most}, or ["all"] for every document of the project.',
        '- brief: the job\'s instructions, which its model reads with every piece of its work, with nothing of '
        'this conversation. Write the decisions, not the discussion: what to do, what to leave, the conventions '
        'settled, in plain imperative sentences that name forms and glosses exactly, such as "Gloss -da as '
        f'LOC after a noun and as 3SG after a verb." or "Leave the Russian loanwords unanalysed."{within}',
        '- The job changes and deletes what people wrote where the brief asks it to, and follows how people '
        'analysed a form.',
        '- A turn holds a job card or a plan of changes, not both. Drafting again in the same turn replaces the '
        'card.',
    ])


def _facts(ws) -> Dict[str, Any]:
    """Core's limits on a job (``jobs.worker()``: the note's and the
    documents' caps), read where CONTRACT 3.9 publishes them. The service
    reads them with its own client (``ws.job_facts``), since a delegated
    token may not. Nothing when they cannot be read: core refuses at the
    start whatever passes here."""
    read = getattr(ws, 'job_facts', None) or ws.client.jobs.worker
    try:
        facts = read() or {}
    except Exception:  # noqa: BLE001 - the start is core's to refuse
        return {}
    return facts if isinstance(facts, dict) else {}


def _documents(ws, documents, facts: Dict[str, Any]) -> Dict[str, Any]:
    """The card's documents: ``{all, count}`` for the whole project, else
    ``{all: False, count, documents: [{id, name}]}``."""
    if documents is None or documents == [] or documents == '':
        raise ToolError('Name the documents, or ["all"] for every document of the project.',
                        kind='invalid-argument')
    if is_all(documents):
        n = len(ws.documents())
        if not n:
            raise ToolError('This project has no documents.', kind='not-found')
        out: Dict[str, Any] = {'all': True, 'count': n}
    else:
        ids = resolve_documents(ws, documents)
        n = len(ids)
        out = {'all': False, 'count': n, 'documents': [{'id': i, 'name': doc_label(ws, i)} for i in ids]}
    most = facts.get('documents_max')
    if most and n > most:
        raise ToolError(f'A job takes at most {most:,} documents, and this names {n:,}. Draft it for at most '
                        f'{most:,} of them.', kind='too-large')
    return out


def _brief(brief, facts: Dict[str, Any]) -> str:
    text = brief.strip() if isinstance(brief, str) else ''
    if not text:
        raise ToolError('Write the brief: the decisions the job follows, in plain imperative sentences.',
                        kind='invalid-argument')
    most = facts.get('instructions_max_chars')
    if most and len(text) > most:
        raise ToolError(f'The brief is {len(text):,} characters, and a job\'s brief is at most {most:,}. Keep '
                        'the decisions and drop the rest.', kind='too-large')
    return text


def _active_refusal(ws, job: Dict[str, Any]) -> str:
    """The refusal for a project that already has a job, naming it so the
    reply can link it (the app's job page)."""
    state = _STATE_WORDS.get(job.get('state'), job.get('state') or 'active')
    page = f'#/projects/{ws.project.id}/jobs/{job.get("id")}'
    return (f'This project already has a job, {state}, and a project runs one job at a time. Tell the user, '
            f'with a link to its page: [the job]({page}). Draft this one once it has ended.')


#: A user who may not start a job (a reader): the card would be a dead end.
READER_REFUSAL = ('Starting a job needs write access. Tell the user so, and that a writer of the project can start '
                  'one.')


def _may_start(ws) -> bool:
    """The page's rule (plaid-ui ``canStartJob``, which is
    ``canEditProject``): a writer or maintainer of the project, by its lists
    as core gives them with the project, or an administrator. No user (a
    script, a test) is left to core, which checks at the start anyway."""
    if ws.requester_id is None:
        return True
    return ws.requester_role() in ('maintainer', 'writer') or ws.requester_is_admin()


def summary(card: Dict[str, Any]) -> str:
    """The card in the words of the plan line: "3 documents"."""
    n = card['count']
    return f'{"all " if card.get("all") else ""}{n:,} document{"s" if n != 1 else ""}'


def t_propose_job(ws, action: str, documents: Optional[Any] = None, brief: Optional[str] = None) -> str:
    """Draft a job for the user to start (see the module's note)."""
    act = (action or '').strip().lower() if isinstance(action, str) else ''
    if act == 'help':
        return _help(_facts(ws))
    if act != 'draft':
        raise ToolError('action is help or draft. Call with action "help" first.', kind='invalid-argument')
    ws.refuse_read_only()
    ws.refuse_web_read()
    if not _may_start(ws):
        raise ToolError(READER_REFUSAL, kind='not-allowed')
    if ws.ops:
        held = held_changes(ws)
        raise ToolError(f'This turn planned {held} change{"s" if held != 1 else ""}, and a turn holds a plan or '
                        'a job card, not both. To draft the job in its place, discard_plan first, or draft it in '
                        'a later message.', kind='not-allowed')
    facts = _facts(ws)
    card: Dict[str, Any] = _documents(ws, documents, facts)
    text = _brief(brief, facts)
    active = ws.client.jobs.active(ws.project.id)
    if active:
        raise ToolError(_active_refusal(ws, active), kind='not-allowed')
    replaced = ws.job_card is not None
    card.update({'id': str(uuid7()), 'brief': text})
    card['summary'] = summary(card)
    ws.job_card = card
    return ('Drafted the job card' + (', in place of the one drafted earlier in this turn' if replaced else '')
            + '. The user reads it, may edit the brief, and starts the job or discards it.')
