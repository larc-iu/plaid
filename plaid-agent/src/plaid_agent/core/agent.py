"""The model loop: one chat turn = model call, tool calls, repeat, final text.

Provider-agnostic through litellm: ``model`` is any litellm model string
(``openai/gpt-4o``, ``anthropic/claude-...``, ``ollama/llama3``, an
OpenAI-compatible server via ``--api-base``), keys come from the usual
environment variables or ``--api-key``.

The transcript is plain OpenAI-shaped message dicts (system message excluded)
so the browser can hold it between turns and send it back. Tool calls and
results stay in it, which is what lets a later turn build on what an earlier
one read without re-reading.
"""

import json
import threading
from types import SimpleNamespace
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import litellm
# What passes, what a timeout is and how a call is tried again are the model
# services' own (one loop for every caller of a model). RETRIES and
# TIMEOUT_RETRIES are imported for the docstrings and tests that name them.
from plaid_client import ServiceCancelled
from plaid_client.workflows.llm import RETRIES, TIMEOUT_RETRIES, is_timeout, retrying, transient_errors  # noqa: F401

from .bidi import for_model
from .filetools import vouches
from .rounds import call_record, new_round
from .trace import META_TOOLS, PLAN, Tracer, summarize_steps, trace_step

try:  # litellm raises the openai SDK's exception classes, its own included
    from openai import OpenAIError as _ProviderError
except ImportError:  # pragma: no cover - litellm depends on openai
    _ProviderError = ()

litellm.drop_params = True  # providers that lack a param get it dropped, not an error


@dataclass(frozen=True)
class Toolkit:
    """What an app lends the loop: its tools, and its words for them.

    ``tools_for(ws)`` returns the tool schemas a turn on that workspace may
    call, ``call_tool(ws, name, args)`` runs one and returns text for the
    model (every failure included, so a bad call is something the model can
    read and recover from rather than an exception up here).

    The WORKSPACE itself is the app's, and the loop asks it only one thing:
    ``ws.ops``, the changes planned so far, so progress can say when a step
    added one.
    """
    tools_for: Callable[[Any], List[Dict[str, Any]]]
    call_tool: Callable[[Any, str, Dict[str, Any]], str]
    tracer: Tracer


@dataclass
class ModelConfig:
    model: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    max_steps: int = 50
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    # Seconds one model call may take before it is abandoned (the operator's
    # --timeout, the same flag and default as the model services), None for
    # the provider's own default, which for litellm is 6000 s: long enough for
    # a request to a dead endpoint to hold a turn for over an hour.
    timeout: Optional[float] = None
    # Stream the model's text as it is written (progress events carry the
    # text so far). Off for a provider that misbehaves under streaming.
    stream: bool = True
    # How many tokens the model can be sent, as the operator stated it
    # (--context-window). None asks the model library, which knows many
    # models by name and nothing about one behind a proxy.
    context_window: Optional[int] = None

    def describe(self) -> Dict[str, Any]:
        """Which model answers. The base URL stays out, as it does from the
        model services' ``describe()``: an internal endpoint is the operator's
        business, not the reader's."""
        return {'model': self.model}


PING_TIMEOUT_S = 30
# The ping's own token budget. A REASONING model spends its first tokens
# thinking, so a small budget comes back with finish_reason 'length' and no
# content at all: the ping then proves only that the provider answers, not
# that it can finish a sentence. Measured on the word "ping": gpt-oss-120b
# answers at 8 and up, glm-5.2 spends 191 tokens thinking about it and
# returns nothing until 256.
#
# An answer with no content is still accepted, because no budget is proof
# against a model that thinks for longer. This one is only large enough that
# an ordinary one gets a word out.
PING_MAX_TOKENS = 256


class ModelTooSlow(Exception):
    """The provider did not answer the startup ping inside PING_TIMEOUT_S.

    Kept apart from every other failure because it says nothing about the
    configuration: a model the operator has to wait for is not a model the
    operator has typed wrong."""
# How often the text so far is sent while the model writes. Every send is a
# request to the Plaid server that relays it to whoever is watching.
STREAM_INTERVAL_S = 0.15


def _provider_kwargs(cfg: ModelConfig) -> Dict[str, Any]:
    """What every call to this model needs: the model string, and the base and
    key when the operator gave them (else litellm reads the provider's env)."""
    # The retries are :func:`_complete`'s alone, as they are the model
    # services' (plaid_client.workflows.llm). The OpenAI SDK under litellm
    # otherwise retries a timeout, a rate limit and a server error on its own,
    # unseen by the loop, so a deadline did not say how long a call could take.
    out: Dict[str, Any] = {'model': cfg.model, 'max_retries': 0}
    if cfg.timeout:
        out['timeout'] = cfg.timeout
    if cfg.api_base:
        out['api_base'] = cfg.api_base
    if cfg.api_key:
        out['api_key'] = cfg.api_key
    return out


