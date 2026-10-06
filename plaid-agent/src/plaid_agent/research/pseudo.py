"""Pseudonyms and clipping: what keeps a dataset from naming anyone.

A user is a stable pseudonym per dataset, drawn from a keyed hash of the
user's id with a salt kept OUTSIDE the dataset. The same salt gives the same
pseudonyms on a later extraction, so two extractions can be joined, and
without it a pseudonym cannot be turned back into an id or an email by
hashing guesses. A project is its id (a random UUID, which names nobody) plus
a pseudonym, and keeps its name only when the researcher asks.
"""

import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import Any, Optional

# The most code points of a value kept, as the plan record keeps them
# (`plaid_agent.core.conversation.PROPOSED_VALUE_MAX`).
VALUE_MAX = 24


def clip(v: Any, limit: int = VALUE_MAX) -> Any:
    """A value as a plan record keeps it: a string cut to ``limit`` code
    points with an ellipsis, a number as it is, anything else as None."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return v if len(v) <= limit else v[:limit - 1] + '…'
    return None


def load_salt(path: Path, out_dir: Path) -> bytes:
    """The salt at ``path``, made on first use. Refused when it would sit
    inside the dataset, which would let anyone holding the dataset test a
    guessed id against a pseudonym."""
    path = Path(path).resolve()
    out = Path(out_dir).resolve()
    if path == out or out in path.parents:
        raise SystemExit(f'The salt file must be outside the output directory ({out}).')
    if path.exists():
        salt = path.read_bytes().strip()
        if len(salt) < 16:
            raise SystemExit(f'{path} holds no usable salt.')
        return salt
    path.parent.mkdir(parents=True, exist_ok=True)
    salt = secrets.token_hex(32).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(salt + b'\n')
    return salt


class Pseudonyms:
    def __init__(self, salt: bytes):
        self.salt = salt

    def _h(self, kind: str, value: str) -> str:
        return hmac.new(self.salt, f'{kind}:{value}'.encode(), hashlib.sha256).hexdigest()[:10]

    def user(self, user_id: Optional[str]) -> Optional[str]:
        return f'u-{self._h("user", user_id)}' if user_id else None

    def project(self, project_id: Optional[str]) -> Optional[str]:
        return f'p-{self._h("project", project_id)}' if project_id else None

    def source(self, source: Optional[str]) -> Optional[str]:
        """A provSource with any person in it pseudonymized: ``user:<id>``
        names a contributor. A service or rule name is kept."""
        if not isinstance(source, str):
            return None
        if source.startswith('user:'):
            return f'user:{self.user(source[5:])}'
        return source
