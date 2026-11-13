"""Write docs/<app>/SAMPLE_PROMPT.md: what each assistant's model sees,
rendered for a reader.

The system prompt and the tool list are built by the real code over the small
project each app's tests use, with web lookup on so every tool appears. The
files are snapshots for browsing, not a source of truth:

    bb sample-prompts
"""

import importlib
import os
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prompt_render import render_tool  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

#: app -> (its name in the header, the fixtures module, the project there, the
#: document read, the module that runs a turn)
APPS = {
    'igt': ('the assistant', 'fixtures', 'Demo', 'Text 1', 'agent.py'),
    'ud': ('the UD assistant', 'ud_fixtures', 'Spanish', 'Viaje', 'core/agent.py'),
    'umr': ('the UMR assistant', 'umr_fixtures', 'Sample', 'Story', 'core/agent.py'),
}


def out(app: str) -> str:
    return os.path.join(HERE, '..', 'docs', app, 'SAMPLE_PROMPT.md')


def _header(app: str) -> str:
    who, fixtures, project, _, agent = APPS[app]
    intro = textwrap.fill(
        f'The system prompt and the tools {who} sends to the model, rendered for the small project the tests use '
        f'(`tests/{fixtures}.py`, project "{project}") with web lookup switched on so that every tool appears. '
        f'This file is a snapshot for browsing and may lag behind the code: the prompt is built in '
        f'`src/plaid_agent/{app}/prompt.py` and the tools are declared in `src/plaid_agent/{app}/toolkit.py`. '
        'Regenerate it with', width=80 if app == 'igt' else 79)
    turn = ('Every model call carries the system prompt, the transcript so far (the browser\n'
            'keeps it between turns), and the whole tool list. The model answers with text\n'
            'or with tool calls; each result is appended to the transcript and the model is\n'
            f'called again, up to `--max-steps` calls per turn (`{agent}`). A tool whose\n'
            'description begins with `PLAN:` writes nothing: it appends to the turn\'s plan,\n'
            'which goes back to the user to approve or discard.')
    return f'# What the model sees\n\n{intro}\n\n    bb sample-prompts\n\n{turn}\n'


def _workspace(app: str):
    """The workspace a test of ``app`` runs against, with the web on so the
    web tools are declared."""
    if app == 'igt':
        from fixtures import FakeClient, fake_ws
        return fake_ws(FakeClient())
    fixtures = importlib.import_module(APPS[app][1])
    client = getattr(fixtures, f'{app}_client')()
    project = importlib.import_module(f'plaid_agent.{app}.project').load_project(client, fixtures.PID)
    ws = importlib.import_module(f'plaid_agent.{app}.tools').Workspace(client, project)
    ws.web = object()
    return ws


def render(app: str) -> str:
    """The snapshot as text, so a test can hold the file to it."""
    # Every tool appears, whether or not this machine can run code, and the
    # answer is put back afterwards: this is called from a test, and leaving
    # the sandbox permanently "available" changed what every later test saw.
    from plaid_agent.core import sandbox
    was = sandbox.available
    sandbox.available = lambda: None
    try:
        return _render(app)
    finally:
        sandbox.available = was


def _render(app: str) -> str:
    kit = importlib.import_module(f'plaid_agent.{app}.toolkit')
    prompt = importlib.import_module(f'plaid_agent.{app}.prompt')
    ws = _workspace(app)
    document = APPS[app][3]
    parts = [_header(app), '\n## System prompt\n', '```text',
             prompt.build_system_prompt(ws.project, web=True).rstrip(), '```\n',
             f'## Tools\n\n{len(kit.TOOLS)} tools, in the order the model receives them: {len(kit.WRITE_TOOLS)} '
             f'plan a change (`PLAN:`), {len(kit.WEB_TOOLS)} reach the web, the rest read the project or manage '
             'the plan.\n']
    parts += [render_tool(t, kit.WEB_TOOLS) for t in kit.TOOLS]
    parts += ['## What a read returns\n',
              'Two tool results on the same project, so the positional addressing in the prompt has something to '
              'point at.\n',
              '```text', kit.call_tool(ws, 'project_overview', {}).rstrip(), '```\n',
              f'`read_document` on "{document}":\n',
              '```text', kit.call_tool(ws, 'read_document', {'document': document}).rstrip(), '```\n']
    return '\n'.join(parts)


