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
from typing import Any, Callable, Dict, List, Optional, Tuple

import litellm

from .tools import TOOLS, WRITE_TOOLS, Workspace, call_tool

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


def _progress_label(name: str, args: Dict[str, Any]) -> str:
    if name == 'project_overview':
        return 'Looking at the project…'
    if name == 'read_document':
        return f'Reading "{args.get("document", "")}"…'
    if name == 'search':
        return f'Searching for "{args.get("pattern", "")}"…'
    if name == 'field_values':
        return f'Counting {args.get("field", "")} values…'
    if name == 'read_lexicon':
        return 'Reading the lexicon…'
    if name == 'concordance':
        return f'Concordancing "{args.get("pattern", "")}"…'
    if name == 'analyses_of':
        return f'Tallying analyses of "{args.get("form", "")}"…'
    if name == 'lexicon_entry':
        return f'Looking up "{args.get("entry_form") or args.get("entry_id") or ""}"…'
    if name == 'check_consistency':
        return f'Checking {args.get("field", "")} consistency…'
    if name == 'recent_changes':
        return 'Reading the change history…'
    if name in WRITE_TOOLS:
        return 'Planning changes…'
    return f'{name}…'


def run_turn(cfg: ModelConfig, ws: Workspace, system: str, transcript: List[Dict[str, Any]],
             on_progress: Callable[[int, str], None] = lambda p, m: None
             ) -> Tuple[str, List[Dict[str, Any]]]:
    """Run one turn. Returns (final assistant text, the NEW messages this turn
    appended to the transcript: assistant tool-call messages, tool results,
    and the final assistant message)."""
    history = _clean_transcript(transcript)
    new: List[Dict[str, Any]] = []
    steps = 0
    while True:
        on_progress(min(85, 8 + steps * 5), 'Thinking…' if steps == 0 else 'Thinking more…')
        kwargs: Dict[str, Any] = dict(model=cfg.model, messages=[{'role': 'system', 'content': system}] + history + new,
                                      tools=TOOLS, tool_choice='auto')
        if cfg.api_base:
            kwargs['api_base'] = cfg.api_base
        if cfg.api_key:
            kwargs['api_key'] = cfg.api_key
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
            text = d.get('content') or ''
            if not text.strip():
                # Some models end a tool-heavy turn with an empty message (or
                # reasoning only). Ask once, without tools, for the reply.
                new.append({'role': 'user', 'content': '(system) Your last message was empty. '
                                                       'Reply now with your answer to the user.'})
                kwargs['messages'] = [{'role': 'system', 'content': system}] + history + new
                kwargs.pop('tools', None)
                kwargs.pop('tool_choice', None)
                resp = litellm.completion(**kwargs)
                choice = resp.choices[0]
                d = _message_to_dict(choice.message)
                d.pop('tool_calls', None)
                new.append(d)
                text = d.get('content') or ''
                if not text.strip():
                    text = '(The model returned an empty reply.)'
            if getattr(choice, 'finish_reason', None) == 'length':
                text += ('\n\n*(The reply was cut off by the model\'s output limit. The operator can raise '
                         'it with `--max-tokens`.)*')
            return text, new
        steps += 1
        for c in calls:
            name = c['function']['name']
            try:
                args = json.loads(c['function']['arguments'] or '{}')
                if not isinstance(args, dict):
                    args = {}
            except json.JSONDecodeError as e:
                result = f'Error: arguments were not valid JSON ({e})'
            else:
                on_progress(min(85, 8 + steps * 5), _progress_label(name, args))
                result = call_tool(ws, name, args)
            new.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
        if steps >= cfg.max_steps:
            new.append({'role': 'user', 'content': '(system) You have used the tool budget for this turn. '
                                                   'Reply now with what you found and what remains to do.'})
            kwargs['messages'] = [{'role': 'system', 'content': system}] + history + new
            kwargs.pop('tools', None)
            kwargs.pop('tool_choice', None)
            resp = litellm.completion(**kwargs)
            d = _message_to_dict(resp.choices[0].message)
            d.pop('tool_calls', None)
            new.append(d)
            text = (d.get('content') or '').strip() or '(The model returned an empty reply.)'
            return (text + f'\n\n*(Stopped after {cfg.max_steps} tool calls, the per-turn limit; the operator '
                           f'can raise it with `--max-steps`.)*'), new
