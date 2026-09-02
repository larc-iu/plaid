"""Write SAMPLE_PROMPT.md: what the model sees, rendered for a reader.

The system prompt and the tool list are built by the real code over the small
project the tests use (``fixtures.py``), with web lookup on so every tool
appears. The file is a snapshot for browsing, not a source of truth:

    python tests/sample_prompt.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fixtures import FakeClient, scan_ws  # noqa: E402

from plaid_igt_agent.prompt import build_system_prompt  # noqa: E402
from plaid_igt_agent.tools import TOOLS, WEB_TOOLS, WRITE_TOOLS, call_tool  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'SAMPLE_PROMPT.md')

HEADER = '''# What the model sees

The system prompt and the tools the assistant sends to the model, rendered for
the small project the tests use (`tests/fixtures.py`, project "Demo") with web
lookup switched on so that every tool appears. This file is a snapshot for
browsing and may lag behind the code: the prompt is built in
`src/plaid_igt_agent/prompt.py` and the tools are declared in
`src/plaid_igt_agent/tools.py`. Regenerate it with

    python tests/sample_prompt.py

Every model call carries the system prompt, the transcript so far (the browser
keeps it between turns), and the whole tool list. The model answers with text
or with tool calls; each result is appended to the transcript and the model is
called again, up to `--max-steps` calls per turn (`agent.py`). A tool whose
description begins with `PLAN:` writes nothing: it appends to the turn's plan,
which goes back to the user to approve or discard.
'''


def typ(s: dict) -> str:
    t = s.get('type')
    if 'enum' in s:
        return 'one of ' + ', '.join(f'`{v}`' for v in s['enum'])
    if t == 'array':
        return 'array of ' + typ(s.get('items') or {})
    if t == 'object':
        if s.get('properties'):
            req = set(s.get('required') or [])
            inner = ', '.join(f'{k}: {typ(v)}' + (' (required)' if k in req else '')
                              for k, v in s['properties'].items())
            return 'object {' + inner + '}'
        if 'additionalProperties' in s:
            return 'object of ' + typ(s['additionalProperties'])
    return t or 'any'


def render_tool(spec: dict) -> str:
    f = spec['function']
    lines = [f"### {f['name']}", '', f['description'], '']
    if f['name'] in WEB_TOOLS:
        lines += ['*Offered only when the operator started the service with `--web-search`.*', '']
    props = f['parameters'].get('properties') or {}
    req = set(f['parameters'].get('required') or [])
    if not props:
        lines.append('No parameters.')
    else:
        for name, s in props.items():
            kind = typ(s) + (', required' if name in req else '')
            desc = s.get('description')
            lines.append(f'- `{name}` ({kind})' + (f': {desc}' if desc else ''))
    return '\n'.join(lines) + '\n'


def main() -> None:
    ws = scan_ws(FakeClient())
    parts = [HEADER, '\n## System prompt\n', '```text', build_system_prompt(ws.project, web=True).rstrip(), '```\n',
             f'## Tools\n\n{len(TOOLS)} tools, in the order the model receives them: {len(WRITE_TOOLS)} plan a change '
             f'(`PLAN:`), {len(WEB_TOOLS)} reach the web, the rest read the project or manage the plan.\n']
    parts += [render_tool(t) for t in TOOLS]
    parts += ['## What a read returns\n',
              'Two tool results on the same project, so the positional addressing in the prompt has something to '
              'point at. `project_overview` is what the prompt tells the model to call first.\n',
              '```text', call_tool(ws, 'project_overview', {}).rstrip(), '```\n',
              '`read_document` on "Text 1":\n',
              '```text', call_tool(ws, 'read_document', {'document': 'Text 1'}).rstrip(), '```\n']
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(parts))
    print(f'wrote {os.path.normpath(OUT)}: {len(TOOLS)} tools')


if __name__ == '__main__':
    main()