def ping_model(cfg: ModelConfig, timeout: float = PING_TIMEOUT_S) -> None:
    """One tiny completion, before the service registers on any project.

    A typo in --model, a missing provider key, an --api-base pointing at
    nothing: each of them looks the same to a user, as a chat that fails on
    every question. The operator is watching at startup and is not watching
    then, so ask the model one question here and let the provider's own
    complaint reach the operator. Raises whatever litellm raises, except a
    timeout, which becomes :class:`ModelTooSlow` so the caller can tell a
    provider that is slow from one that is misconfigured.

    A rate limit or a provider briefly down is tried again as a turn's call
    is (:func:`_complete`), up to :data:`RETRIES` more times after a jittered
    wait: the call sends ``max_retries=0``, so without this one 429 or 503
    while the assistant starts would stop it.
    """
    try:
        resp = retrying(lambda: litellm.completion(**{**_provider_kwargs(cfg), 'timeout': timeout},
                                                   max_tokens=PING_MAX_TOKENS,
                                                   messages=[{'role': 'user', 'content': 'ping'}]),
                        model=cfg.model, timeout=timeout, timeout_retries=0, litellm=litellm)
    except Exception as e:
        if is_timeout(e, litellm):
            raise ModelTooSlow(str(e)) from e
        raise
    if not getattr(resp, 'choices', None):
        raise RuntimeError('the provider answered without a completion')


def _complete(cfg: ModelConfig, kwargs: Dict[str, Any], on_text: Callable[[str], None],
              cancelled: Callable[[], bool] = lambda: False,
              on_thinking: Callable[[str], None] = lambda t: None):
    """One model call, tried again as the model services try theirs
    (``plaid_client.workflows.llm.retrying``).

    A call that passes the operator's deadline is tried :data:`TIMEOUT_RETRIES`
    more times and no more: a model that did not answer in the whole window is
    down or stuck, and every try costs the reader another window. A rate limit
    or a provider briefly down is tried up to :data:`RETRIES` more times after
    a jittered wait. ``cancelled`` is read while the call waits, before every
    retry and during the wait, and a stop ends the call with
    :class:`TurnCancelled`. ``on_thinking`` receives the reasoning the
    provider streams beside the text (``reasoning_content``), as ``on_text``
    receives the text."""
    def wait(delay: float) -> None:
        end = time.monotonic() + delay
        while True:
            if cancelled():
                raise TurnCancelled()
            left = end - time.monotonic()
            if left <= 0:
                return
            time.sleep(min(0.5, left))

    def again() -> None:
        on_text('')
        on_thinking('')

    return retrying(lambda: _watched(cfg, kwargs, on_text, cancelled, on_thinking), model=cfg.model,
                    timeout=cfg.timeout, sleep=wait, on_retry=again, litellm=litellm)


#: How often a waiting model call looks for a stop, in seconds.
STOP_POLL_S = 0.5


def _watched(cfg: ModelConfig, kwargs: Dict[str, Any], on_text: Callable[[str], None],
             cancelled: Callable[[], bool], on_thinking: Callable[[str], None] = lambda t: None):
    """One model call on a worker thread, so a stop is seen while the model
    is silent, as the model services see it (``plaid_client.workflows.llm``).
    Without this a stop waited for the call to end, up to two deadlines.

    litellm offers no way to interrupt a request in flight, so a stopped call
    is left to finish or time out on its own and its answer is dropped. A
    streamed one stops reading at its next chunk, and nothing it writes after
    the stop reaches ``on_text``."""
    if cancelled():
        raise TurnCancelled()
    abandoned = threading.Event()
    done = threading.Event()
    gate = threading.Lock()
    box: Dict[str, Any] = {}

    def text(t: str) -> None:
        with gate:
            if not abandoned.is_set():
                on_text(t)

    def thinking(t: str) -> None:
        with gate:
            if not abandoned.is_set():
                on_thinking(t)

    def work():
        try:
            box['value'] = _complete_once(cfg, kwargs, text, abandoned, thinking)
        except BaseException as e:  # handed to the waiting thread as is
            box['error'] = e
        finally:
            done.set()

    threading.Thread(target=work, name='model-call', daemon=True).start()
    while not done.wait(STOP_POLL_S):
        if cancelled():
            with gate:
                abandoned.set()
            raise TurnCancelled()
    if 'error' in box:
        raise box['error']
    return box['value']


