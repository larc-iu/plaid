"""One substitution, built from what a model wrote.

Both apps offer a find-and-replace over stored values, and both take the same
four switches: literal or regular expression, the whole value or a substring,
case-sensitive or not. The values to rewrite are found by the server's search,
so the pattern is read here exactly as the server reads it
(:mod:`.java_regex`): Python's own ``re`` read ``\\w``, ``\\b`` and
``[[:alpha:]]`` otherwise, and a replace rewrote other values than the search
found.

The other subtlety is the literal replacement, the one a person asks for: a
replacement typed as text goes into ``sub`` as a TEMPLATE, where a backslash
means something. So "back\\slash" raised, "x\\1y" raised, and neither is a
pattern the user was writing.

Anchoring is the last half: ``whole`` anchors the PATTERN rather than
switching to ``fullmatch``, so a group captured in a whole-value pattern can
still be written back into the replacement.
"""

from typing import Callable

import regex

from .java_regex import PatternError, compile_local


def replacer(pattern: str, replacement: str, regex_mode: bool, whole: bool,
             case_sensitive: bool = False, error=ValueError) -> Callable[[str], str]:
    """A function from a stored value to its replacement.

    Case-insensitive by default, like search, so what search found is what the
    replacement hits. ``error`` is the exception class the app reports to the
    model with; the message is the whole of what it says.
    """
    if not pattern:
        raise error('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    try:
        compiled = compile_local(pattern, literal=not regex_mode,
                                 case_insensitive=not case_sensitive, whole=whole)
    except PatternError as e:
        raise error(f'That pattern cannot be used: {e}')
    # A literal replacement is text, not a template: every backslash in it
    # stands for itself.
    template = replacement if regex_mode else replacement.replace('\\', '\\\\')

    def apply(value: str) -> str:
        try:
            return compiled.sub(template, value)
        except (regex.error, IndexError) as e:
            raise error(f'The replacement is not valid for that pattern: {e}')
    return apply