def job_out() -> str:
    return os.path.join(HERE, '..', 'docs', 'igt', 'SAMPLE_JOB_PROMPT.md')


def render_job() -> str:
    """What an unattended job's model contexts see: the planning context's
    prompt and tools, a piece's prompt and tools (the chat's own, less those
    no job is offered), and the final context's prompt, over the igt tests'
    project."""
    from plaid_agent.igt import prompt, toolkit
    from plaid_agent.igt.job import JobWorkspace
    ws = _workspace('igt')
    piece = JobWorkspace(ws.client, ws.project)
    planning = JobWorkspace(ws.client, ws.project, mode=JobWorkspace.PLAN)
    tools = toolkit.job_piece_tools(piece)
    plan_tools = toolkit.job_plan_tools(planning)
    intro = textwrap.fill(
        'The system prompts and the tools an unattended job sends to the model, rendered for the small project '
        'the tests use (`tests/fixtures.py`, project "Demo"). A job is the assistant, unattended: its planning '
        'context cuts the work into pieces, each piece is a context of its own with the chat\'s tools, and a '
        'final context writes the report\'s summary. This file is a snapshot for browsing and may lag behind the '
        'code: the prompts are built in `src/plaid_agent/igt/prompt.py` (`build_plan_prompt`, `build_job_prompt`, '
        '`build_summary_prompt`) and the tools are chosen in `src/plaid_agent/igt/toolkit.py`. Regenerate it with',
        width=80)
    names = [t['function']['name'] for t in tools]
    parts = [f'# What a job\'s model sees\n\n{intro}\n\n    bb sample-prompts\n',
             '\n## The planning context\n', 'Its system prompt:\n', '```text',
             prompt.build_plan_prompt(ws.project).rstrip(), '```\n',
             f'Its {len(plan_tools)} tools are the chat\'s reads and code, as `SAMPLE_PROMPT.md` shows them, and '
             '`plan_work`:\n', render_tool(toolkit.PLAN_WORK),
             '\n## A piece\n', 'Its system prompt:\n', '```text', prompt.build_job_prompt(ws.project).rstrip(), '```\n',
             f'Its {len(tools)} tools are the chat\'s, as `SAMPLE_PROMPT.md` shows them, less '
             + ', '.join(f'`{n}`' for n in toolkit.JOB_LEFT_OUT) + ': ' + ', '.join(names) + '.\n',
             '\n## The final context\n', 'Its system prompt, with no tools:\n', '```text',
             prompt.build_summary_prompt(ws.project).rstrip(), '```\n']
    return '\n'.join(parts)


def copy_igt_guide() -> None:
    """The igt app's user guide into the package, for an install without the
    app's sources (plaid_agent/igt/guide.py reads the repository's own where
    it can)."""
    from plaid_agent.igt.guide import PACKAGED_GUIDE, REPO_GUIDE
    from plaid_agent.igt.jobread import PACKAGED_SECTIONS, REPO_SECTIONS
    for repo, packaged in ((REPO_GUIDE, PACKAGED_GUIDE), (REPO_SECTIONS, PACKAGED_SECTIONS)):
        if repo.is_file():
            packaged.write_text(repo.read_text(encoding='utf-8'), encoding='utf-8')
            print(f'wrote {os.path.normpath(str(packaged))}')


def main() -> None:
    for app in sys.argv[1:] or APPS:
        os.makedirs(os.path.dirname(out(app)), exist_ok=True)
        with open(out(app), 'w', encoding='utf-8') as fh:
            fh.write(render(app))
        print(f'wrote {os.path.normpath(out(app))}')
    if not sys.argv[1:] or 'igt' in sys.argv[1:]:
        with open(job_out(), 'w', encoding='utf-8') as fh:
            fh.write(render_job())
        print(f'wrote {os.path.normpath(job_out())}')
        copy_igt_guide()


if __name__ == '__main__':
    main()
