"""One turn of the model: what it is given (the transcript held to its window,
the stamps on the question, the note on what is open and on the other
projects it may read), the run, and the record it leaves, however it ends."""

import contextlib
import re
import time
import traceback
from typing import Any, Dict, List, Optional

from plaid_client import ServiceCancelled
from plaid_client.http import PlaidAPIError
from plaid_client.service import requester_message

from . import filetools
from .bidi import escape_name
from . import prompt as shared_prompt
from .guidelines import in_reading_order
from .limits import TRANSCRIPT_WINDOW_SHARE
from .reach import Reach
from .agent import (TurnCancelled, TurnFailed, turn_reply_round, turn_trace, context_window, model_failure_line,
                    run_turn, token_counter)
from .files import Attachments, FileKeeper
from .garble import seed
from .guidelines import in_context as guidelines_in_context
from .conversation import (assistant_item, error_item, held_transcript, proposed_changes, prune, record_budget,
                           turn_ending)
from .rounds import RoundKeeper
from .plan import outcome_unknown, waiting_plan
from .web import session_for


class Turn:
    """The turn of `BaseAssistantService`."""

    def open_project(self, client, project_id: str):
        """A project other than the conversation's own, loaded for a turn to
        read, or raises. Read with the requester's own client, so the server
        checks the user's own role in it, and opened only where this same
        assistant is online: an operator who kept a model off a project keeps
        that project's text away from the model."""
        served = client.messages.discover_services(project_id) or []
        if not any(s.get('service_id') == self.service_id and s.get('online') is not False
                   for s in served if isinstance(s, dict)):
            raise LookupError(f'{self.service_id} is not online in project {project_id}')
        return self.load_project(client, project_id)

    def open_reach(self, client, ws, joined, token_reaches) -> Optional[Reach]:
        """The other projects this turn may read, or None when the user added
        none. ``joined`` is what their message carries, ``token_reaches`` the
        projects the requester's token is scoped to (``delegated_projects``)."""
        if not joined:
            return None
        reach = Reach(ws, joined, token_reaches, lambda pid: self.open_project(client, pid),
                      lambda project: self.make_workspace(client, project, ws.on_progress))
        # A list naming only this project, or nothing usable, adds no project
        # and refuses none: the turn is a one-project turn, as if it were empty.
        if not reach.others and not reach.unavailable:
            ws.reach = None
            return None
        return reach

    def other_projects_note(self, reach: Reach) -> str:
        """The paragraph of the system prompt about the other projects."""
        labels = reach.labels()
        briefs = [shared_prompt.project_brief(
                      label, self.project_brief(p),
                      [g.title for g in in_reading_order(getattr(p, 'guidelines', None) or [])])
                  for label, p in zip(labels[1:], reach.others)]
        return shared_prompt.other_projects(labels[0], briefs, [u['name'] for u in reach.unavailable])

    def _turn(self, client, project, store, conv_id, conv, meta, request_id, response_helper,
              request_data: Optional[dict] = None, cancel=lambda: False) -> None:
        # How long the reply took, kept on it: the reader watches a clock while
        # it is written and wants the figure after (comparing it with doing the
        # same by hand).
        started = time.monotonic()
        transcript = conv['messages']
        if not transcript or transcript[-1].get('role') != 'user':
            response_helper.error('The conversation has no message to answer')
            return
        model = self.cfg.model
        # Every progress event carries the turn so far, whole each time, so a
        # watcher (or one that rejoins, which core replays only the last event
        # to) draws it as it grows: the steps as they will be stored
        # (`RoundKeeper.live_trace`), the text of the model call under way,
        # and the end of its reasoning (`THINKING_TAIL`).
        state = {'pct': 5, 'msg': ''}
        keeper = RoundKeeper(store, conv_id)

        def send(msg):
            state['msg'] = msg
            response_helper.progress(state['pct'], msg, text=keeper.text, trace=keeper.live_trace(),
                                     thinking=keeper.thinking[-THINKING_TAIL:])

        def on_progress(pct, msg):
            state['pct'] = max(state['pct'], pct)
            send(msg)

        def on_text(text):
            # '' starts a model call: the line stays "Thinking…" until the
            # model writes, so it does not say "Writing…" while it reasons.
            keeper.text = text
            send('Writing…' if text else state['msg'])

        # The loop hands the reasoning to the keeper (`RoundKeeper.think`),
        # which sends it on.
        keeper.on_thinking = lambda: send(state['msg'])

        def cancelled() -> bool:
            return bool(getattr(response_helper, 'cancelled', False)) or cancel()
        keeper.cancelled = cancelled

        # A stop asked for while the turn is being set up (the progress
        # lines sent while a document or another project loads are the
        # client's cancellation checkpoints) takes effect at the turn's first
        # check, where it is recorded with everything else a stop records.
        # The setup is inside a try of its own: a failure there (a project
        # another reach cannot open, a prompt hook) writes the record and
        # answers the request, as a failure of the turn does (REV-MULTI).
        ws = None
        try:
            with _held(response_helper):
                ws = self.make_workspace(client, project, send)
                ws.requester_id = store.user_id
                # What the user attached to this conversation, and the note in front of
                # the message it came on. The note is written BEFORE the place stamp,
                # because that one has to stay at the very start of the message: it is
                # found again by matching there (see `stamped`).
                ws.files = Attachments.of(store, conv_id, conv['display'])
                # What read_url fetches is stored beside the conversation as a file.
                ws.keeper = FileKeeper(store, conv_id)
                last_user = next((d for d in reversed(conv['display'] or []) if d.get('kind') == 'user'), None)
                ws.asked = str((last_user or {}).get('text') or '')
                # The plan an earlier message staged that still waits on its card,
                # which this turn's own plan replaces (see `turn_ending`).
                ws.waiting = waiting_plan(conv['display'])
                transcript = filetools.stamp(transcript, ws.files.named((last_user or {}).get('files') or []),
                                             ws.FILE_ROUTES)
                # The other projects the user added to the conversation, read from their
                # own message and nowhere else, and only those the requester's token
                # reaches (the server scoped it to them). Stamped onto the question when the set
                # changed, after the files note and before the place stamp, which has to
                # stay first on the line.
                reach = self.open_reach(client, ws, (last_user or {}).get('projects'),
                                        (request_data or {}).get('delegated_projects') or ())
                transcript = projects_stamped(transcript, reach.labels() if reach else [project.name])
                # Where this question was asked from, stamped onto the question itself.
                # The panel outlives the screen it was opened from, so one thread can
                # hold questions asked from several places, and the system note below
                # only ever describes the LAST of them. Without the stamp the model
                # reads turn 1's "this sentence" as being about turn 5's document.
                where = self.place(ws, (request_data or {}).get('where'))
                transcript = stamped(transcript, where[:2] if where else None)
                if self.web_cfg is not None:
                    ws.web = session_for(self.web_cfg, transcript)
                system = self.system_prompt(project, web=ws.web is not None)
                if reach is not None:
                    system = f'{system}\n\n{self.other_projects_note(reach)}'
                # Asked from inside a screen that is about one thing: say which, so an
                # unqualified question is about it. Nothing is taken away.
                if where and where[2]:
                    system = f'{system}\n\n{where[2]}'
                # What every call of the next turn sends besides the transcript, taken
                # off the window before the transcript is held to its share of it.
                overhead = (system, self.kit.tools_for(ws))
                # Each model call's input and output, stored beside the
                # conversation as it finishes, with the instructions it was given.
                keeper.system, keeper.tools = overhead
                ws.rounds = keeper
                # What the turn was given is text a value can be copied from (see
                # core.garble).
                seed(ws.seen, system, transcript, lambda tool, args: filetools.vouches(ws, tool, args))
        except Exception as e:  # noqa: BLE001 - whatever failed, the record must say so
            if ws is not None:
                self._release(ws)
                if getattr(ws, 'keeper', None) is not None:
                    ws.keeper.discard()
            traceback.print_exc()
            line = self.turn_failure_line(e)
            self._write(store, conv_id,
                        turn_ending(conv, conv['messages'],
                                    error_item(line, model=model, version=self.version, service=self.service_id)),
                        request_id, model)
            response_helper.error(line)
            return

        def fit(record):
            """The record held to its budget (`prune`)."""
            return prune(record, record_budget(client), self.transcript_budget(model, overhead))

        def shrink(history, new):
            """``history`` held to the window a refusal named, less what the
            turn added (`agent.Shrink`), or None when nothing more can go."""
            budget = self.transcript_budget(model, overhead)
            if budget is None:
                return None
            limit, measure = budget
            held = held_transcript(history, (limit - sum(measure(m) for m in new), measure))
            return held if held != history else None
        # Held to the window before it is sent, not only when the turn is
        # written: a record written under another model's window, or before
        # its window was known, was sent whole once and refused.
        transcript = held_transcript(transcript, self.transcript_budget(model, overhead))
        ws.shrink = shrink
        try:
            turn = run_turn(self.cfg, self.kit, ws, system,
                            transcript, on_progress, cancelled=cancelled, on_text=on_text)
        except (TurnCancelled, ServiceCancelled) as e:
            # Seen by the turn between its steps (TurnCancelled), or by the
            # client when a tool reported progress (ServiceCancelled, which
            # the client would otherwise end the request on, with nothing in
            # the record and the question left unanswered in the transcript).
            self._release(ws)
            ws.keeper.discard()
            # The user's message stays in the model transcript, as the turn
            # stamped it, so the next message ("go on", "I meant the second
            # one") is read with what it follows. Retry takes it off before
            # sending it again (`rewind_for_retry`). What the turn did before it
            # stopped stays on the item, for the record.
            steps, partial = turn_trace(e)
            self._write(store, conv_id,
                        turn_ending(conv, transcript,
                                    error_item('Stopped.', stopped=True, model=model, version=self.version,
                                               service=self.service_id, steps=steps, partial=partial,
                                               reply_round=turn_reply_round(e)),
                                    fit=fit),
                        request_id, model)
            response_helper.complete({'kind': 'stopped'})
            return
        except Exception as e:  # noqa: BLE001 - whatever failed, the record must say so
            self._release(ws)
            ws.keeper.discard()
            traceback.print_exc()
            line = self.turn_failure_line(e)
            steps, partial = turn_trace(e)
            # The user's message stays in the model transcript whatever the
            # model call did, as on a stop.
            self._write(store, conv_id,
                        turn_ending(conv, transcript,
                                    error_item(line, model=model, version=self.version,
                                               service=self.service_id, steps=steps, partial=partial,
                                               reply_round=turn_reply_round(e)),
                                    fit=fit),
                        request_id, model)
            response_helper.error(line)
            return
        self._release(ws)
        # The window goes on the item beside the counts: the reader is told how
        # full the thread is, and what it is full OF changes when the operator
        # points the service at a different model.
        usage = dict(turn.usage) if turn.usage else None
        if usage:
            window = context_window(model, self.cfg.context_window)
            if window:
                usage['window'] = window
        plan = ws.plan_payload()
        if plan and reach is not None:
            # The project the plan writes in, which the card names wherever
            # the conversation reads other projects too (A4-CROSS-1).
            plan['project'] = reach.plan_project()
        if plan:
            plan['proposed'], plan['proposed_count'] = proposed_changes(plan.get('ops') or [],
                                                                        *self.proposed_keys)
        item = assistant_item(turn.text, plan, self.citations(ws, turn.text),
                              turn.steps, turn.summary, model, usage,
                              guidelines_in_context(getattr(project, 'guidelines', None) or []),
                              version=self.version, service=self.service_id, reply_round=turn.reply_round,
                              reply_thought=turn.reply_thought)
        item['elapsed_ms'] = int((time.monotonic() - started) * 1000)
        if ws.keeper.refs:
            # The files this turn stored, which later turns read as the
            # conversation's own.
            item['files'] = [dict(r) for r in ws.keeper.refs]
        if reach is not None and reach.unavailable:
            item['unavailable_projects'] = [dict(u) for u in reach.unavailable]
        # A new plan replaces any still waiting: the model restates what still
        # applies in the plan it stages, so the older card is not left
        # approvable beside it.
        ending = turn_ending(conv, transcript, item, turn.messages, replaces=bool(item.get('plan')), fit=fit)
        try:
            written = self._write(store, conv_id, ending, request_id, model)
        except Exception as e:  # noqa: BLE001 - the answer is in hand; say so rather than lose it
            # This write is the LAST thing a turn does, and a refused save (too
            # large, a server error, a network blip) must not lose the answer
            # that is already computed. The request ends ONCE, with the answer
            # whole (`item`, as the record would have held it) and a line
            # saying the record did not take it, which the page shows once.
            # What this turn stored beside the conversation is kept, since
            # that item names it.
            traceback.print_exc()
            if _too_large(e):
                # The record is full: a short line stands in for the answer
                # after the question, so the record does not read as a
                # question ignored, and the marker is cleared.
                said = (STANDIN_PLAN if item.get('plan') else STANDIN)
                try:
                    self._write(store, conv_id,
                                turn_ending(conv, transcript,
                                            error_item(said, model=model, version=self.version,
                                                       service=self.service_id)),
                                request_id, model)
                except Exception:  # noqa: BLE001 - the answer still goes out
                    traceback.print_exc()
            elif outcome_unknown(e) or getattr(e, 'status', None) in (None, 0, 502, 503, 504):
                # The server is away: kept, and written as soon as it answers.
                said = 'Saving the conversation got no answer, so this answer may not be in the record yet.'
                self._keep_unsaved(store, conv_id, ending, request_id, model)
            else:
                said = (f'The conversation could not be saved: '
                        f'{requester_message(e, secrets=self.REQUEST_SECRETS).rstrip(".")}. '
                        f'This answer is not in the record.')
            response_helper.complete({'kind': 'turn', 'message': turn.text, 'warning': said, 'item': item})
            return
        if not written:
            # The conversation moved on (stopped, resent or deleted), so the
            # reply was dropped, and with it the only reference to what this
            # turn stored.
            ws.keeper.discard()
        try:
            response_helper.progress(100, 'Done')
        except ServiceCancelled:
            # Stopped after the answer was written: it is the outcome all the same.
            pass
        response_helper.complete({'kind': 'turn', 'message': turn.text, 'plan': item['plan'],
                                  'citations': item['citations'], 'steps': turn.steps, 'steps_summary': turn.summary})

    def transcript_budget(self, model: str, overhead) -> Optional[tuple]:
        """``(tokens, measure)`` the stored transcript may cost the model:
        its share of the window (`TRANSCRIPT_WINDOW_SHARE`) less what the
        system prompt and tool schemas take. None when the window is not
        known, and then prune holds the transcript to a byte figure instead."""
        window = context_window(model, self.cfg.context_window)
        if not window:
            return None
        measure = token_counter(model)
        return int(window * TRANSCRIPT_WINDOW_SHARE) - measure(overhead), measure

    def turn_failure_line(self, e: BaseException) -> str:
        """What the reader is told when a turn fails: one plain line. The
        exception itself went to the operator's log. A provider's error is
        never quoted (it names the library and can carry the endpoint, the
        request and the key), and anything else passes through
        ``requester_message``, which strips URLs and secrets."""
        if isinstance(e, TurnFailed):
            return str(e)
        return (model_failure_line(e, self.cfg.timeout)
                or f'The assistant could not answer: {requester_message(e, secrets=self.REQUEST_SECRETS)}')


