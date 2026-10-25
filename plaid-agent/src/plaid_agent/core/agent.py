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
import re
import threading
from types import SimpleNamespace
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional

import litellm
# What passes, what a timeout is and how a call is tried again are the model
# services' own (one loop for every caller of a model). RETRIES and
# TIMEOUT_RETRIES are imported for the docstrings and tests that name them.
from plaid_client import ServiceCancelled
from plaid_client.workflows.llm import RETRIES, TIMEOUT_RETRIES, is_timeout, retrying, transient_errors  # noqa: F401

from .bidi import for_model
from .conversation import DROPPED
from .filetools import vouches
from .limits import cuts
from .rounds import call_record, new_round
from .tools import Refusal, refused
from .plan import held_changes
from .trace import META, META_TOOLS, PLAN, Tracer, again_label, summarize_steps, trace_step

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


#: The most one model call of a turn may write when the operator states no
#: figure (--max-output-tokens), its reasoning included. A model that fell
#: into a loop was seen writing 229,501 tokens in one call, and another
#: filled its whole 262,144-token window, each for over an hour.
DEFAULT_MAX_OUTPUT_TOKENS = 32768


@dataclass
class ModelConfig:
    model: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    max_steps: int = 50
    temperature: Optional[float] = None
    # The most one model call may write, its reasoning included (the
    # operator's --max-output-tokens, else `output_cap`). A call that reaches
    # it ends the turn (`cut_line`): with no cap a model that never stops
    # writing was never stopped, since the deadline counts only silence.
    max_tokens: Optional[int] = DEFAULT_MAX_OUTPUT_TOKENS
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


def output_cap(model: str, stated: Optional[int] = None) -> int:
    """The most one model call may write: the operator's figure, else
    :data:`DEFAULT_MAX_OUTPUT_TOKENS`, or less for a model litellm knows to
    write less, as a provider refuses a request that asks for more than its
    model can write."""
    if stated:
        return stated
    try:
        info = litellm.get_model_info(model) or {}
    except Exception:  # noqa: BLE001 - an unknown model is the normal case, not an error
        info = {}
    most = info.get('max_output_tokens')
    if isinstance(most, int) and 0 < most < DEFAULT_MAX_OUTPUT_TOKENS:
        return most
    return DEFAULT_MAX_OUTPUT_TOKENS


def cut_line(written: Optional[int]) -> str:
    """What the reader is told when a model call reached its output cap."""
    if not written:
        return 'The model wrote without finishing, so this turn was stopped. Ask again, perhaps more narrowly.'
    return (f'The model wrote {written:,} tokens without finishing, so this turn was stopped. '
            'Ask again, perhaps more narrowly.')


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
    stream = None
    try:
        # The provider's own count of what it sent, the thinking included, in
        # its last chunk. A provider that has no such option has it dropped
        # (``litellm.drop_params``), not refused.
        stream = litellm.completion(**kwargs, stream=True, stream_options={'include_usage': True})
        if hasattr(stream, 'choices'):
            return stream  # a whole response (a test double, a provider that ignored stream=)
        for chunk in stream:
            if abandoned is not None and abandoned.is_set():
                _close(stream)
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
                    on_thinking(clean_reasoning(thought) or '')
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
    except ServiceCancelled:
        # A stop the client saw as it sent the text so far (a stop asked for,
        # or a request the server no longer knows): the stream is closed as
        # at a stop seen here, so the provider can stop writing.
        _close(stream)
        raise
    except Exception as e:
        # A timeout, a rate limit or a provider that is down is not a provider
        # that refuses to stream: asking again at once without streaming would
        # only fail the same way, and :func:`_complete` decides about retries.
        if chunks or is_timeout(e, litellm) or isinstance(e, transient_errors(litellm)) or too_long(e):
            raise
        # A call abandoned at a stop asks nothing more of the provider.
        if abandoned is not None and abandoned.is_set():
            raise TurnCancelled() from e
        return litellm.completion(**kwargs)
    if thought:
        on_thinking(clean_reasoning(thought) or '')
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


