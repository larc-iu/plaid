"""Which assistant answers: the plaid-agent release and the hash of what its
model can be told, as each turn records it and an applied plan stamps it."""

import hashlib
import importlib.metadata
import json
from pathlib import Path
from typing import Any, Dict, List, Sequence


def _agent_release() -> str:
    try:
        return importlib.metadata.version('larc-plaid-agent')
    except importlib.metadata.PackageNotFoundError:
        return '0.0.0'  # a checkout on the path, not an installed release


#: The plaid-agent release this process runs (``0.0.0`` in a checkout).
AGENT_VERSION = _agent_release()


def agent_sources(cls) -> List[List[str]]:
    """``[path, sha256]`` of every Python file of the harness
    (``plaid_agent/core``) and of the app package the class ``cls`` is written
    in (``plaid_agent/<app>``), path relative to ``plaid_agent`` with ``/``.
    The package is found from the class's file, not its module name, which is
    ``__main__`` when the service runs with ``python -m``. What a model is
    told is not only the prompt template: the guidelines paragraph, a
    project's shape lines, the note on the other projects a turn may read, the
    notes a turn adds and every tool's answer are written by this code too.
    Line endings are read as the repository stores them, so a CRLF checkout
    hashes like every other."""
    root = Path(__file__).resolve().parent.parent
    dirs = ['core']
    # Through the class's own functions, as plaid_client's BaseService finds
    # a service's file: the module a script runs as may not be in sys.modules.
    # A static method is read through to its function, which an app's own
    # module wrote.
    funcs = (getattr(v, '__func__', v) for v in vars(cls).values())
    code = next((f.__code__ for f in funcs if hasattr(f, '__code__')), None)
    own = Path(code.co_filename).resolve() if code is not None else None
    if own is not None and own.parent.parent == root and own.parent.name != 'core':
        dirs.append(own.parent.name)
    out = []
    for d in dirs:
        for f in sorted((root / d).rglob('*.py')):
            digest = hashlib.sha256(f.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
            out.append([f.relative_to(root).as_posix(), digest])
    return out


def agent_version(texts: List[str], tools: List[Dict[str, Any]],
                  sources: Sequence[Sequence[str]] = ()) -> str:
    """An assistant's version, as each turn records it and an applied plan
    stamps it: the release and the first 8 hex digits of the SHA-256 of the
    system prompt template (before a project fills it), every tool schema and
    the code that writes everything else the model reads (``sources``, see
    :func:`agent_sources`), ``'0.0.0+3fa9c2d1'``. It changes whenever what
    the model can be told does. See the README, "Model and prompt version"."""
    text = json.dumps([list(texts), list(tools), [list(s) for s in sources]],
                      sort_keys=True, ensure_ascii=False)
    return f'{AGENT_VERSION}+{hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]}'