def _held(response_helper):
    """The client's hold on cancellation (``ResponseHelper.critical``), or
    nothing for a helper that has none: a progress line sent inside it does
    not raise, and the stop is seen at the next checkpoint after it."""
    hold = getattr(response_helper, 'critical', None)
    return hold() if callable(hold) else contextlib.nullcontext()


#: The line that stands in for an answer a full record could not take.
STANDIN = 'This answer was not saved. This conversation is full.'
STANDIN_PLAN = 'This answer and its proposed changes were not saved. This conversation is full.'

#: How much of the reasoning of the model call under way a progress event
#: carries, from its end. Every event carries the turn whole, and the round
#: keeps the reasoning in full.
THINKING_TAIL = 2000

def _too_large(e) -> bool:
    return isinstance(e, PlaidAPIError) and e.status == 413


# The stamp that records which place a question was asked from, written onto
# the question and kept in the transcript for good.
#
# Read back as well as written: a thread that has not moved must not repeat the
# same line on every turn, which is noise the model has to re-read and which
# says nothing. Stamping only the CHANGES also gives the model the one fact
# that matters in a thread that wandered, which is that it wandered.
_STAMP = '[Asked from the {noun} "{name}"]'
_STAMP_RE = re.compile(r'^\[Asked from the ([^"\]]+) "(.*)"\]')


