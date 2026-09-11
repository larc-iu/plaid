"""Write docs/igt/SAMPLE_PROMPT.md: what the model sees, rendered for a reader.

The system prompt and the tool list are built by the real code over the small
project the tests use (``fixtures.py``), with web lookup on so every tool
appears. The file is a snapshot for browsing, not a source of truth:

    python tests/sample_prompt.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fixtures import FakeClient, scan_ws  # noqa: E402
from prompt_render import render_tool  # noqa: E402

from plaid_agent.igt.prompt import build_system_prompt  # noqa: E402
from plaid_agent.igt.tools import TOOLS, WEB_TOOLS, WRITE_TOOLS, call_tool  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'igt', 'SAMPLE_PROMPT.md')

HEADER = '''# What the model sees

The system prompt and the tools the assistant sends to the model, rendered for
the small project the tests use (`tests/fixtures.py`, project "Demo") with web
lookup switched on so that every tool appears. This file is a snapshot for
browsing and may lag behind the code: the prompt is built in
`src/plaid_agent/igt/prompt.py` and the tools are declared in
`src/plaid_agent/igt/tools.py`. Regenerate it with

    python tests/sample_prompt.py

Every model call carries the system prompt, the transcript so far (the browser
keeps it between turns), and the whole tool list. The model answers with text
or with tool calls; each result is appended to the transcript and the model is
called again, up to `--max-steps` calls per turn (`agent.py`). A tool whose
description begins with `PLAN:` writes nothing: it appends to the turn's plan,
which goes back to the user to approve or discard.
'''


def render() -> str:
    """The snapshot as text, so a test can hold the file to it."""
    ws = scan_ws(FakeClient())
    parts = [HEADER, '\n## System prompt\n', '```text', build_system_prompt(ws.project, web=True).rstrip(), '```\n',
             f'## Tools\n\n{len(TOOLS)} tools, in the order the model receives them: {len(WRITE_TOOLS)} plan a change '
             f'(`PLAN:`), {len(WEB_TOOLS)} reach the web, the rest read the project or manage the plan.\n']
    parts += [render_tool(t, WEB_TOOLS) for t in TOOLS]
    parts += ['## What a read returns\n',
              'Two tool results on the same project, so the positional addressing in the prompt has something to '
              'point at. `project_overview` is what the prompt tells the model to call first.\n',
              '```text', call_tool(ws, 'project_overview', {}).rstrip(), '```\n',
              '`read_document` on "Text 1":\n',
              '```text', call_tool(ws, 'read_document', {'document': 'Text 1'}).rstrip(), '```\n']
    return '\n'.join(parts)


def main() -> None:
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(render())
    print(f'wrote {os.path.normpath(OUT)}: {len(TOOLS)} tools')


if __name__ == '__main__':
    main()