def _close(stream: Any) -> None:
    close = getattr(stream, 'close', None)
    if callable(close):
        close()


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


_THINK_TAGS = re.compile(r'</?think>')


def clean_reasoning(text: Any) -> Optional[str]:
    """The reasoning as the reader is shown it: without stray ``<think>`` and
    ``</think>`` tags, which some servers send as the reasoning of a call that
    did not reason, and None when nothing else is left."""
    if not isinstance(text, str):
        return None
    return _THINK_TAGS.sub('', text).strip() or None


def _thinking_of(msg) -> Optional[str]:
    """The reasoning a provider returned beside the reply
    (``reasoning_content``), or None when it returned none. Kept in the round
    for the reader, never in the transcript the model is sent."""
    return clean_reasoning(getattr(msg, 'reasoning_content', None))


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


class TurnCancelled(Exception):
    """The requester asked for the turn to stop. Raised between steps or while
    a model call waits (never inside a tool), so nothing is left half done: a
    model call writes nothing."""


class TurnFailed(Exception):
    """The turn ended without an answer worth keeping. Its message is written
    for the reader, and the turn is recorded as failed (with Retry), exactly
    as a provider error would be."""


EMPTY_REPLY = 'The model returned an empty reply.'
#: The reply of a turn whose last call, for the words after a plan, failed:
#: the plan is kept and its card shows it.
NO_ANSWER = 'The model did not answer.'
#: The line added under the reply of a turn that used its step budget.
STEP_LIMIT_STOP = '*(Stopped at the step limit.)*'
#: The line added under the reply of a turn whose same call failed, or was
#: repeated, too many times in a row (``how`` is "failed" or "was repeated").
REPEAT_STOP = '*(Stopped after the same step {how} {times} times.)*'

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


# A reply that says this turn planned changes, when it planned none: the user
# is told to approve a card that does not exist. Seen in every app on a 27B
# model (bench build-q38-1: ten of 35 failed runs). The phrases are the ones
# those replies used. Read sentence by sentence, and an offer ("I'll plan it",
# "say the word") is not a claim that it was done.
_CLAIMED = [re.compile(p, re.I) for p in (
    # "I've staged", "I have planned the change", "I've prepared a plan".
    r"\b(?:i['’]ve|i have|we['’]ve|we have)\s+(?:now\s+|just\s+|also\s+)?(?:staged|planned|prepared|queued)\b",
    # "Here's the staged plan", "Staged plan:".
    r"\bstaged (?:plan|change|changes|edit|edits)\b",
    # "**Plan:**", "**Planned (1 change):**".
    r"\*\*(?:plan|planned|proposed changes?)(?: \(\d+ changes?\))?:\*\*",
    # "approve the pending split".
    r"\b(?:the|a|your) pending (?:plan|split|merge|change|changes|card|edit|edits)\b",
    # "this turn's plan holds just that one change", "this turn holds just that".
    r"\b(?:plan|this turn) holds\b(?! nothing| no\b)",
)]
_APPROVE = re.compile(r"\bapprove (?:it|the|this|that|them|to|and|when|once)\b", re.I)
_OFFER = re.compile(r"\b(?:i['’]ll|i will|i can|i could|i would|i['’]d|shall i|should i|want me|would you like"
                    r"|if you['’]d like|if you want|say the word|let me know|tell me)\b", re.I)
_SENTENCE = re.compile(r"(?<=[.!?:])\s+|\n+")


def claims_a_plan(text: Optional[str]) -> bool:
    """Whether ``text`` tells the user a plan was made: says it staged,
    planned or prepared changes, or tells them to approve (unless the same
    sentence offers to plan, "I'll plan it and you approve it")."""
    for s in _SENTENCE.split(text or ''):
        if any(p.search(s) for p in _CLAIMED) or (_APPROVE.search(s) and not _OFFER.search(s)):
            return True
    return False


