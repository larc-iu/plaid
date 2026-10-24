"""A value inside a line a person reads, kept to its own direction.

A plan's lines, its summary, the sentence that says why it is out of date and
the History label are plain strings the app draws as they are. A change such
as ``Field "كتاب" → "كتب"`` has a right-to-left value on each side of the
arrow, and by the bidi algorithm the arrow between them joins them into one
right-to-left run: the line reads backwards, and a count drawn after it is
pulled inside the run. Each value goes between FIRST STRONG ISOLATE and POP
DIRECTIONAL ISOLATE (U+2068, U+2069), which the browser draws as nothing and
which keep the value's direction to itself.

The model reads tool answers without them (:func:`for_model`): it copies
what it reads into its next call, and an isolate copied into a pattern or a
replacement would match nothing or be written into the data.
"""

from typing import Any

FSI = '\u2068'
LRI = '\u2066'
PDI = '\u2069'

_STRIP = {ord(FSI): None, ord(LRI): None, ord(PDI): None}


def iso(v: Any) -> str:
    """A value isolated in a line, its direction its own."""
    return f'{FSI}{"" if v is None else v}{PDI}'


def qv(v: Any) -> str:
    """A value in straight quotes, isolated: ``"<FSI>كتاب<PDI>"``."""
    return f'"{iso(v)}"'


def escape_name(name: Any) -> str:
    """A document name to put between straight quotes: an inner ``"``
    written ``\\"`` (``French "3"`` is ``French \\"3\\"``), as
    core.workspace's resolver reads a quoted name back."""
    return ('' if name is None else str(name)).replace('"', '\\"')


def qname(name: Any) -> str:
    """A document name in straight quotes, isolated, an inner quote escaped:
    ``"French \\"3\\""``."""
    return qv(escape_name(name))


def plain_quote(name: Any) -> str:
    """A document name in straight quotes, an inner quote escaped, not
    isolated: for a list that goes into the prompt as it is (the overview),
    where no isolate is taken out."""
    return f'"{escape_name(name)}"'


def qrx(pattern: Any) -> str:
    """A regular expression in quotes, isolated left to right whatever its
    letters: it is a format, read from its ``^`` on the left."""
    return f'"{LRI}{"" if pattern is None else pattern}{PDI}"'


def for_model(text: Any) -> Any:
    """A tool's answer as the model reads it: the isolates taken out."""
    return text.translate(_STRIP) if isinstance(text, str) else text


#: Characters that would break a line the model reads into two, as a read
#: prints them. A token whose text held two lines printed as two rows
#: (2026-10-12 survey), and a metadata value as a fake line (HUNT-recent 13).
_BREAKS = str.maketrans({'\n': '\\n', '\r': '\\r', '\t': '\\t'})


def visible(value: Any) -> str:
    """``value`` with its line breaks and tabs as visible escapes, so a line
    stays one line."""
    return str(value).translate(_BREAKS)