def _complete_once(cfg: ModelConfig, kwargs: Dict[str, Any], on_text: Callable[[str], None],
                   abandoned: Optional[threading.Event] = None,
                   on_thinking: Callable[[str], None] = lambda t: None):
    """One model call. Streamed when configured: the text so far goes to
    ``on_text`` at intervals and the full response is rebuilt from the
    chunks at the end (tool calls included), so the caller reads it as it
    would an unstreamed one. A provider that refuses to stream (an error
    before the first chunk) is asked again without streaming. Once
    ``abandoned`` is set a stream is closed at its next chunk.

    litellm's chunk builder joins the content pieces as they came, so two
    text runs with a tool call or a reasoning block between them would read
    as one ("segment those?Here's what I found"). The text is kept here
    instead, with a blank line at such a seam unless it already breaks.

    The reasoning a provider streams (``reasoning_content``) goes to
    ``on_thinking`` the same way, and is put on the message whole at the end,
    whichever builder put the reply together."""
    if not cfg.stream:
        return litellm.completion(**kwargs)
    chunks: List[Any] = []
    text = ''
    thought = ''
    seam = False  # a tool call or reasoning came after the last text piece
    last = 0.0
    last_thought = 0.0
    try:
        # The provider's own count of what it sent, the thinking included, in
        # its last chunk. A provider that has no such option has it dropped
        # (``litellm.drop_params``), not refused.
        stream = litellm.completion(**kwargs, stream=True, stream_options={'include_usage': True})
        if hasattr(stream, 'choices'):
            return stream  # a whole response (a test double, a provider that ignored stream=)
        for chunk in stream:
            if abandoned is not None and abandoned.is_set():
                close = getattr(stream, 'close', None)
                if callable(close):
                    close()
                raise TurnCancelled()
            chunks.append(chunk)
            choices = getattr(chunk, 'choices', None) or []
            delta = getattr(choices[0], 'delta', None) if choices else None
            piece = getattr(delta, 'content', None) if delta is not None else None
            if delta is not None and any(getattr(delta, k, None) for k in _NOT_TEXT_DELTAS):
                seam = True
            reasoning = getattr(delta, 'reasoning_content', None) if delta is not None else None
            if isinstance(reasoning, str) and reasoning:
                thought += reasoning
                now = time.monotonic()
                if now - last_thought >= STREAM_INTERVAL_S:
                    last_thought = now
                    on_thinking(thought)
            if piece:
                if seam and text and not text[-1].isspace() and not piece[0].isspace():
                    text += '\n\n'
                seam = False
                text += piece
                now = time.monotonic()
                if now - last >= STREAM_INTERVAL_S:
                    last = now
                    on_text(text)
    except TurnCancelled:
        raise
    except Exception as e:
        # A timeout, a rate limit or a provider that is down is not a provider
        # that refuses to stream: asking again at once without streaming would
        # only fail the same way, and :func:`_complete` decides about retries.
        if chunks or is_timeout(e, litellm) or isinstance(e, transient_errors(litellm)):
            raise
        # A call abandoned at a stop asks nothing more of the provider.
        if abandoned is not None and abandoned.is_set():
            raise TurnCancelled() from e
        return litellm.completion(**kwargs)
    if thought:
        on_thinking(thought)
    if text:
        on_text(text)
    # litellm's builder, for a model litellm knows. For one it does not (a
    # model the operator serves), each of its lookups printed litellm's
    # "Provider List" help text into the service log on every reply, so the
    # reply is put together here.
    model = str(next((getattr(c, 'model', '') for c in chunks if getattr(c, 'model', '')), '')
                or kwargs.get('model') or '')
    priced = getattr(litellm, 'model_cost', None) or {}
    if model in priced or model.split('/')[-1] in priced:
        resp = litellm.stream_chunk_builder(chunks, messages=kwargs.get('messages'))
    else:
        resp = _assembled(chunks)
    choices = getattr(resp, 'choices', None) or []
    msg = getattr(choices[0], 'message', None) if choices else None
    if text and msg is not None:
        msg.content = text
    if thought and msg is not None:
        msg.reasoning_content = thought
    return resp


