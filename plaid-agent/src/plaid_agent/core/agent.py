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
import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import litellm
from plaid_client.workflows.llm import RETRIES, RETRY_BASE_S, TIMEOUT_RETRIES

from .trace import Tracer, summarize_steps, trace_step

try:  # litellm raises the openai SDK's exception classes, its own included
    from openai import APITimeoutError as _ProviderTimeout, OpenAIError as _ProviderError
except ImportError:  # pragma: no cover - litellm depends on openai
    _ProviderTimeout = _ProviderError = ()

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
    """
    try:
        resp = litellm.completion(**{**_provider_kwargs(cfg), 'timeout': timeout},
                                  max_tokens=PING_MAX_TOKENS,
                                  messages=[{'role': 'user', 'content': 'ping'}])
    except litellm.Timeout as e:
        raise ModelTooSlow(str(e)) from e
    if not getattr(resp, 'choices', None):
        raise RuntimeError('the provider answered without a completion')


def _transient_errors() -> tuple:
    """The provider failures that pass: a rate limit, a provider briefly
    down or unreachable. The same list the model services retry."""
    return tuple(e for e in (getattr(litellm, n, None) for n in
                             ('RateLimitError', 'ServiceUnavailableError', 'InternalServerError',
                              'APIConnectionError'))
                 if isinstance(e, type) and issubclass(e, Exception))


def _complete(cfg: ModelConfig, kwargs: Dict[str, Any], on_text: Callable[[str], None],
              cancelled: Callable[[], bool] = lambda: False):
    """One model call, tried again the way the model services try theirs.

    A call that passes the operator's deadline is tried :data:`TIMEOUT_RETRIES`
    more times and no more: a model that did not answer in the whole window is
    down or stuck, and every try costs the reader another window. A rate limit
    or a provider briefly down is tried up to :data:`RETRIES` more times after
    a jittered wait. ``cancelled`` is read while the call waits, before every
    retry and during the wait, and a stop ends the call with
    :class:`TurnCancelled`."""
    transient = _transient_errors()
    attempt = timeouts = 0
    while True:
        try:
            return _watched(cfg, kwargs, on_text, cancelled)
        except Exception as e:
            if _ProviderTimeout and isinstance(e, _ProviderTimeout):
                timeouts += 1
                if timeouts > TIMEOUT_RETRIES:
                    raise
                delay = 0.0
                print(f'{cfg.model} did not answer within {cfg.timeout:g} seconds; trying once more'
                      if cfg.timeout else f'{cfg.model} did not answer in time; trying once more')
            elif transient and isinstance(e, transient):
                if attempt >= RETRIES:
                    raise
                delay = random.uniform(0, RETRY_BASE_S * (2 ** attempt))
                attempt += 1
                # The operator's log, never the reader's.
                print(f'{cfg.model} failed ({" ".join(str(e).split())[:200]}); '
                      f'retrying in {delay:.1f}s ({attempt} of {RETRIES})')
            else:
                raise
        end = time.monotonic() + delay
        while True:
            if cancelled():
                raise TurnCancelled()
            left = end - time.monotonic()
            if left <= 0:
                break
            time.sleep(min(0.5, left))
        on_text('')


#: How often a waiting model call looks for a stop, in seconds.
STOP_POLL_S = 0.5


def _watched(cfg: ModelConfig, kwargs: Dict[str, Any], on_text: Callable[[str], None],
             cancelled: Callable[[], bool]):
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

    def work():
        try:
            box['value'] = _complete_once(cfg, kwargs, text, abandoned)
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
                   abandoned: Optional[threading.Event] = None):
    """One model call. Streamed when configured: the text so far goes to
    ``on_text`` at intervals and the full response is rebuilt from the
    chunks at the end (tool calls included), so the caller reads it as it
    would an unstreamed one. A provider that refuses to stream (an error
    before the first chunk) is asked again without streaming. Once
    ``abandoned`` is set a stream is closed at its next chunk."""
    if not cfg.stream:
        return litellm.completion(**kwargs)
    chunks: List[Any] = []
    text = ''
    last = 0.0
    try:
        stream = litellm.completion(**kwargs, stream=True)
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
            if piece:
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
        if chunks or (_ProviderTimeout and isinstance(e, _ProviderTimeout)) \
                or isinstance(e, _transient_errors()):
            raise
        # A call abandoned at a stop asks nothing more of the provider.
        if abandoned is not None and abandoned.is_set():
            raise TurnCancelled() from e
        return litellm.completion(**kwargs)
    if text:
        on_text(text)
    return litellm.stream_chunk_builder(chunks, messages=kwargs.get('messages'))


def planned_progress(n: int) -> str:
    return f'Planned {n} change{"s" if n != 1 else ""}…'


def _message_to_dict(msg) -> Dict[str, Any]:
    """A litellm Message -> the plain dict shape we keep in the transcript."""
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
        d: Dict[str, Any] = {'role': role, 'content': m.get('content')}
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


def model_failure_line(e: BaseException, timeout: Optional[float] = None) -> Optional[str]:
    """One plain line for a failure of the model provider, or None when the
    failure is not the provider's.

    A provider's own error text is never shown: it names the library and the
    upstream ("litellm.InternalServerError: OpenAIException - ...") and can
    quote the request, the endpoint or the key it refused. The operator's log
    has the whole of it. ``timeout`` is the operator's deadline, named in the
    line the way the model services name it."""
    if _ProviderTimeout and isinstance(e, _ProviderTimeout):
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

    A streamed call's usage is usually litellm's own reconstruction from the
    chunks rather than the provider's count (that needs `stream_options`, which
    not every provider accepts), so treat it as close and not exact. For "how
    full is this thread" that is entirely adequate, and it is the reason nothing
    here is presented to the reader as a precise figure.
    """
    u = getattr(resp, 'usage', None)
    if u is None:
        return None
    sent = getattr(u, 'prompt_tokens', None)
    received = getattr(u, 'completion_tokens', None)
    if not isinstance(sent, int):
        return None
    return {'sent': sent, 'received': received if isinstance(received, int) else 0}


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
    # only grows as its tool results pile up.
    usage: Optional[Dict[str, int]] = None

    @property
    def summary(self) -> str:
        return summarize_steps(self.steps)