# A reply that writes a tool call out as text instead of making it: small
# local models do this often (52 of Gemma's 137 failed bench runs, BENCH-GEMMA),
# as `set_value(...)`, `<plan_change document=...>`, `<action>set_value</action>`
# or a JSON object naming the tool. Only a tool this turn offers counts, and
# only in call syntax, so a reply naming a tool in prose is not one.
def _call_shapes(names: Iterable[str]) -> List[re.Pattern]:
    n = '|'.join(re.escape(x) for x in sorted(set(names), key=len, reverse=True) if x)
    if not n:
        return []
    return [re.compile(p) for p in (
        rf'(?<![\w.])({n})\(',
        rf'<\s*({n})(?=[\s>/])',
        rf'<(?:action|tool|tool_name|function|name)>\s*({n})\s*</',
        rf'"(?:name|tool|tool_name|function|action)"\s*:\s*"({n})"',
        # A JSON object after the name, not a pattern in an app's own query
        # syntax that a reply shows under the tool's name (`search_tool {`
        # then `pattern { ... }`).
        rf'(?m)^[ \t]*`?({n})`?[ \t]*\{{\s*"',
    )]


def _squashed(text: str) -> str:
    # Code shown is often spaced otherwise than it ran (`rows=query(...)`
    # ran, `rows = query(...)` shown), so no whitespace counts (R8A-6).
    return ''.join(text.split())


def written_call(text: Optional[str], names: Iterable[str], ran: Iterable[str] = (),
                 code: Iterable[str] = ()) -> Optional[str]:
    """The tool ``text`` writes out as a call rather than calling it, or None.
    ``names`` are the tools the turn offers.

    A call of a tool in ``ran`` (the tools whose calls went through in this
    conversation, this turn or an earlier one) is the reply restating what
    it did, not a call that did not run. A line of code that ran (``code``,
    the code of the conversation's run_code calls) is shown code, whatever
    its spacing: the sandbox's ``query(q)`` shares the query tool's name."""
    ran = set(ran)
    code = [_squashed(c) for c in code if c]
    text = text or ''
    for p in _call_shapes(names):
        for m in p.finditer(text):
            if m.group(1) in ran:
                continue
            start = text.rfind('\n', 0, m.start()) + 1
            end = text.find('\n', m.start())
            line = _squashed(text[start:end if end >= 0 else len(text)].strip(' \t`'))
            if line and any(line in c for c in code):
                continue
            return m.group(1)
    return None


def run_code_of(messages: Iterable[Dict[str, Any]]) -> List[str]:
    """The code of every run_code call in ``messages``."""
    out = []
    for m in messages:
        for c in m.get('tool_calls') or []:
            f = c.get('function') or {}
            if f.get('name') != 'run_code':
                continue
            try:
                args = json.loads(f.get('arguments') or '{}')
            except (TypeError, ValueError):
                continue
            if isinstance(args, dict) and isinstance(args.get('code'), str):
                out.append(args['code'])
    return out


def went_through(messages: Iterable[Dict[str, Any]]) -> set:
    """The tools whose calls in ``messages`` (a transcript) went through:
    answered, and not with a refusal. The transcript keeps the answer's text
    only, so an answer beginning "Error" counts as refused, and one pruned
    from the record as unknown: such a call is not counted, and a reply that
    writes it out is told it did not run (REV8-AGENT R8A-5)."""
    answered = {m.get('tool_call_id'): m.get('content') for m in messages
                if m.get('role') == 'tool'}
    out = set()
    for m in messages:
        if m.get('role') != 'assistant':
            continue
        for c in m.get('tool_calls') or []:
            text = answered.get(c.get('id'))
            name = (c.get('function') or {}).get('name')
            if name and isinstance(text, str) and text != DROPPED and not text.startswith('Error'):
                out.add(name)
    return out


