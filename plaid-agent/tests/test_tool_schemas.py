"""Every tool's schema and its Python signature agree, in both apps.

A parameter the function accepts but the schema omits is one the model can
never use; a schema parameter the function rejects is a TypeError the model
reads as its own mistake. Both happened, silently, until this checked."""

import inspect

import pytest

from plaid_agent.igt import tools as igt
from plaid_agent.ud import tools as ud


@pytest.mark.parametrize('app', [ud, igt], ids=['ud', 'igt'])
def test_every_schema_matches_its_signature(app):
    schema = {t['function']['name']: set((t['function']['parameters'] or {}).get('properties', {}).keys())
              for t in app.TOOLS}
    problems = []
    for name, fn in sorted(app._IMPL.items()):
        if name not in schema:
            problems.append(f'{name}: implemented but not declared')
            continue
        sig = [p for p in inspect.signature(fn).parameters if p != 'ws']
        for p in sig:
            if p not in schema[name]:
                problems.append(f'{name}: accepts "{p}" but the schema does not declare it')
        for p in schema[name]:
            if p not in sig:
                problems.append(f'{name}: the schema declares "{p}" but the function does not take it')
    for name in schema:
        if name not in app._IMPL:
            problems.append(f'{name}: declared but not implemented')
    assert not problems, '\n'.join(problems)
