"""Characters a model wrote that it cannot have meant.

A model writes text as tokens, and a tokenizer that works on bytes has no token
for a letter of a rare script. So the model writes such a letter as two pieces,
one for its first three UTF-8 bytes and one for the last, and it does not always
get the first piece right. When it gets that piece wrong, the letter comes out in
another script that happens to be more common in what the model was trained on.
A Wancho word typed by GLM came out as Egyptian hieroglyphs, the last byte of every
letter intact, so the hieroglyphs shifted back by a fixed offset gave the word.
Sometimes the first piece comes out as bytes that are no character at all, which
decode to U+FFFD.

A value copied in code from what the project or a file holds never passes through
the model's writing, so it is never garbled this way. A value the model TYPES can
be. This module is the check made of what the model hands a plan tool, or
plan() and save_file() in run_code: a broken character,
or a letter outside the Basic Multilingual Plane from a script that appears nowhere
the turn could have copied it from. Only those planes are checked because the
common scripts are in the BMP and have tokens of their own, so a model writes them
reliably, and a translation into Hindi for a project that has none is a real value.
"""

import unicodedata
from typing import Any, Callable, Iterable, Optional, Set

REPLACEMENT = '\ufffd'


def script(ch: str) -> str:
    """The script a character belongs to, as the first word of its Unicode name:
    WANCHO, EGYPTIAN, LATIN. Python has no script property, and the name's first
    word is the same thing for every letter outside the BMP."""
    name = unicodedata.name(ch, '')
    return name.split(' ', 1)[0] if name else ''


def _rare(ch: str) -> bool:
    """A letter outside the BMP: what a byte-level tokenizer writes in pieces."""
    return ord(ch) > 0xFFFF and unicodedata.category(ch).startswith('L')


def strings(value: Any) -> Iterable[str]:
    """Every string in a value: the value itself, or what a dict or list holds."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from strings(k)
            yield from strings(v)
    elif isinstance(value, (list, tuple, set)):
        for v in value:
            yield from strings(v)


class Seen:
    """The scripts of the rare letters a turn could have copied from.

    Fed with what the turn was given (the stored conversation, apart from what the
    model itself wrote in it) and with everything its tools answered, the host
    functions of run_code included, so a value copied in code from a document that
    was never printed is still one the turn has seen. Only rare letters are kept,
    and a string with none costs one scan in C.
    """

    def __init__(self):
        self.scripts: Set[str] = set()

    def add(self, value: Any, unless: Any = None) -> Any:
        """Note the scripts in ``value``, and give it back unchanged.

        ``unless`` is what the model wrote to get ``value``: a tool's arguments,
        or the code that run_code ran. A script in it is not taken from the
        answer, since an answer can echo what it was asked (a search that found
        nothing names the form it looked for), and a garbled form echoed back
        is still garbled.
        """
        found = scripts_of(value)
        if unless is not None:
            found -= scripts_of(unless)
        self.scripts |= found
        return value


def scripts_of(value: Any) -> Set[str]:
    """The scripts of the rare letters in a value."""
    out: Set[str] = set()
    for s in strings(value):
        if s.isascii():
            continue
        for ch in set(s):
            if _rare(ch):
                out.add(script(ch))
    return out


def _excerpt(s: str, at: int) -> str:
    lo = max(0, at - 20)
    return ('…' if lo else '') + s[lo:at + 20] + ('…' if at + 20 < len(s) else '')


def refusal(value: Any, seen: Seen, more: Optional[Callable[[], Iterable[str]]] = None) -> Optional[str]:
    """Why ``value`` may not be staged, or None.

    ``more`` gives further text the turn could copy from (the attached files), read
    only when a letter is in doubt, so a plan with nothing rare in it never reads a
    four-megabyte table to find that out.
    """
    asked = False
    for s in strings(value):
        if s.isascii():
            continue
        at = s.find(REPLACEMENT)
        if at >= 0:
            return (f'"{_excerpt(s, at)}" has a broken character in it (�), which is what a letter of a '
                    'rare script becomes when it is typed out and comes out wrong. Do not type a form in '
                    'that script: copy it in run_code from the data that holds it (load, query or '
                    'file_rows), and stage the change from there.')
        for i, ch in enumerate(s):
            if not _rare(ch) or script(ch) in seen.scripts:
                continue
            if not asked and more is not None:
                asked = True
                for text in more():
                    seen.add(text)
                if script(ch) in seen.scripts:
                    continue
            name = script(ch).capitalize() or 'unnamed'
            return (f'"{_excerpt(s, i)}" has letters of the {name} script, which appear in nothing you '
                    'have read that it could have been copied from. A form in a '
                    'rare script that is typed out often comes out in another script entirely. Do not '
                    'type it: copy it in run_code from the data that holds it (load, query or file_rows), '
                    'and stage the change from there. If it really is new text the user gave you, ask '
                    'them to paste it into the chat.')
    return None


def seed(seen: Seen, system: str, transcript: Iterable[dict]) -> None:
    """Note what a turn starts out able to copy from: the system prompt, every
    message of the user's, and every tool answer of earlier turns, each less
    what its own call asked (as :meth:`Seen.add` takes it live). What the model
    itself wrote is not a source: it may be garbled already."""
    seen.add(system)
    asked = {}
    for m in transcript:
        if m.get('role') == 'assistant':
            for c in m.get('tool_calls') or m.get('tool-calls') or []:
                asked[c.get('id')] = (c.get('function') or {}).get('arguments')
    for m in transcript:
        role = m.get('role')
        if role == 'user':
            seen.add(m.get('content'))
        elif role == 'tool':
            seen.add(m.get('content'), unless=_parsed(asked.get(m.get('tool_call_id') or m.get('tool-call-id'))))


def _parsed(arguments: Any) -> Any:
    """A call's arguments as the model wrote them, decoded: a provider may send
    them with every letter past ASCII escaped, which hides their script."""
    if isinstance(arguments, str):
        import json
        try:
            return json.loads(arguments)
        except ValueError:
            return arguments
    return arguments