def written_call_note(name: str) -> str:
    """What a reply that wrote ``name`` out as a call is sent back with, once."""
    return (f'(system) Your reply wrote a {name} call as text, so it did not run: nothing was done. '
            'Call the tool itself now, or reply to the user without the call.')


#: The step that note is in the trace, and its line.
WRITTEN_CALL_STEP = 'written_call'
WRITTEN_CALL_LABEL = 'Told the assistant that a tool call written as text did not run'


#: What a turn that claimed a plan it never made is sent back with, once.
#: The user sees only the reply that follows it, so the note says to repeat
#: what the first one answered and not to narrate the correction: second
#: replies lost the first's count and opened "I've now staged" (bench q38-2).
NOTHING_PLANNED = ('(system) Nothing is planned in this turn: no plan card will show. Make the changes with '
                   'the plan tools now, or tell the user you have not planned them. The user sees only your '
                   'next reply, not the one above, so repeat in it everything the one above answered, and do '
                   'not mention this note or that the changes were staged only now.')
#: The step that note is in the trace, and its line.
NOTHING_PLANNED_STEP = 'nothing_planned'
NOTHING_PLANNED_LABEL = 'Told the assistant that nothing was planned'


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
        if too_long(e):
            return TOO_LONG_LINE
        return 'The model could not answer.'
    return None


#: What the reader is told when a turn does not fit the model even after the
#: older tool results were dropped (`learn_window`, the loop's one retry).
TOO_LONG_LINE = 'This conversation is too long for the model. Start a new conversation.'


def too_long(e: BaseException) -> bool:
    """The provider refused the request as longer than the model takes."""
    return isinstance(e, getattr(litellm, 'ContextWindowExceededError', ()))


# The window a provider's refusal named, per model, for this process: what a
# model behind a server litellm does not know takes, learned the first time a
# request was refused as too long (`learn_window`).
_learned: Dict[str, int] = {}
_learned_lock = threading.Lock()

# How a refusal names the window: llama-server's "the available context size
# (65536 tokens)", OpenAI's and vLLM's "maximum context length is 8192
# tokens", Anthropic's "210000 tokens > 200000 maximum".
_NAMED_WINDOW = (re.compile(r'(?:context (?:size|length|window)|context length)\D{0,30}?(\d[\d,]{2,})', re.I),
                 re.compile(r'>\s*(\d[\d,]{2,})\s*maximum', re.I))

#: The share of what was known (or sent) taken as the window when a refusal
#: names none.
UNNAMED_WINDOW_SHARE = 0.5


def _named_window(text: str) -> Optional[int]:
    for rx in _NAMED_WINDOW:
        m = rx.search(text)
        if m:
            n = int(m.group(1).replace(',', ''))
            if n > 0:
                return n
    return None


def learn_window(model: str, e: BaseException, sent: Optional[int] = None,
                 stated: Optional[int] = None) -> Optional[int]:
    """The window ``model`` takes, learned from a refusal as too long, and
    kept for this process, so the gauge and every later turn hold the
    transcript to it (`context_window`). None when nothing was learned.

    The figure the refusal names is the window. A refusal that names none
    takes a share of the window known before any refusal (``stated``, the
    operator's, or litellm's), and only when ``sent`` (what the refused
    request asked for, its output allowance included, when it could be
    counted) was under it: a refusal of more than the known window says
    nothing new, since the turn's own reads grew past it. With no window
    known nothing is learned. A share of a window learned before is never
    taken, and nothing is learned from what was sent: each unnamed refusal
    would cut the window again, for every conversation of the process, and
    a request refused for another reason (its answer allowance, say) is
    small enough to teach a window no system prompt fits in."""
    n = _named_window(str(e))
    if n is None:
        known = stated or _library_window(model)
        if not known or (sent and sent >= known):
            return None
        n = int(known * UNNAMED_WINDOW_SHARE)
    with _learned_lock:
        was = _learned.get(model)
        _learned[model] = min(was, n) if was else n
        return _learned[model]


