"""Validate a task's checker without a model: write the right result by
hand and the checker must pass, write each wrong one and it must fail.

    ./validate TASK [TASK ...]

A task `tasks/<app>/<id>.yaml` is validated by `tasks/<app>/<id>.validate.py`,
which defines `right(ctx)`, any number of other right results `right_<name>(ctx)`
and any number of `wrong_<name>(ctx)`. Each runs on
its own fresh copy of the snapshot, on a private core, with:

  ctx.client   admin A's client       ctx.user   the task's user (default B)
  ctx.project  the manifest entry      ctx.args   the task's checker args
  ctx.app, ctx.task, ctx.manifest

A task's `<id>.setup.py`, when there is one, runs first, as in a real run.
A function writes through the API (checks/handwrite.py has helpers that stamp
what an approved plan stamps) and returns the conversation the checker should
see (handwrite.applied_plan() for a plan applied, handwrite.no_plan() for a
turn that wrote nothing), or None for applied_plan().
"""
import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'lib'))
sys.path.insert(0, str(HERE / "checks"))
sys.path.insert(0, str(HERE))
import benchlib as bl  # noqa: E402
from run import load_checker, load_tasks, run_setup  # noqa: E402


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace('.', '_'), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    code = bl.use_code()
    from plaid_client import PlaidClient
    import handwrite
    man = bl.manifest()
    bad = 0
    for task in load_tasks(sys.argv[1:]):
        vpath = Path(task['_path']).with_suffix('.validate.py')
        if not vpath.exists():
            print(f'{task["id"]}: no {vpath.name}')
            bad += 1
            continue
        mod = load(vpath)
        fns = [('right', mod.right)] + [(n, getattr(mod, n)) for n in sorted(dir(mod))
                                        if n.startswith('right_') or n.startswith('wrong_')]
        check = load_checker(task['check'])
        project = man['projects'][task['project']]
        for name, fn in fns:
            with tempfile.TemporaryDirectory(dir=bl.DATA) as tmp:
                tmp = Path(tmp)
                bl.copy_db(bl.SNAPSHOT, tmp / 'db')
                core = bl.Core(code, tmp / 'db', tmp / 'core.log').start()
                try:
                    who = task.get('as', 'B')
                    ctx = SimpleNamespace(client=PlaidClient(core.url, man['tokens']['A']),
                                          user=PlaidClient(core.url, man['tokens'][who]), manifest=man,
                                          project=project, task=task, args=task.get('args') or {},
                                          app=task['app'], turns=[], meta={}, baseline_dir=None)
                    ctx.baseline_dir = run_setup(task, ctx, tmp / 'baseline')
                    conv = fn(ctx)
                    ctx.conversation = conv if conv is not None else handwrite.applied_plan()
                    got = check(ctx)
                except Exception as e:  # noqa: BLE001
                    got = {'pass': None, 'measures': {'error': f'{type(e).__name__}: {e}'}}
                    shutil.copy(tmp / 'core.log', bl.DATA / f'validate-{task["id"]}-{name}.core.log')
                finally:
                    core.stop()
            want = name == 'right' or name.startswith('right_')
            ok = got.get('pass') is want
            bad += not ok
            print(f'{"ok  " if ok else "BAD "} {task["id"]} {name}: pass={got.get("pass")} {got.get("measures")}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