def _stamp_on(content) -> Optional[tuple]:
    """The (noun, name) a message was stamped with, or None."""
    if not isinstance(content, str):
        return None
    found = _STAMP_RE.match(content)
    return (found.group(1).strip(), found.group(2).replace('\\"', '"')) if found else None


def stamped(transcript: List[Dict[str, Any]], place: Optional[tuple]) -> List[Dict[str, Any]]:
    """The transcript with its last message stamped, if the place has changed.

    The scan looks back over the earlier messages for the last stamp, so the
    decision needs nothing carried between requests: the transcript is the
    record of where the user has been.
    """
    if not place or not transcript or transcript[-1].get('role') != 'user':
        return transcript
    for m in reversed(transcript[:-1]):
        was = _stamp_on(m.get('content')) if m.get('role') == 'user' else None
        if was:
            if was == place:
                return transcript
            break
    last = transcript[-1]
    note = _STAMP.format(noun=place[0], name=escape_name(place[1]))
    return transcript[:-1] + [{**last, 'content': f'{note}\n\n{last.get("content") or ""}'}]


# The stamp that records which projects a conversation may read, written onto
# the question when the set changed, on the same only-on-change rule as the
# place stamp above and for the same reason. It is not at the start of the
# message (the place stamp is), so it is looked for on a line of its own.
_PROJECTS_STAMP = '[Projects in this conversation: {names}]'
_PROJECTS_RE = re.compile(r'^\[Projects in this conversation: .*\]$', re.M)