def _sent_tokens(model: str, kwargs: Dict[str, Any], max_tokens: Optional[int] = None) -> Optional[int]:
    """What a refused request asked the window for, by the model's
    tokenizer: its messages, its tool schemas and the room it left for the
    answer. None when it cannot be counted."""
    try:
        count = token_counter(model)
        return (count(kwargs.get('messages') or []) + (count(kwargs['tools']) if kwargs.get('tools') else 0)
                + (max_tokens or 0))
    except Exception:  # noqa: BLE001 - a count is a fallback, never a reason to fail the turn
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

    A window a provider's refusal named (`learn_window`) is the fact about
    the deployment as it answered, and wins when it is smaller.
    """
    with _learned_lock:
        learned = _learned.get(model)
    known = stated or _library_window(model)
    return min(learned, known) if learned and known else learned or known


def _library_window(model: str) -> Optional[int]:
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


def turn_reply_round(e: BaseException) -> Optional[str]:
    """The round a turn that ended with ``e`` stored for the reasoning of the
    model call under way (the reader watched it stream), or None."""
    return getattr(e, 'turn_reply_round', None)


#: Shrinks the transcript a model call was refused as too long for:
#: ``(history, new)``, the turn's earlier messages and its own so far, to a
#: shorter ``history``, or None when nothing more can go.
Shrink = Callable[[List[Dict[str, Any]], List[Dict[str, Any]]], Optional[List[Dict[str, Any]]]]


def run_turn(cfg: ModelConfig, kit: Toolkit, ws: Any, system: str, transcript: List[Dict[str, Any]],
             on_progress: Callable[[int, str], None] = lambda p, m: None,
             cancelled: Callable[[], bool] = lambda: False,
             on_text: Callable[[str], None] = lambda t: None,
             on_thinking: Optional[Callable[[str], None]] = None,
             shrink: Optional[Shrink] = None) -> TurnResult:
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
    too. The reasoning the reader watched for the call under way is stored
    as a round of its own (:func:`turn_reply_round`).

    A model call the provider refuses as too long is asked once more after
    the window its refusal names is learned (`learn_window`) and ``shrink``
    (by default the workspace's, ``ws.shrink``, set by the service) dropped
    older tool results to fit it."""
    trace: List[Dict[str, Any]] = []
    live: Dict[str, Any] = {'round': None, 'text': '', 'n': 1}
    keeper = getattr(ws, 'rounds', None)
    if keeper is not None:
        keeper.follow(trace)
    if on_thinking is None:
        on_thinking = keeper.think if keeper is not None else (lambda t: None)
    if shrink is None:
        shrink = getattr(ws, 'shrink', None)
    try:
        return _run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text, trace, live, keeper,
                         on_thinking, shrink)
    except (Exception, ServiceCancelled) as e:
        rnd = live['round']
        if keeper is not None and rnd is not None and rnd['calls'] and not keeper.store(rnd):
            _unstored(trace, rnd)
        # The text of the call under way, or of a call whose tools never ran.
        partial = live['text'] or (rnd.get('said', '') if rnd is not None and not rnd['calls'] else '')
        # The reasoning of the call under way, or of a call whose tools never
        # ran, which the reader saw stream: its own round.
        reply_round = None
        thought = (rnd.get('thinking') if rnd is not None and not rnd['calls'] else None) \
            or clean_reasoning(keeper.thinking if keeper is not None else None)
        if keeper is not None and thought:
            n = live['n']
            kept = new_round(n, cfg.model, _asked(_clean_transcript(transcript)) if n == 1 else None)
            kept['thinking'] = thought
            if partial:
                kept['said'] = partial
            if keeper.store(kept):
                reply_round = kept['id']
        try:
            e.turn_steps, e.turn_partial, e.turn_reply_round = trace, partial, reply_round
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
              on_thinking: Callable[[str], None] = lambda t: None,
              shrink: Optional[Shrink] = None) -> TurnResult:
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
    # arguments), so the same one again can be told apart, each with the
    # line its tool gave, which the repeat is traced after.
    made: Dict[tuple, Optional[str]] = {}
    spend = Spend()
    # Whether this turn's model was told it planned nothing (`claims_a_plan`),
    # and whether it was told a call it wrote as text did not run.
    nudged = False
    wrote_once = False
    # The tools whose calls went through, in earlier turns and this one: a
    # reply that writes one out is restating it (REV7-AGENT R7A-1, R8A-5).
    ran: set = went_through(history)

    def claimed_nothing(text: str) -> bool:
        """The reply says it planned, and the plan holds nothing now (none
        went through, or discard_plan emptied it) and no card from an
        earlier message still waits (the reply may be about that one)."""
        return not held_changes(ws) and not getattr(ws, 'waiting', None) and claims_a_plan(text)

    def keep_the_plan(e: Exception) -> None:
        """After a model call failed with ``e``: re-raises it when nothing
        is planned. The plan is the substance of this turn, as for an empty
        reply: a failure of any model call after it was staged does not lose
        it, and the turn's reply is NO_ANSWER (REV7-AGENT R7A-8)."""
        if not getattr(ws, 'ops', None):
            raise e
        print(f'{cfg.model}: a model call after a staged plan failed, and the plan is kept:')
        traceback.print_exception(e)
        live['text'] = ''

    def ask_for_the_reply(kwargs: Dict[str, Any], nudge: str):
        """One more call, without tools, when the model owes the user words.
        ``(text, reasoning)``."""
        kwargs = {**kwargs, 'messages': [{'role': 'system', 'content': system}] + history + new
                  + [{'role': 'user', 'content': nudge}]}
        kwargs.pop('tools', None)
        kwargs.pop('tool_choice', None)
        live['n'] = rounds + 1
        try:
            resp = ask(kwargs, lambda: [{'role': 'system', 'content': system}] + history + new
                       + [{'role': 'user', 'content': nudge}])
        except TurnCancelled:
            raise
        except Exception as e:  # noqa: BLE001 - a provider failure, a timeout, a cut reply
            keep_the_plan(e)
            return f'({NO_ANSWER})', None
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
        return text, thinking

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

    def ask(kwargs: Dict[str, Any], messages: Callable[[], List[Dict[str, Any]]]):
        """One model call, ended with :class:`TurnFailed` when it reached
        its output cap (`unless_capped`)."""
        return unless_capped(asked_once(kwargs, messages))

    def unless_capped(resp):
        """``resp``, unless the model was still writing when the call
        reached its output cap. What it wrote stays for the record: its text
        as the turn's partial reply and its reasoning in a round of its own,
        as a stop keeps them (`run_turn`). A call cut off mid tool call has
        arguments no tool can read, so none of it is run."""
        choices = getattr(resp, 'choices', None) or []
        if not choices or getattr(choices[0], 'finish_reason', None) != 'length':
            return resp
        msg = getattr(choices[0], 'message', None)
        said = getattr(msg, 'content', None)
        if isinstance(said, str) and said.strip():
            text_seen(said)
        thought = clean_reasoning(getattr(msg, 'reasoning_content', None))
        if thought:
            on_thinking(thought)
        raise TurnFailed(cut_line((usage_of(resp) or {}).get('received') or cfg.max_tokens))

    def asked_once(kwargs: Dict[str, Any], messages: Callable[[], List[Dict[str, Any]]]):
        """One model call. Refused as too long, it is asked once more on a
        transcript `shrink` cut to the window the refusal named."""
        text_seen('')
        on_thinking('')
        try:
            return _complete(cfg, kwargs, text_seen, cancelled, on_thinking)
        except Exception as e:
            if not too_long(e) or shrink is None:
                raise
            learn_window(cfg.model, e, _sent_tokens(cfg.model, kwargs, cfg.max_tokens), cfg.context_window)
            smaller = shrink(history, new)
            if smaller is None:
                raise
            print(f'{cfg.model} refused the request as too long; asking again with older tool results dropped')
            history[:] = smaller
            text_seen('')
            on_thinking('')
            return _complete(cfg, {**kwargs, 'messages': messages()}, text_seen, cancelled, on_thinking)

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
        live['n'] = rounds + 1
        try:
            resp = ask(kwargs, lambda: [{'role': 'system', 'content': system}] + history + new)
        except TurnCancelled:
            raise
        except Exception as e:  # noqa: BLE001 - a provider failure, a timeout, a cut reply
            # What the failed call wrote and reasoned, which the reader saw
            # stream, is kept in a round of its own, as a failed turn's is.
            partial = live['text']
            thought = clean_reasoning(keeper.thinking) if keeper is not None else None
            keep_the_plan(e)
            kept_round = None
            if keeper is not None and (thought or partial):
                kept = new_round(rounds + 1, cfg.model)
                if thought:
                    kept['thinking'] = thought
                if partial:
                    kept['said'] = partial
                if keeper.store(kept):
                    kept_round = kept['id']
            return TurnResult(f'({NO_ANSWER})', new, trace, spend.usage(), kept_round,
                              bool(kept_round and thought))
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
            # A tool call written out as text, which did not run, and a reply
            # that says it planned when it planned nothing: once each, the
            # model is told and gets its tools back. Its reply and the note
            # stay in the transcript, and the trace has a step for them,
            # whose round holds the reply and the note as sent.
            wrote = None if wrote_once else written_call(
                text, [t['function']['name'] for t in kwargs.get('tools') or [] if t.get('function')],
                ran, run_code_of(history + new))
            if wrote:
                wrote_once = True
                back = (WRITTEN_CALL_STEP, WRITTEN_CALL_LABEL, written_call_note(wrote))
            elif not nudged and claimed_nothing(text):
                nudged = True
                back = (NOTHING_PLANNED_STEP, NOTHING_PLANNED_LABEL, NOTHING_PLANNED)
            else:
                back = None
            if back is not None:
                step_name, label, note = back
                rnd['said'] = text
                step_id = f'{step_name}-{rnd["id"]}'
                rnd['calls'].append(call_record(step_id, step_name, '{}', note))
                step = {'id': step_id, 'name': step_name, 'kind': META, 'label': label, 'said': text}
                if keeper is not None:
                    step['round'] = rnd['id']
                    if rnd.get('thinking'):
                        step['thought'] = True
                    keeper.text = ''
                    keeper.thinking = ''
                trace.append(step)
                new.append({'role': 'user', 'content': note})
                if keeper is not None and not keeper.store(rnd):
                    _unstored(trace, rnd)
                rounds += 1
                if rounds >= cfg.max_steps:
                    text, thinking = ask_for_the_reply(kwargs, '(system) You have used the tool budget for this '
                                                               'turn. Reply now with what you found and what '
                                                               'remains to do.')
                    return TurnResult(text + '\n\n' + STEP_LIMIT_STOP,
                                      new, trace, spend.usage(), *reply_round_of(rounds + 1, thinking))
                continue
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
            nothing = False
            told = None
            cut = False
            saw = None
            # Whether the tool refused the call, by the type of its answer
            # (core.tools.Refusal), never by how the text begins: a read whose
            # output starts with "Error" went through.
            failed = False
            error_kind = None
            try:
                args = json.loads(raw)
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError as e:
                args, result, failed = {}, refused(f'arguments were not valid JSON ({e})', 'invalid-argument'), True
                error_kind = result.kind
                # Sent back as they came, they are the next request's: a
                # server that reads a call's arguments (llama-server) refuses
                # the whole conversation, every retry, and the turn is lost.
                # A call cut off at the context's end did this. The call's
                # round keeps them as written.
                c['function']['arguments'] = '{}'
            else:
                key = (name, json.dumps(args, sort_keys=True, default=str))
                plan_call = kit.tracer.call_kind(name, args) == PLAN and name not in META_TOOLS
                # Counted as the card counts it, which settles each
                # corpus-wide change first: before the snapshot, so settling
                # is never read as the call's doing.
                planned_before = held_changes(ws)
                before = _plan_snapshot(ws) if plan_call else None
                line = kit.tracer.progress(name, args)
                on_progress(min(85, 8 + rounds * 5), line)
                ws.announced = line
                # A value typed in a rare script can come out garbled, and is
                # refused before the tool sees it (see core.garble).
                why = ws.garbled(args) if plan_call and hasattr(ws, 'garbled') else None
                # What the call reads is noted here (`BaseWorkspace.note_read`).
                ws.reads = []
                ws.scoped_documents = None
                ws.step_label = None
                cuts_before = cuts()
                try:
                    result = refused(why, 'invalid-argument') if why else kit.call_tool(ws, name, args)
                    failed = isinstance(result, Refusal)
                    error_kind = result.kind if failed else None
                finally:
                    saw, ws.reads, ws.announced = ws.reads, None, None
                    told, ws.step_label = getattr(ws, 'step_label', None), None
                cut = cuts() > cuts_before
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
                # In changes as the card counts them, so a rule over 7 values
                # is 7 planned changes in the summary, not 1.
                held = held_changes(ws)
                planned = held - planned_before
                if planned:
                    on_progress(min(85, 8 + rounds * 5), planned_progress(held))
                if plan_call and not failed:
                    unchanged = _plan_snapshot(ws) == before
                    if key in made and unchanged:
                        result, repeated = ALREADY_PLANNED, True
                        # Traced as what it is, not as the first call's
                        # change made again.
                        told = again_label(made[key] or kit.tracer.describe(name, args))
                    else:
                        # A plan call that went through and left the plan as
                        # it was planned nothing, and its step says so.
                        nothing = unchanged
                        made[key] = told
            if not failed:
                ran.add(name)
            saved = (getattr(getattr(ws, 'keeper', None), 'saved', None) or [])[saved_before:]
            first = not rnd['calls']
            # A read held to documents is traced by the documents it resolved
            # to (core.scope), each once, not by how the call spelled them.
            scoped = getattr(ws, 'scoped_documents', None)
            traced = ({**args, 'documents': list(scoped)}
                      if scoped and isinstance(args, dict) and args.get('documents') is not None else args)
            ws.scoped_documents = None
            trace.append(trace_step(kit.tracer, c['id'], name, traced, failed=failed, error_kind=error_kind,
                                    planned=planned, saved=saved,
                                    saw=saw, round_id=rnd['id'] if keeper is not None else None,
                                    said=rnd.get('said') if first else None,
                                    thought=first and keeper is not None and bool(rnd.get('thinking')),
                                    nothing=(nothing or repeated) and not failed, told=told, again=repeated))
            if keeper is not None and first:
                # The round's text and reasoning are on its first step now,
                # not the call's.
                keeper.text = ''
                keeper.thinking = ''
            new.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
            rnd['calls'].append(call_record(c['id'], name, raw, result, cut=cut))
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
            return TurnResult(text + '\n\n' + REPEAT_STOP.format(how=line, times=REPEATED_FAILURES),
                              new, trace, spend.usage(), *reply_round_of(rounds + 1, thinking))
        if rounds >= cfg.max_steps:
            text, thinking = ask_for_the_reply(kwargs, '(system) You have used the tool budget for this turn. '
                                                       'Reply now with what you found and what remains to do.')
            # The limit counts model calls, not steps (one call may take
            # several), so the line gives no number the trace would contradict.
            # Raising it is the operator's `--max-steps`, which is not named to
            # the reader.
            return TurnResult(text + '\n\n' + STEP_LIMIT_STOP,
                              new, trace, spend.usage(), *reply_round_of(rounds + 1, thinking))
