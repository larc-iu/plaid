"""Score kept runs again with the task's current checker, without the model.

    ./rescore STAMP TASK [TASK ...]

For a task whose checker was found too strict after a run (and fixed and
validated again), on runs made with --keep-db. For each repeat of TASK in
STAMP: the task's setup is run again on a fresh copy of the snapshot, only to
rebuild what the checker records at the start (the lexicon, the guidelines),
then a core is started on the run's own kept database and the checker is run
with the run's conversation and its saved baseline. The old result is kept in
score.json as `pass_as_run` and `measures_as_run`, the new one replaces
`pass` and `measures`, and `rescored` says when and why.
"""
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'lib'))
sys.path.insert(0, str(HERE / 'checks'))
sys.path.insert(0, str(HERE))
import benchlib as bl  # noqa: E402
from run import load_checker, load_tasks, run_setup  # noqa: E402


def main():
    stamp, names = sys.argv[1], sys.argv[2:]
    sd = bl.RUNS / stamp
    meta = json.loads((sd / 'run.json').read_text())
    code = bl.use_code(meta['code'])
    from plaid_client import PlaidClient
    man = bl.manifest()
    for task in load_tasks(names):
        check = load_checker(task['check'])
        project = man['projects'][task['project']]
        who = task.get('as', 'B')
        for rd in sorted((sd / task['id']).glob('*/*')):
            if not (rd / 'db' / 'plaid.db').exists():
                print(f'{rd}: no kept database, skipped')
                continue
            start = SimpleNamespace(project=project, task=task, args=task.get('args') or {}, app=task['app'],
                                    manifest=man, turns=[], baseline_dir=None)
            with tempfile.TemporaryDirectory(dir=bl.DATA) as tmp:
                tmp = Path(tmp)
                bl.copy_db(bl.SNAPSHOT, tmp / 'db')
                core = bl.Core(code, tmp / 'db', tmp / 'core.log').start()
                try:
                    start.client = PlaidClient(core.url, man['tokens']['A'])
                    start.user = PlaidClient(core.url, man['tokens'][who])
                    run_setup(task, start, tmp / 'baseline')
                finally:
                    core.stop()
            core = bl.Core(code, rd / 'db', rd / 'rescore-core.log').start()
            try:
                rec = json.loads((rd / 'record.json').read_text())
                ctx = SimpleNamespace(client=PlaidClient(core.url, man['tokens']['A']),
                                      user=PlaidClient(core.url, man['tokens'][who]), manifest=man,
                                      project=project, task=task, args=task.get('args') or {}, app=task['app'],
                                      turns=json.loads((rd / 'turns.json').read_text()),
                                      baseline_dir=(rd / 'baseline') if (rd / 'baseline').is_dir() else None,
                                      conversation=rec['conversation'], meta=rec.get('meta'))
                for k in ('lex_baseline', 'guidelines_baseline'):
                    if hasattr(start, k):
                        setattr(ctx, k, getattr(start, k))
                got = check(ctx)
            finally:
                core.stop()
            sp = rd / 'score.json'
            s = json.loads(sp.read_text())
            s.setdefault('pass_as_run', s['pass'])
            s.setdefault('measures_as_run', s.get('measures'))
            s['pass'] = bool(got.get('pass'))
            s['measures'] = got.get('measures', {})
            s['rescored'] = {'at': datetime.now().isoformat(timespec='seconds'),
                             'why': 'checker changed after the run, see the task file'}
            sp.write_text(json.dumps(s, ensure_ascii=False, indent=1, default=str))
            if not (rd / 'check_as_run.json').exists():
                (rd / 'check.json').rename(rd / 'check_as_run.json')
            (rd / 'check.json').write_text(json.dumps(got, ensure_ascii=False, indent=1, default=str))
            print(f'{task["id"]} {rd.parent.name}/{rd.name}: as run {s["pass_as_run"]}, now {s["pass"]} '
                  f'{got.get("measures")}')


if __name__ == '__main__':
    main()