def _assembled(chunks: List[Any]):
    """A streamed reply put together from its chunks, as litellm's builder
    would for the fields this module reads: the text, the tool calls (their
    pieces joined by index), the reasoning, the finish reason, and the usage
    the provider's last chunk carried."""
    text: List[str] = []
    reasoning: List[str] = []
    calls: Dict[int, Dict[str, Any]] = {}
    finish = None
    usage = None
    for chunk in chunks:
        usage = getattr(chunk, 'usage', None) or usage
        for choice in getattr(chunk, 'choices', None) or []:
            delta = getattr(choice, 'delta', None)
            if getattr(choice, 'finish_reason', None):
                finish = choice.finish_reason
            if delta is None:
                continue
            if getattr(delta, 'content', None):
                text.append(delta.content)
            if getattr(delta, 'reasoning_content', None):
                reasoning.append(delta.reasoning_content)
            for i, tc in enumerate(getattr(delta, 'tool_calls', None) or []):
                index = getattr(tc, 'index', None)
                call = calls.setdefault(index if index is not None else i,
                                        {'id': None, 'name': '', 'arguments': ''})
                call['id'] = getattr(tc, 'id', None) or call['id']
                fn = getattr(tc, 'function', None)
                if fn is not None:
                    call['name'] += getattr(fn, 'name', None) or ''
                    call['arguments'] += getattr(fn, 'arguments', None) or ''
    tool_calls = [SimpleNamespace(id=c['id'], type='function',
                                  function=SimpleNamespace(name=c['name'], arguments=c['arguments']))
                  for _i, c in sorted(calls.items())] or None
    message = SimpleNamespace(role='assistant', content=''.join(text) or None, tool_calls=tool_calls,
                              reasoning_content=''.join(reasoning) or None)
    return SimpleNamespace(choices=[SimpleNamespace(index=0, message=message,
                                                    finish_reason=finish or ('tool_calls' if tool_calls else 'stop'))],
                           usage=usage)


# Delta fields that are not the reply's text. Text on either side of one is
# two runs, not one.
_NOT_TEXT_DELTAS = ('tool_calls', 'function_call', 'reasoning_content', 'thinking_blocks')


def _thinking_of(msg) -> Optional[str]:
    """The reasoning a provider returned beside the reply
    (``reasoning_content``), or None when it returned none. Kept in the round
    for the reader, never in the transcript the model is sent."""
    t = getattr(msg, 'reasoning_content', None)
    return t.strip() or None if isinstance(t, str) else None


def _joined(*parts: Optional[str]) -> Optional[str]:
    return '\n\n'.join(p for p in parts if p) or None


def planned_progress(n: int) -> str:
    return f'Planned {n} change{"s" if n != 1 else ""}…'


def _message_to_dict(msg) -> Dict[str, Any]:
    """A litellm Message -> the plain dict shape we keep in the transcript.
    The reasoning is never part of it: it is not sent back to the model
    (:func:`_thinking_of` reads it for the round)."""
    out: Dict[str, Any] = {'role': 'assistant', 'content': msg.content if msg.content is not None else None}
    calls = getattr(msg, 'tool_calls', None) or []
    if calls:
        out['tool_calls'] = [{
            'id': c.id, 'type': 'function',
            'function': {'name': c.function.name, 'arguments': c.function.arguments or '{}'},
        } for c in calls]
    return out