def run_turn(cfg: ModelConfig, kit: Toolkit, ws: Any, system: str, transcript: List[Dict[str, Any]],
             on_progress: Callable[[int, str], None] = lambda p, m: None,
             cancelled: Callable[[], bool] = lambda: False,
             on_text: Callable[[str], None] = lambda t: None) -> TurnResult:
    """Run one turn: model call, tool calls, repeat, final text. ``cancelled``
    is polled before every tool call and while a model call waits; once it answers
    True the turn ends with :class:`TurnCancelled`. ``on_text`` receives the
    text of the reply being written, whole each time, as it grows (and ''
    when a new model call starts)."""
    history = _clean_transcript(transcript)
    new: List[Dict[str, Any]] = []
    trace: List[Dict[str, Any]] = []
    rounds = 0
    # The call that last failed and how many times running, as (name, raw
    # arguments). Only an IDENTICAL repeat counts: a model that changes its
    # arguments after a refusal is trying something else.
    failing: Dict[str, Any] = {'call': None, 'times': 0}
    # The last call's usage, whichever call turns out to be last. A turn's
    # prompt only grows as its tool results accumulate, so the last call is the
    # most the thread has ever sent, which is the figure that answers whether
    # another turn will fit.
    spent: Dict[str, Any] = {'usage': None}

    def ask_for_the_reply(kwargs: Dict[str, Any], nudge: str) -> str:
        """One more call, without tools, when the model owes the user words."""
        kwargs = {**kwargs, 'messages': [{'role': 'system', 'content': system}] + history + new
                  + [{'role': 'user', 'content': nudge}]}
        kwargs.pop('tools', None)
        kwargs.pop('tool_choice', None)
        on_text('')
        resp = _complete(cfg, kwargs, on_text, cancelled)
        spent['usage'] = usage_of(resp) or spent['usage']
        choice = resp.choices[0]
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
        return text + _length_note(choice)

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
        on_text('')
        resp = _complete(cfg, kwargs, on_text, cancelled)
        spent['usage'] = usage_of(resp) or spent['usage']
        choice = resp.choices[0]
        d = _message_to_dict(choice.message)
        new.append(d)
        calls = d.get('tool_calls') or []
        if not calls:
            text = (d.get('content') or '').strip()
            if not text:
                # Some models end a tool-heavy turn with an empty message (or
                # reasoning only). Ask once, without tools, for the reply.
                new.pop()
                text = ask_for_the_reply(kwargs, '(system) Your last message was empty. '
                                                 'Reply now with your answer to the user.')
            else:
                text += _length_note(choice)
            return TurnResult(text, new, trace, spent['usage'])
        rounds += 1
        for c in calls:
            if cancelled():
                raise TurnCancelled()
            name = c['function']['name']
            raw = c['function']['arguments'] or '{}'
            planned = 0
            try:
                args = json.loads(raw)
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError as e:
                args, result = {}, f'Error: arguments were not valid JSON ({e})'
            else:
                on_progress(min(85, 8 + rounds * 5), kit.tracer.progress(name, args))
                planned_before = len(ws.ops)
                result = kit.call_tool(ws, name, args)
                planned = len(ws.ops) - planned_before
                if planned:
                    on_progress(min(85, 8 + rounds * 5), planned_progress(len(ws.ops)))
            failed = str(result).startswith('Error')
            trace.append(trace_step(kit.tracer, c['id'], name, args, failed=failed, planned=planned))
            new.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
            if failed and failing['call'] == (name, raw):
                failing['times'] += 1
            else:
                failing['call'], failing['times'] = ((name, raw), 1) if failed else (None, 0)
        if failing['times'] >= REPEATED_FAILURES:
            text = ask_for_the_reply(kwargs, '(system) The same tool call has failed '
                                             f'{REPEATED_FAILURES} times in a row. Do not call it again. '
                                             'Reply now with what you found and what remains to do.')
            return TurnResult(text + f'\n\n*(Stopped after the same step failed {REPEATED_FAILURES} times.)*',
                              new, trace, spent['usage'])
        if rounds >= cfg.max_steps:
            text = ask_for_the_reply(kwargs, '(system) You have used the tool budget for this turn. '
                                             'Reply now with what you found and what remains to do.')
            # The limit counts model calls, not steps (one call may take
            # several), so the line gives no number the trace would contradict.
            # Raising it is the operator's `--max-steps`, which is not named to
            # the reader.
            return TurnResult(text + '\n\n*(Stopped at the step limit.)*',
                              new, trace, spent['usage'])