def _projects_line(labels: List[str]) -> str:
    names = ', '.join(f'"{label}"' for label in labels)
    return _PROJECTS_STAMP.format(names=names if len(labels) > 1 else f'{names} only')


def projects_stamped(transcript: List[Dict[str, Any]], labels: List[str]) -> List[Dict[str, Any]]:
    """The transcript with its last message stamped with the projects this
    turn may read (the conversation's own first), if that set changed since
    the last stamp. A conversation that never read another project carries
    no stamp at all, and one that stops says so once."""
    if not labels or not transcript or transcript[-1].get('role') != 'user':
        return transcript
    line = _projects_line(labels)
    was = None
    for m in reversed(transcript[:-1]):
        content = m.get('content') if m.get('role') == 'user' else None
        found = _PROJECTS_RE.findall(content) if isinstance(content, str) else []
        if found:
            was = found[-1]
            break
    if was == line or (was is None and len(labels) == 1):
        return transcript
    last = transcript[-1]
    return transcript[:-1] + [{**last, 'content': f'{line}\n\n{last.get("content") or ""}'}]


# What the model is told when the user asks from inside a document.
#
# The default has to be stated much more firmly than the escape from it. An
# earlier version ended by inviting the model to read anything else in the
# project, and that is what it did: asked which sentence "here" had the most
# words, it listed the project, searched the whole corpus, and read a document
# the user was not looking at. So the escape is now conditional and last, and
# reading the open document is an instruction rather than an inference.
def focus_note(name: str, refs: str = 'a bare reference') -> str:
    """What to add to the prompt when the user has one document open.

    ``refs`` is how the app writes a reference to a place in a document. That
    is the app's own grammar and not this file's, and the apps do not agree on
    it, so the app states it. One app's shape was hardcoded here, in a file
    whose whole point is to name no app.
    """
    name = escape_name(name)
    return (f'The user has "{name}" open and is asking about what is in front of them. Unless they '
            f'name another document, this question is about "{name}": read it first, and take '
            f'{refs} as a place in it. Look at other documents only when the question is '
            f'explicitly about the corpus as a whole or asks you to compare.')
