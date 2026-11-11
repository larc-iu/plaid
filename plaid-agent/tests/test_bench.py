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


# --- the reply as the panel shows it -------------------------------------------

UMR_ALIGNMENT_REPLY = (
    '**1. Alignment of s9a2 (after):** word 3, **rchikari**.\n\n'
    '**2. Nodes aligned to no word (0-0):** three\n'
    '- <cite doc="Kukama text 2" ref="s9.s9h"/> have-location-91\n'
    '- <cite doc="Kukama text 2" ref="s9.s9p"/> person\n'
    '- <cite doc="Kukama text 2" ref="s9.s9t"/> thing\n')


def _umr_cite(var):
    return {'key': f'<cite doc="Kukama text 2" ref="s9.{var}"/>', 'document_name': 'Kukama text 2',
            'number': 9, 'sentence': 9, 'focus': [var]}


def test_a_checker_reads_a_cite_as_the_panel_shows_it(bench_path):
    # glm53-1's umr-q-alignment named the three unaligned nodes only in cites,
    # which the panel shows as "Kukama text 2, sentence 9, node s9h", and the
    # checker, which dropped every cite, failed a right answer.
    import common
    import yaml
    item = {'kind': 'assistant', 'text': UMR_ALIGNMENT_REPLY,
            'citations': [_umr_cite(v) for v in ('s9h', 's9p', 's9t')]}
    shown = common.shown_text('umr', item)
    assert 'Kukama text 2, sentence 9, node s9h have-location-91' in shown
    assert '<cite' not in shown
    task = yaml.safe_load((BENCH / 'tasks/umr/umr-q-alignment.yaml').read_text())
    import re
    assert all(re.search(p, shown, re.I | re.S) for p in task['args']['match'])


def test_each_app_titles_a_cite_as_its_panel_does(bench_path):
    import common
    igt = {'text': 'See <cite doc="Lezgi text 1" ref="s2.w3.m1"/> and s4.w1 and s5.',
           'citations': [
               {'key': '<cite doc="Lezgi text 1" ref="s2.w3.m1"/>', 'document_name': 'Lezgi text 1',
                'sentence': 2, 'focus': [{'word': 3, 'morpheme': 1}]},
               {'key': 's4.w1', 'document_name': 'Lezgi text 1', 'sentence': 4,
                'focus': [{'word': 1, 'morpheme': None}, {'word': 2, 'morpheme': 1}]}]}
    assert common.shown_text('igt', igt) == \
        'See Lezgi text 1, sentence 2, word 3, morpheme 1 and Lezgi text 1, sentence 4, words 1, 2 and s5.'
    ud = {'text': '<cite doc="French 1" ref="s1.w6"/>\n{{French 2 s3}}',
          'citations': [{'key': '<cite doc="French 1" ref="s1.w6"/>', 'document_name': 'French 1',
                         'sentence': 1, 'focus': [6]},
                        {'key': '{{French 2 s3}}', 'document_name': 'French 2', 'sentence': 3, 'focus': []}]}
    # a cite alone on its line is a card, whose heading is the same title
    assert common.shown_text('ud', ud) == 'French 1, sentence 1, word 6\nFrench 2, sentence 3'
    umr = {'text': 'Nodes s9.s9h and s9.s9p, sentence s9.', 'citations': [
        {'key': 's9.s9h', 'document_name': 'Kukama text 2', 'number': 9, 'sentence': 9, 'focus': ['s9h', 's9x']}]}
    # an unresolved one reads as the reference it names
    assert common.shown_text('umr', umr) == 'Nodes Kukama text 2, sentence 9, nodes s9h, s9x and s9.s9p, sentence s9.'
    assert common.shown_text('igt', {'text': 'Look at <cite doc="Lezgi text 1" ref="s2"/>.'}) == \
        'Look at Lezgi text 1 s2.'
    assert common.shown_text('ud', {'text': None}) == ''


def test_every_checker_reads_the_reply_through_the_one_reader(bench_path):
    # A checker that strips cites itself reads a reply the user never saw.
    for p in sorted((BENCH / 'checks').glob('*.py')):
        assert '<cite' not in p.read_text() or p.name == 'common.py', p.name


# --- the context window the services are given ---------------------------------

def test_run_takes_a_context_window_per_model(bench_path):
    # glm53-1 could not give glm-5.3-flash its 196608 tokens, and every
    # service logged "Context window: unknown"
    from run import context_windows
    assert context_windows(None, ['glm-5.3-flash']) == {}
    assert context_windows(['glm-5.3-flash=196608', 'qwen3.8-27b=131072'], ['glm-5.3-flash', 'qwen3.8-27b']) == \
        {'glm-5.3-flash': 196608, 'qwen3.8-27b': 131072}
    for bad in (['196608'], ['glm-5.3-flash=big'], ['glm-5.3-flash=0'], ['glm-5.2=196608']):
        with pytest.raises(SystemExit):
            context_windows(bad, ['glm-5.3-flash'])


def test_a_service_is_given_its_models_context_window_and_none_without_one(bench_path):
    from run import service_command
    task = {'app': 'ud', 'service_args': ['--max-steps', 30]}
    cmd = service_command(task, 'glm-5.3-flash', 'http://gate/v1', 'http://core', 'P', 196608)
    assert cmd[cmd.index('--context-window') + 1] == '196608'
    assert cmd[-3:] == ['--max-steps', '30', 'P']
    cmd = service_command(task, 'glm-5.3-flash', 'http://gate/v1', 'http://core', 'P', None)
    assert '--context-window' not in cmd


# --- rescoring a run whose database was not kept ---------------------------------

def test_a_run_that_wrote_nothing_is_rescored_without_its_database(bench_path, tmp_path):
    # glm53-1 kept no database (no --keep-db), so rescore skipped every run,
    # the 35 that wrote nothing too: their database after the run is the
    # snapshot after the task's setup
    from rescore import wrote_nothing
    rd = tmp_path / 'run'
    assert not wrote_nothing(rd), 'no extract: nothing says what the run wrote'
    (rd / 'extract').mkdir(parents=True)
    assert not wrote_nothing(rd)
    (rd / 'extract' / 'units.jsonl').write_text('')
    assert wrote_nothing(rd)
    (rd / 'extract' / 'units.jsonl').write_text('{"kind": "assistant-plan", "counts": {"spans.update": 1}}\n')
    assert not wrote_nothing(rd)