def _clean_transcript(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep only what the model API accepts; drop anything the UI may have
    tacked on. Tolerates a transcript that came back through the wire."""
    out = []
    for m in messages or []:
        role = m.get('role')
        if role not in ('user', 'assistant', 'tool'):
            continue
        # A settled plan's note and a tool's answer quote plan lines, read
        # without their isolates (core.bidi).
        content = m.get('content')
        d: Dict[str, Any] = {'role': role, 'content': content if role == 'assistant' else for_model(content)}
        if role == 'assistant' and m.get('tool_calls'):
            d['tool_calls'] = [{'id': c.get('id'), 'type': 'function',
                                'function': {'name': (c.get('function') or {}).get('name'),
                                             'arguments': (c.get('function') or {}).get('arguments') or '{}'}}
                               for c in m['tool_calls']]
        if role == 'tool':
            d['tool_call_id'] = m.get('tool_call_id')
            if d['content'] is None:
                d['content'] = ''
        if role == 'user' and d['content'] is None:
            d['content'] = ''
        out.append(d)
    return out


def _length_note(choice) -> str:
    """A reply the provider cut off at its output limit says so. The flag
    that raises the limit is the operator's (``--max-tokens``), not something
    the reader can act on, so it is not named here."""
    if getattr(choice, 'finish_reason', None) != 'length':
        return ''
    return '\n\n*(The reply was cut off at the model\'s output limit.)*'


class TurnCancelled(Exception):
    """The requester asked for the turn to stop. Raised between steps or while
    a model call waits (never inside a tool), so nothing is left half done: a
    model call writes nothing."""


class TurnFailed(Exception):
    """The turn ended without an answer worth keeping. Its message is written
    for the reader, and the turn is recorded as failed (with Retry), exactly
    as a provider error would be."""


EMPTY_REPLY = 'The model returned an empty reply.'

# How many times in a row the SAME call (same tool, same arguments) may fail
# before the turn stops. A model that repeats a refused call does not learn
# from the refusal, and every further round is a paid request that ends the
# same way.
REPEATED_FAILURES = 3

# What a plan call repeated word for word in one turn answers when it leaves
# the plan as it was: nothing is staged again, and the repeat counts toward
# the guard above. One turn was seen staging the same change seven times,
# each copy superseding the last.
ALREADY_PLANNED = ('Nothing was staged again: the same call earlier in this turn left the plan as it is now. '
                   'Do not repeat it. Plan the next change or reply to the user.')


def _plan_snapshot(ws: Any) -> List[str]:
    """The plan as it stands, to tell whether a call changed it. In any order:
    a change staged again over itself may move to the end of the plan."""
    return sorted(json.dumps(op, sort_keys=True, default=str) for op in getattr(ws, 'ops', None) or [])


def model_failure_line(e: BaseException, timeout: Optional[float] = None) -> Optional[str]:
    """One plain line for a failure of the model provider, or None when the
    failure is not the provider's.

    A provider's own error text is never shown: it names the library and the
    upstream ("litellm.InternalServerError: OpenAIException - ...") and can
    quote the request, the endpoint or the key it refused. The operator's log
    has the whole of it. ``timeout`` is the operator's deadline, named in the
    line the way the model services name it."""
    if is_timeout(e, litellm):
        return f'The model did not answer within {timeout:g} seconds.' if timeout \
            else 'The model did not answer in time.'
    if _ProviderError and isinstance(e, _ProviderError):
        if isinstance(e, getattr(litellm, 'ContextWindowExceededError', ())):
            return 'The conversation is too long for the model.'
        return 'The model could not answer.'
    return None


def usage_of(resp) -> Optional[Dict[str, int]]:
    """``{sent, received}`` for one model call, or None when the provider said
    nothing.

    ``sent`` is the whole prompt: system note, transcript, tool results, tool
    schemas. It is the number that decides whether the next turn fits, which is
    why it is worth keeping.

    A streamed call asks the provider for its own count (`stream_options`),
    which includes a reasoning model's thinking. A provider without that option
    has it dropped, and then a model litellm knows is counted by litellm from
    the chunks, and one it does not is unreported. Treat the figure as close
    and not exact: for "how full is this thread" that is entirely adequate, and
    it is the reason nothing here is presented to the reader as a precise
    figure.
    """
    u = getattr(resp, 'usage', None)
    if u is None:
        return None
    sent = getattr(u, 'prompt_tokens', None)
    received = getattr(u, 'completion_tokens', None)
    if not isinstance(sent, int):
        return None
    return {'sent': sent, 'received': received if isinstance(received, int) else 0}


def token_counter(model: str) -> Callable[[Any], int]:
    """A function giving the tokens a message, a string or any JSON value
    costs this model, by litellm's tokenizer for it (a common one for a model
    it does not know, which is close enough to budget with, never to report)."""
    def count(value: Any) -> int:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return litellm.token_counter(model=model, text=text)
    return count


def context_window(model: str, stated: Optional[int] = None) -> Optional[int]:
    """How much this model can be sent, or None when that is not known.

    An operator can point the assistant at any model litellm can reach,
    including one behind a proxy that litellm has no record of. None means the
    caller must say the count WITHOUT a percentage: a made-up denominator would
    be worse than no denominator, because it reads as a measurement.

    ``stated`` is the operator's own figure (``--context-window``), which wins
    over litellm's: it is a fact about the deployment in front of them, where
    litellm's record is about a model of that name somewhere. Nothing else is
    tried, such as the same model under another provider's name, because that
    would be a guess.
    """
    if stated:
        return stated
    try:
        info = litellm.get_model_info(model) or {}
    except Exception:  # noqa: BLE001 - an unknown model is the normal case, not an error
        return None
    for key in ('max_input_tokens', 'max_tokens'):
        n = info.get(key)
        if isinstance(n, int) and n > 0:
            return n
    return None


@dataclass
class TurnResult:
    """One finished turn: the reply, the messages it appended to the
    transcript, and the trace of what it did (see :mod:`.trace`)."""
    text: str
    messages: List[Dict[str, Any]]
    steps: List[Dict[str, Any]]
    # What the LAST model call of the turn sent and got back, plus the window
    # it was sent into. The last call is the high-water mark: a turn's prompt
    # only grows as its tool results pile up. ``total`` is every call of the
    # turn added up, which is what the turn cost (see `Spend`).
    usage: Optional[Dict[str, Any]] = None
    # The stored round of the model call that wrote the reply, when it holds
    # something the steps' rounds do not (the question as received, on a turn
    # that called no tool, or the reasoning the reply was written with).
    reply_round: Optional[str] = None
    # That round holds the model's reasoning.
    reply_thought: bool = False

    @property
    def summary(self) -> str:
        return summarize_steps(self.steps)


class Spend:
    """What one turn's model calls sent and got back.

    Two figures answer two questions. The LAST call's counts are the most the
    thread has ever sent, since a turn's prompt only grows as its tool results
    accumulate, and that answers whether another turn will fit. The TOTAL over
    every call is what the turn cost: a turn of ten tool calls sends the thread
    ten times, and recording only the last call understated it about tenfold.

    A call whose provider reported nothing adds nothing, and ``total`` then
    says ``partial`` rather than passing an undercount off as the whole.
    """

    def __init__(self):
        self.last: Optional[Dict[str, int]] = None
        self.sent = 0
        self.received = 0
        self.calls = 0
        self.unreported = 0

    def add(self, resp) -> None:
        u = usage_of(resp)
        if u is None:
            self.unreported += 1
            return
        self.last = u
        self.sent += u['sent']
        self.received += u['received']
        self.calls += 1

    def usage(self) -> Optional[Dict[str, Any]]:
        if self.last is None:
            return None
        total: Dict[str, Any] = {'sent': self.sent, 'received': self.received, 'calls': self.calls}
        if self.unreported:
            total['partial'] = True
        return {**self.last, 'total': total}


def turn_trace(e: BaseException):
    """``(steps, partial)`` of a turn that ended with ``e``: the tool calls it
    made before it failed or was stopped, and the text the model call under
    way had written, as :func:`run_turn` left them on the exception (see
    `conversation.error_item`). Empty for an exception raised anywhere
    else."""
    return list(getattr(e, 'turn_steps', None) or []), getattr(e, 'turn_partial', None) or ''


def run_turn(cfg: ModelConfig, kit: Toolkit, ws: Any, system: str, transcript: List[Dict[str, Any]],
             on_progress: Callable[[int, str], None] = lambda p, m: None,
             cancelled: Callable[[], bool] = lambda: False,
             on_text: Callable[[str], None] = lambda t: None,
             on_thinking: Optional[Callable[[str], None]] = None) -> TurnResult:
    """Run one turn: model call, tool calls, repeat, final text. ``cancelled``
    is polled before every tool call and while a model call waits; once it answers
    True the turn ends with :class:`TurnCancelled`. ``on_text`` receives the
    text of the reply being written, whole each time, as it grows (and ''
    when a new model call starts). ``on_thinking`` receives the reasoning of
    the model call under way the same way (by default the round keeper's
    `RoundKeeper.think`). The reasoning is stored in the call's round
    (``thinking``) and never sent back to the model.

    Each model call is a ROUND (core/rounds.py): when ``ws.rounds`` is set
    (the service's `RoundKeeper`), each round is stored once its tool calls
    have run and before the next model call, and the steps name it.

    A turn that ends with an exception (failed, or stopped) carries the tool
    calls it made on it, for the record (:func:`turn_trace`), and stores the
    round under way when it made any. A stop seen by the client's own
    checkpoint (a progress line sent from inside a tool raises
    :class:`ServiceCancelled`, which is not an ``Exception``) carries them
    too."""
    trace: List[Dict[str, Any]] = []
    live: Dict[str, Any] = {'round': None, 'text': ''}
    keeper = getattr(ws, 'rounds', None)
    if keeper is not None:
        keeper.follow(trace)
    if on_thinking is None:
        on_thinking = keeper.think if keeper is not None else (lambda t: None)
    try:
        return _run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text, trace, live, keeper,
                         on_thinking)
    except (Exception, ServiceCancelled) as e:
        rnd = live['round']
        if keeper is not None and rnd is not None and rnd['calls'] and not keeper.store(rnd):
            _unstored(trace, rnd)
        # The text of the call under way, or of a call whose tools never ran.
        partial = live['text'] or (rnd.get('said', '') if rnd is not None and not rnd['calls'] else '')
        try:
            e.turn_steps, e.turn_partial = trace, partial
        except AttributeError:  # an exception type that takes no attributes keeps none
            pass
        raise


def _unstored(trace: List[Dict[str, Any]], rnd: Dict[str, Any]) -> None:
    """The steps of a round the store would not take, which the panel draws
    unopenable."""
    for s in trace:
        if s.get('round') == rnd['id']:
            s['unstored'] = True


def _asked(history: List[Dict[str, Any]]) -> Optional[str]:
    """The question as the model received it: the last user message of the
    transcript it was sent."""
    for m in reversed(history):
        if m.get('role') == 'user':
            return m.get('content') if isinstance(m.get('content'), str) else json.dumps(m.get('content'))
    return None


def _run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text,
              trace: List[Dict[str, Any]], live: Dict[str, Any], keeper,
              on_thinking: Callable[[str], None] = lambda t: None) -> TurnResult:
    history = _clean_transcript(transcript)
    new: List[Dict[str, Any]] = []
    rounds = 0
    asked = _asked(history)

    def text_seen(t: str) -> None:
        # What the model call under way has written, kept for a turn that
        # ends before the call returns (`turn_partial`).
        live['text'] = t
        on_text(t)
    # The call that last failed (or was a plan call repeated to no effect)
    # and how many times running, as (name, arguments). Only an IDENTICAL
    # repeat counts: a model that changes its arguments after a refusal is
    # trying something else.
    failing: Dict[str, Any] = {'call': None, 'times': 0, 'repeated': False}
    # The plan calls this turn has made that went through, by (name,
    # arguments), so the same one again can be told apart.
    made: set = set()
    spend = Spend()

    def ask_for_the_reply(kwargs: Dict[str, Any], nudge: str):
        """One more call, without tools, when the model owes the user words.
        ``(text, reasoning)``."""
        kwargs = {**kwargs, 'messages': [{'role': 'system', 'content': system}] + history + new
                  + [{'role': 'user', 'content': nudge}]}
        kwargs.pop('tools', None)
        kwargs.pop('tool_choice', None)
        text_seen('')
        on_thinking('')
        resp = _complete(cfg, kwargs, text_seen, cancelled, on_thinking)
        spend.add(resp)
        choice = resp.choices[0]
        thinking = _thinking_of(choice.message)
        d = _message_to_dict(choice.message)
        d.pop('tool_calls', None)
        new.append(d)  # the nudge itself never enters the saved transcript
        text = (d.get('content') or '').strip()
        if not text:
            if not getattr(ws, 'ops', None):
                # Asked twice and nothing came back, and nothing was planned:
                # a failed turn, which the reader can retry, not an answer.
                raise TurnFailed(EMPTY_REPLY)
            # The plan is the substance of this turn and the card shows it,
            # so keep it rather than throw it away with the missing words.
            text = f'({EMPTY_REPLY})'
        return text + _length_note(choice), thinking

    def reply_round_of(n: int, thinking: Optional[str], asked_here: Optional[str] = None):
        """The reply's own round, stored when it holds something the steps'
        rounds do not: the question as received (a turn that called no tool)
        or the reasoning. ``(round id, holds reasoning)``, or ``(None,
        False)`` when there is nothing to store or it was not stored."""
        if keeper is None or (asked_here is None and not thinking):
            return None, False
        rnd = new_round(n, cfg.model, asked_here)
        if thinking:
            rnd['thinking'] = thinking
        if not keeper.store(rnd):
            return None, False
        return rnd['id'], bool(thinking)

    while True:
        if cancelled():
            raise TurnCancelled()
        on_progress(min(85, 8 + rounds * 5), 'Thinking…' if rounds == 0 else 'Thinking more…')
        kwargs: Dict[str, Any] = dict(**_provider_kwargs(cfg), tools=kit.tools_for(ws), tool_choice='auto',
                                      messages=[{'role': 'system', 'content': system}] + history + new)
        if cfg.temperature is not None:
            kwargs['temperature'] = cfg.temperature
        if cfg.max_tokens:
            kwargs['max_tokens'] = cfg.max_tokens
        text_seen('')
        on_thinking('')
        resp = _complete(cfg, kwargs, text_seen, cancelled, on_thinking)
        spend.add(resp)
        choice = resp.choices[0]
        thinking = _thinking_of(choice.message)
        d = _message_to_dict(choice.message)
        new.append(d)
        calls = d.get('tool_calls') or []
        rnd = new_round(rounds + 1, cfg.model, asked if rounds == 0 else None)
        if thinking:
            rnd['thinking'] = thinking
        if not calls:
            text = (d.get('content') or '').strip()
            if not text:
                # Some models end a tool-heavy turn with an empty message (or
                # reasoning only). Ask once, without tools, for the reply.
                new.pop()
                text, more = ask_for_the_reply(kwargs, '(system) Your last message was empty. '
                                                       'Reply now with your answer to the user.')
                thinking = _joined(thinking, more)
            else:
                text += _length_note(choice)
            # The reply's own round holds something only on a turn that
            # called no tool (the question as received) or when the model
            # reasoned. Its text is the reply.
            reply_round, thought = reply_round_of(rounds + 1, thinking, asked if rounds == 0 else None)
            return TurnResult(text, new, trace, spend.usage(), reply_round, thought)
        # The text written beside the calls is the round's, and goes on its
        # first step: it is no longer the call under way's.
        said = (d.get('content') or '').strip()
        if said:
            rnd['said'] = said
        live['round'], live['text'] = rnd, ''
        rounds += 1
        for c in calls:
            if cancelled():
                raise TurnCancelled()
            name = c['function']['name']
            raw = c['function']['arguments'] or '{}'
            planned = 0
            saved_before = len(getattr(getattr(ws, 'keeper', None), 'saved', None) or ())
            key = (name, raw)
            repeated = False
            saw = None
            try:
                args = json.loads(raw)
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError as e:
                args, result = {}, f'Error: arguments were not valid JSON ({e})'
            else:
                key = (name, json.dumps(args, sort_keys=True, default=str))
                plan_call = kit.tracer.kind(name) == PLAN and name not in META_TOOLS
                before = _plan_snapshot(ws) if plan_call and key in made else None
                on_progress(min(85, 8 + rounds * 5), kit.tracer.progress(name, args))
                planned_before = len(ws.ops)
                # A value typed in a rare script can come out garbled, and is
                # refused before the tool sees it (see core.garble).
                why = ws.garbled(args) if plan_call and hasattr(ws, 'garbled') else None
                # What the call reads is noted here (`BaseWorkspace.note_read`).
                ws.reads = []
                try:
                    result = f'Error: {why}' if why else kit.call_tool(ws, name, args)
                finally:
                    saw, ws.reads = ws.reads, None
                # The lines a plan shows isolate their values (core.bidi). The
                # model reads them plain, so it never copies an isolate.
                result = for_model(result)
                # What the answer holds is text the turn can copy from, less
                # what it only echoes of the call (see core.garble).
                # A read of a file the assistant made is not, and what code read
                # from one is held against what the run printed.
                if getattr(ws, 'seen', None) is not None:
                    withheld = ws.seen.take_made()
                    if vouches(ws, name, args):
                        ws.seen.add(result, unless=args, withheld=withheld)
                planned = len(ws.ops) - planned_before
                if planned:
                    on_progress(min(85, 8 + rounds * 5), planned_progress(len(ws.ops)))
                if plan_call and not str(result).startswith('Error'):
                    made.add(key)
                    if before is not None and _plan_snapshot(ws) == before:
                        result, repeated = ALREADY_PLANNED, True
            failed = str(result).startswith('Error')
            saved = (getattr(getattr(ws, 'keeper', None), 'saved', None) or [])[saved_before:]
            first = not rnd['calls']
            trace.append(trace_step(kit.tracer, c['id'], name, args, failed=failed, planned=planned, saved=saved,
                                    saw=saw, round_id=rnd['id'] if keeper is not None else None,
                                    said=rnd.get('said') if first else None,
                                    thought=first and keeper is not None and bool(rnd.get('thinking'))))
            if keeper is not None and first:
                # The round's text and reasoning are on its first step now,
                # not the call's.
                keeper.text = ''
                keeper.thinking = ''
            new.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
            rnd['calls'].append(call_record(c['id'], name, raw, result))
            if (failed or repeated) and failing['call'] == key and failing['repeated'] == repeated:
                failing['times'] += 1
            else:
                failing.update(call=key if failed or repeated else None, times=1 if failed or repeated else 0,
                               repeated=repeated)
        if keeper is not None and not keeper.store(rnd):
            _unstored(trace, rnd)
        live['round'] = None
        if failing['times'] >= REPEATED_FAILURES:
            what = 'been repeated' if failing['repeated'] else 'failed'
            text, thinking = ask_for_the_reply(kwargs, f'(system) The same tool call has {what} '
                                                       f'{REPEATED_FAILURES} times in a row. Do not call it again. '
                                                       'Reply now with what you found and what remains to do.')
            line = 'was repeated' if failing['repeated'] else 'failed'
            return TurnResult(text + f'\n\n*(Stopped after the same step {line} {REPEATED_FAILURES} times.)*',
                              new, trace, spend.usage(), *reply_round_of(rounds + 1, thinking))
        if rounds >= cfg.max_steps:
            text, thinking = ask_for_the_reply(kwargs, '(system) You have used the tool budget for this turn. '
                                                       'Reply now with what you found and what remains to do.')
            # The limit counts model calls, not steps (one call may take
            # several), so the line gives no number the trace would contradict.
            # Raising it is the operator's `--max-steps`, which is not named to
            # the reader.
            return TurnResult(text + '\n\n*(Stopped at the step limit.)*',
                              new, trace, spend.usage(), *reply_round_of(rounds + 1, thinking))
