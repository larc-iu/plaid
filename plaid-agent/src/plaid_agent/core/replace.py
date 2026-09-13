"""One substitution, built from what a model wrote.

Both apps offer a find-and-replace over stored values, and both take the same
four switches: literal or regular expression, the whole value or a substring,
case-sensitive or not. The subtlety is entirely in the literal case, which is
the one a person asks for: a replacement typed as text goes into
``re.sub`` as a TEMPLATE, where a backslash means something. So "back\\slash"
raised, "x\\1y" raised, and neither is a pattern the user was writing.

Anchoring is the other half: ``whole`` anchors the PATTERN rather than
switching to ``fullmatch``, so a group captured in a whole-value pattern can
still be written back into the replacement.
"""

import re
from typing import Callable


def replacer(pattern: str, replacement: str, regex: bool, whole: bool,
             case_sensitive: bool = False, error=ValueError) -> Callable[[str], str]:
    """A function from a stored value to its replacement.

    Case-insensitive by default, like search, so what search found is what the
    replacement hits. ``error`` is the exception class the app reports to the
    model with; the message is the whole of what it says.
    """
    if not pattern:
        raise error('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    flags = 0 if case_sensitive else re.IGNORECASE
    body = pattern if regex else re.escape(pattern)
    try:
        compiled = re.compile(f'^(?:{body})$' if whole else body, flags)
    except re.error as e:
        raise error(f'That is not a valid regular expression: {e}')
    # A literal replacement is text, not a template: every backslash in it
    # stands for itself.
    template = replacement if regex else replacement.replace('\\', '\\\\')

    def apply(value: str) -> str:
        try:
            return compiled.sub(template, value)
        except re.error as e:
            raise error(f'The replacement is not valid for that pattern: {e}')
    return apply
