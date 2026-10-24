"""The assistant benchmark's harness (plaid-agent/bench) still loads against
this code: every module imports, every task definition loads with its checker,
setup and validation, and every name it takes from plaid_agent exists and is
public (Luke, R20, 2026-10-24).

No model and no core. The bench reaches into the assistant (its plan tools,
its executor, igt's op-kind registry), so a refactor that moves or renames
one of those used to break it silently: caffc4c80 deleted a function the
bench's tagset approval imported, and every test here stayed green.
"""

import ast
import importlib
import importlib.util
import pathlib
import sys

import pytest

BENCH = pathlib.Path(__file__).resolve().parent.parent / 'bench'
APPS = ('igt', 'ud', 'umr')


@pytest.fixture(scope='module')
def bench_path():
    added = [str(BENCH / 'lib'), str(BENCH / 'checks'), str(BENCH)]
    for p in reversed(added):
        sys.path.insert(0, p)
    yield
    for p in added:
        sys.path.remove(p)


def _sources():
    return sorted(p for p in BENCH.rglob('*.py') if '__pycache__' not in p.parts)


def _load(path: pathlib.Path):
    spec = importlib.util.spec_from_file_location('bench_' + path.stem.replace('-', '_').replace('.', '_'), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_harness_modules_import(bench_path):
    for name in ('benchlib', 'gate', 'panel', 'run', 'report', 'rescore', 'validate'):
        importlib.import_module(name)
    for p in sorted((BENCH / 'checks').glob('*.py')):
        importlib.import_module(p.stem)


def test_every_task_loads_with_its_checker_setup_and_validation(bench_path):
    from run import load_checker, load_tasks
    tasks = load_tasks([])
    assert len(tasks) > 100
    for t in tasks:
        path = pathlib.Path(t['_path'])
        assert t['id'] == path.stem and t['app'] == path.parent.name in APPS, path
        assert t.get('project') and t.get('turns'), f'{t["id"]}: a task names a project and its turns'
        assert all(isinstance(turn.get('say'), str) and turn['say'].strip() for turn in t['turns']), t['id']
        assert t.get('as', 'B') in ('A', 'B', 'C'), t['id']
        assert callable(load_checker(t['check'])), t['id']
        setup = path.with_suffix('.setup.py')
        if setup.exists():
            assert callable(getattr(_load(setup), 'setup', None)), setup.name
        validate = path.with_suffix('.validate.py')
        if validate.exists():
            mod = _load(validate)
            assert callable(getattr(mod, 'right', None)), validate.name
            assert any(n.startswith('wrong_') and callable(getattr(mod, n)) for n in dir(mod)), validate.name


def _agent_imports():
    for path in _sources():
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and (node.module or '').split('.')[0] == 'plaid_agent':
                yield path, node.module, [a.name for a in node.names]
            elif isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.split('.')[0] == 'plaid_agent':
                        yield path, a.name, []


def test_the_bench_takes_only_public_names_from_the_assistant_and_they_exist():
    seen, private, missing = 0, [], []
    for path, module, names in _agent_imports():
        seen += 1
        where = f'{path.relative_to(BENCH)}: {module}'
        if any(part.startswith('_') for part in module.split('.')):
            private.append(where)
        mod = importlib.import_module(module)
        for n in names:
            if n.startswith('_'):
                private.append(f'{where}.{n}')
            elif not hasattr(mod, n):
                missing.append(f'{where}.{n}')
    assert seen, 'the walk found the bench imports'
    assert not private, f'the bench imports a private name of plaid_agent: {private}'
    assert not missing, f'the bench imports a name plaid_agent no longer has: {missing}'


def test_no_run_output_or_data_is_in_the_harness_folder():
    # The runs, the code snapshots, the database and the fixture sources live
    # in $PLAID_BENCH_DATA, never in the repository.
    for name in ('runs', 'code', '.llm-slots', '.llm-slots-local'):
        assert not (BENCH / name).exists(), name
    for name in ('src', 'snapshot', 'build'):
        assert not (BENCH / 'fixtures' / name).exists(), f'fixtures/{name}'
