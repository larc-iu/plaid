"""The model loop: one chat turn = model call, tool calls, repeat, final text.

Provider-agnostic through litellm: ``model`` is any litellm model string
(``openai/gpt-4o``, ``anthropic/claude-...``, ``ollama/llama3``, an
OpenAI-compatible server via ``--api-base``), keys come from the usual
environment variables or ``--api-key``.

The transcript is plain OpenAI-shaped message dicts (system message excluded)
so the browser can hold it between turns and send it back; tool calls and
results stay in it, which is what lets a later turn build on what an earlier
one read without re-reading.
"""

import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import litellm

from .tools import Workspace, call_tool, tools_for
from .trace import progress_label, summarize_steps, trace_step

litellm.drop_params = True  # providers that lack a param get it dropped, not an error


@dataclass
class ModelConfig:
    model: str
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    max_steps: int = 50
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None

    def describe(self) -> Dict[str, Any]:
        return {'model': self.model, **({'api_base': self.api_base} if self.api_base else {})}


PING_TIMEOUT_S = 30


def _provider_kwargs(cfg: ModelConfig) -> Dict[str, Any]:
    """What every call to this model needs: the model string, and the base and
    key when the operator gave them (else litellm reads the provider's env)."""
    out: Dict[str, Any] = {'model': cfg.model}
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
    complaint reach the operator. Raises whatever litellm raises.
    """
    resp = litellm.completion(**_provider_kwargs(cfg), timeout=timeout, max_tokens=8,
                              messages=[{'role': 'user', 'content': 'ping'}])
    if not getattr(resp, 'choices', None):
        raise RuntimeError('the provider answered without a completion')


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
    """A reply the provider cut off at its output limit says so, since the
    operator is the only one who can raise it."""
    if getattr(choice, 'finish_reason', None) != 'length':
        return ''
    return ('\n\n*(The reply was cut off by the model\'s output limit. The operator can raise it '
            'with `--max-tokens`.)*')


@dataclass
class TurnResult:
    """One finished turn: the reply, the messages it appended to the
    transcript, and the trace of what it did (see :mod:`.trace`)."""
    text: str
    messages: List[Dict[str, Any]]
    steps: List[Dict[str, Any]]

    @property
    def summary(self) -> str:
        return summarize_steps(self.steps)


def run_turn(cfg: ModelConfig, ws: Workspace, system: str, transcript: List[Dict[str, Any]],
             on_progress: Callable[[int, str], None] = lambda p, m: None) -> TurnResult:
    """Run one turn: model call, tool calls, repeat, final text."""
    history = _clean_transcript(transcript)
    new: List[Dict[str, Any]] = []
    trace: List[Dict[str, Any]] = []
    rounds = 0

    def ask_for_the_reply(kwargs: Dict[str, Any], nudge: str) -> str:
        """One more call, without tools, when the model owes the user words."""
        kwargs = {**kwargs, 'messages': [{'role': 'system', 'content': system}] + history + new
                  + [{'role': 'user', 'content': nudge}]}
        kwargs.pop('tools', None)
        kwargs.pop('tool_choice', None)
        choice = litellm.completion(**kwargs).choices[0]
        d = _message_to_dict(choice.message)
        d.pop('tool_calls', None)
        new.append(d)  # the nudge itself never enters the saved transcript
        text = (d.get('content') or '').strip() or '(The model returned an empty reply.)'
        return text + _length_note(choice)

    while True:
        on_progress(min(85, 8 + rounds * 5), 'Thinking…' if rounds == 0 else 'Thinking more…')
        kwargs: Dict[str, Any] = dict(**_provider_kwargs(cfg), tools=tools_for(ws), tool_choice='auto',
                                      messages=[{'role': 'system', 'content': system}] + history + new)
        if cfg.temperature is not None:
            kwargs['temperature'] = cfg.temperature
        if cfg.max_tokens:
            kwargs['max_tokens'] = cfg.max_tokens
        resp = litellm.completion(**kwargs)
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
            return TurnResult(text, new, trace)
        rounds += 1
        for c in calls:
            name = c['function']['name']
            try:
                args = json.loads(c['function']['arguments'] or '{}')
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError as e:
                args, result = {}, f'Error: arguments were not valid JSON ({e})'
            else:
                on_progress(min(85, 8 + rounds * 5), progress_label(name, args))
                result = call_tool(ws, name, args)
            trace.append(trace_step(c['id'], name, args))
            new.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
        if rounds >= cfg.max_steps:
            text = ask_for_the_reply(kwargs, '(system) You have used the tool budget for this turn. '
                                             'Reply now with what you found and what remains to do.')
            return TurnResult(text + f'\n\n*(Stopped after {cfg.max_steps} tool calls, the per-turn limit; '
                                     f'the operator can raise it with `--max-steps`.)*', new, trace)
