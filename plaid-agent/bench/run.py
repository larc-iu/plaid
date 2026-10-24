"""Run benchmark tasks: task x model x repeat, each on its own copy of the
snapshot database, its own core and its own assistant process.

    ./run [TASK ...] [--models glm-5.2] [--reps 1] [--jobs 1] [--stamp NAME] [--keep-db]
    ./run --rerun-infra STAMP [--jobs 1]

TASK is a task id (`igt-smoke-gloss`), an app (`igt`), or a path to a task
yaml. With none, every task under tasks/ runs.

Each run writes runs/<stamp>/<task>/<model>/<rep>/:
  score.json      the checker's verdict and measures, plus the run's numbers
  record.json     the conversation record (transcript and what the user saw)
  turns.json      each request: its result, error and wall time
  check.json      the checker's full answer
  gate.jsonl      every model request: slot wait, upstream time, tokens
  extract/        plaid_agent.research.extract on the run database
  core.log, service.log
The database copy is removed after extraction unless --keep-db.

The model endpoint ($PLAID_BENCH_UPSTREAM) is reached only through
lib/gate.py, which holds the key (read from $PLAID_BENCH_KEY_FILE inside
this process, never printed or passed on) and
caps requests in flight at 1 and requests per minute at 8 across every bench
process, and tries a 429 or a 5xx again for up to 10 minutes.

A run that failed while a turn of it ended on the endpoint's error (a 429, a
5xx or a timeout that outlasted the gate's retries) is marked `infra` in
score.json. report.py counts infra runs apart from the assistant's failures.
`--rerun-infra STAMP` runs the infra runs of STAMP again in place, moving
each old one to STAMP/_infra/<task>/<model>/<rep>.<n>/.
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'lib'))
import benchlib as bl  # noqa: E402
from gate import Gate, infra_of, infra_reason  # noqa: E402

import yaml  # noqa: E402

DEFAULT_MODELS = ['glm-5.2']
SERVICE_TIMEOUT_S = 1500  # per model call; a call may wait for a slot, the rate cap and 429 retries first
PRINT = threading.Lock()


def say(*a):
    with PRINT:
        print(*a, flush=True)


def load_tasks(names):
    paths = sorted((HERE / 'tasks').glob('*/*.yaml'))
    if names:
        chosen = []
        for n in names:
            p = Path(n)
            if p.suffix == '.yaml' and p.exists():
                chosen.append(p.resolve())
            elif (HERE / 'tasks' / n).is_dir():
                chosen += sorted((HERE / 'tasks' / n).glob('*.yaml'))
            else:
                hit = [q for q in paths if q.stem == n]
                if not hit:
                    raise SystemExit(f'no task {n}')
                chosen += hit
        paths = chosen
    tasks = []
    for p in paths:
        t = yaml.safe_load(p.read_text())
        t.setdefault('id', p.stem)
        t.setdefault('app', p.parent.name)
        t['_path'] = str(p)
        tasks.append(t)
    return tasks


def load_checker(name):
    path = HERE / 'checks' / f'{name}.py'
    spec = importlib.util.spec_from_file_location(f'checks.{name}', path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HERE / 'checks'))
    spec.loader.exec_module(mod)
    return mod.check


def run_setup(task, ctx, out_dir: Path):
    """The task's own starting state: `tasks/<app>/<id>.setup.py`, whose
    `setup(ctx)` writes through the API (ctx.client is admin A, ctx.user the
    task's user) before the assistant starts. Every document of the project
    is then saved to out_dir as the baseline the checker diffs against."""
    sys.path.insert(0, str(HERE / 'checks'))
    import common
    path = Path(task['_path']).with_suffix('.setup.py')
    if not path.exists():
        common.guideline_snap(ctx)
        return None
    spec = importlib.util.spec_from_file_location(f'setup_{task["id"]}'.replace('-', '_'), path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HERE / 'checks'))
    spec.loader.exec_module(mod)
    mod.setup(ctx)
    common.guideline_snap(ctx)
    out_dir.mkdir(parents=True, exist_ok=True)
    for d in ctx.project['documents']:
        body = ctx.client.documents.get(d['id'], include_body=True)
        (out_dir / f'{d["id"]}.json').write_text(json.dumps(body, ensure_ascii=False))
    return out_dir


def resolve_where(task, project, turn):
    w = turn.get('where', task.get('where'))
    if not w:
        return None
    if 'document' in w:
        d = next((d for d in project['documents'] if d['name'] == w['document']), None)
        if not d:
            raise SystemExit(f'{task["id"]}: no document {w["document"]!r} in {project["name"]}')
        return {'kind': 'document', 'id': d['id'], 'name': d['name']}
    if 'lexicon' in w:
        v = next((v for v in project['vocabs'] if v['name'] == w['lexicon']), None)
        if not v:
            raise SystemExit(f'{task["id"]}: no vocabulary {w["lexicon"]!r} in {project["name"]}')
        return {'kind': 'lexicon', 'id': v['id'], 'name': v['name']}
    raise SystemExit(f'{task["id"]}: where must name a document or a lexicon')


def core_bytes(value) -> int:
    """The bytes core counts for a value in user data: clojure.data.json
    escapes every non-ASCII character and every slash, with no spaces."""
    return len(json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/'))


def plan_changes(plan) -> int:
    """How many changes a stored plan proposes: its proposed_count, else its
    rows."""
    n = plan.get('proposed_count')
    return int(n) if isinstance(n, int) else len(plan.get('changes') or plan.get('ops') or [])


def summarize_extract(ext: Path, gate_log: Path, since: float = 0):
    def rows(name):
        p = ext / name
        return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []
    calls = rows('tool_calls.jsonl')
    turns = rows('turns.jsonl')
    failed = [c for c in calls if c.get('failed')]
    by = {}
    for c in failed:
        by.setdefault(c.get('tool'), {}).setdefault(c.get('error_class') or 'other', 0)
        by[c['tool']][c.get('error_class') or 'other'] += 1
    tools = {}
    for c in calls:
        tools[c.get('tool')] = tools.get(c.get('tool'), 0) + 1
    gate = [json.loads(x) for x in gate_log.read_text().splitlines()] if gate_log.exists() else []
    # The service's startup ping is not part of any turn.
    gate = [g for g in gate if g.get('at', 0) >= since]
    usage = [g.get('usage') or {} for g in gate]
    infra = [g.get('infra') or infra_reason(g.get('status'), g.get('error')) for g in gate]
    infra = [x for x in infra if x]
    return {
        'turn_ends': [t.get('end') for t in turns],
        'tool_calls': len(calls),
        'tools': tools,
        'failed_calls': len(failed),
        'failed_by_tool': by,
        'recovered_in_turn': sum(1 for c in failed if c.get('recovered_in_turn')),
        'model_calls': len(gate),
        'model_errors': sum(1 for g in gate if g.get('status') != 200),
        'prompt_tokens': sum(u.get('prompt_tokens') or 0 for u in usage),
        'completion_tokens': sum(u.get('completion_tokens') or 0 for u in usage),
        'gate_wait_s': round(sum(g.get('wait_s') or 0 for g in gate), 1),
        'rate_wait_s': round(sum(g.get('rate_wait_s') or 0 for g in gate), 1),
        'backoff_s': round(sum(g.get('backoff_s') or 0 for g in gate), 1),
        'gate_retries': sum((g.get('attempts') or 1) - 1 for g in gate),
        'endpoint_errors': infra,
        'model_s': round(sum(g.get('upstream_s') or 0 for g in gate), 1),
    }


def run_one(task, model, rep, stamp_dir: Path, gate: Gate, code: Path, man, keep_db=False):
    rd = stamp_dir / task['id'] / model / str(rep)
    rd.mkdir(parents=True, exist_ok=True)
    tag = re.sub(r'[^A-Za-z0-9._-]', '_', f'{stamp_dir.name}.{task["id"]}.{model}.{rep}')
    gate.logs[tag] = rd / 'gate.jsonl'
    project = man['projects'][task['project']]
    score = {'task': task['id'], 'app': task['app'], 'model': model, 'rep': rep, 'pass': False,
             'harness_error': None, 'started': datetime.now().isoformat(timespec='seconds')}
    t0 = time.time()
    core = svc = None
    turns = []
    from plaid_client import PlaidClient
    from panel import Panel, wait_for_service
    try:
        bl.copy_db(bl.SNAPSHOT, rd / 'db')
        core = bl.Core(code, rd / 'db', rd / 'core.log').start()
        who = task.get('as', 'B')
        admin = PlaidClient(core.url, man['tokens']['A'])
        user = PlaidClient(core.url, man['tokens'][who])
        ctx = SimpleNamespace(client=admin, user=user, manifest=man, project=project, task=task,
                              args=task.get('args') or {}, app=task['app'], turns=turns, baseline_dir=None)
        ctx.baseline_dir = run_setup(task, ctx, rd / 'baseline')
        sd = rd / 'svc'
        sd.mkdir(exist_ok=True)
        (sd / '.token').write_text(man['tokens']['A'])
        env = dict(os.environ)
        env['PYTHONPATH'] = f'{code / "plaid-agent/src"}:{code / "plaid-client-py/src"}'
        env['OPENAI_API_KEY'] = 'bench-gate-holds-the-key'
        cmd = [str(bl.AGENT_PY), '-m', f'plaid_agent.{task["app"]}.service', '--url', core.url,
               '--model', f'openai/{model}', '--api-base', gate.base(tag), '--timeout', str(SERVICE_TIMEOUT_S),
               *[str(x) for x in task.get('service_args') or []], project['id']]
        svc = subprocess.Popen(cmd, cwd=sd, env=env, stdout=open(rd / 'service.log', 'ab'),
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        service = wait_for_service(user, project['id'], task['app'], timeout=600)
        score['service_id'] = service['service_id']
        panel = Panel(user, man['users'][who], project['id'], task['app'], service,
                      timeout_s=task.get('max_wall_s', 1800), code=code)
        for i, turn in enumerate(task['turns'], 1):
            where = resolve_where(task, project, turn)
            r = panel.turn(turn['say'], where)
            r['n'] = i
            r['kind'] = 'turn'
            item = panel.last_plan()
            r['plan_id'] = item['plan']['id'] if item else None
            if item:
                # The undecided plan as stored, measured as core measures it
                # (report.py's plan bytes). Settled, it is compacted.
                r['plan_bytes'] = core_bytes(item['plan'])
                r['plan_changes'] = plan_changes(item['plan'])
            turns.append(r)
            say(f'  {task["id"]}/{model}/{rep} turn {i}: {r["wall_s"]}s'
                f'{" plan" if item else ""}{" ERROR " + r["error"][:120] if r["error"] else ""}')
            # approve: open approves the conversation's open plan when this
            # turn made none (a turn 2 that finds turn 1 already did it).
            if turn.get('approve') == 'open' and not item:
                item = panel.open_plan()
            if turn.get('approve') and item and item.get('status') is None:
                a = panel.approve(item['plan']['id'], as_human=bool(turn.get('as_human')))
                a['n'] = i
                a['kind'] = 'approve'
                turns.append(a)
                say(f'  {task["id"]}/{model}/{rep} approve {i}: {a["wall_s"]}s'
                    f'{" ERROR " + a["error"][:120] if a["error"] else ""}')
        conv, meta = panel.load()
        (rd / 'record.json').write_text(json.dumps({'conversation_id': panel.conv_id, 'meta': meta,
                                                    'conversation': conv}, ensure_ascii=False, indent=1))
        ctx.conversation, ctx.meta = conv, meta
        check = load_checker(task['check'])(ctx)
        (rd / 'check.json').write_text(json.dumps(check, ensure_ascii=False, indent=1, default=str))
        score['pass'] = bool(check.get('pass'))
        score['measures'] = check.get('measures', {})
    except Exception as e:  # noqa: BLE001
        score['harness_error'] = f'{type(e).__name__}: {e}'
        (rd / 'harness_error.txt').write_text(traceback.format_exc())
    finally:
        bl.kill_group(svc)
        if core:
            core.stop()
        (rd / 'turns.json').write_text(json.dumps(turns, ensure_ascii=False, indent=1, default=str))
    score['wall_s'] = round(time.time() - t0, 1)
    score['turn_wall_s'] = round(sum(t.get('wall_s') or 0 for t in turns), 1)
    score['request_errors'] = [t['error'] for t in turns if t.get('error')]
    try:
        if (rd / 'db/plaid.db').exists():
            r = subprocess.run([str(bl.AGENT_PY), '-m', 'plaid_agent.research.extract', str(rd / 'db/plaid.db'),
                                str(rd / 'extract'), '--salt-file', str(stamp_dir / '.salt'), '--project',
                                project['id'], '--keep-project-names', '--include-text', '--quiet'],
                               capture_output=True, text=True,
                               env=dict(os.environ, PYTHONPATH=f'{code / "plaid-agent/src"}:'
                                                              f'{code / "plaid-client-py/src"}'))
            if r.returncode:
                score['extract_error'] = r.stderr[-1000:]
        first = min((t['started'] for t in turns if t.get('started')), default=time.time())
        score.update(summarize_extract(rd / 'extract', rd / 'gate.jsonl', since=first - 0.5))
    except Exception as e:  # noqa: BLE001
        score['extract_error'] = f'{type(e).__name__}: {e}'
    score['infra'] = infra_of(score)
    if not keep_db:
        for name in ('plaid.db', 'plaid.db-wal', 'plaid.db-shm'):
            if (rd / 'db' / name).exists():
                os.remove(rd / 'db' / name)
    (rd / 'score.json').write_text(json.dumps(score, ensure_ascii=False, indent=1, default=str))
    gate.logs.pop(tag, None)
    say(f'{"PASS" if score["pass"] else ("INFRA" if score["infra"] else "FAIL")} {task["id"]} {model} rep {rep}  {score["wall_s"]}s'
        f'  calls {score.get("tool_calls")} failed {score.get("failed_calls")}'
        f'{"  HARNESS " + score["harness_error"] if score["harness_error"] else ""}')
    return score


def infra_runs(sd: Path):
    """(task id, model, rep, run dir) of every infra run in a stamp. A
    score.json written before the field existed is judged from its gate log."""
    out = []
    for p in sorted(sd.glob('*/*/*/score.json')):
        s = json.loads(p.read_text())
        if 'infra' not in s:
            s['infra'] = infra_of(s, p.parent / 'gate.jsonl')
        if s['infra']:
            out.append((s['task'], s['model'], int(s['rep']), p.parent))
    return out


LOCAL_SLOT_DIR = bl.DATA / '.llm-slots-local'


def make_gate(local_api=None, local_slots=4):
    """The endpoint's gate (the key, 1 in flight, 8 a minute across every bench
    process), or for a local model server a gate of its own: no key, its own
    slot directory and in-flight cap, no per-minute cap. A local model never
    goes through the endpoint's gate and its limits."""
    if local_api:
        return Gate('', upstream=local_api, slot_dir=LOCAL_SLOT_DIR, rpm=10 ** 6, slots=local_slots).start()
    return Gate.from_env().start()


def rerun_infra(stamp, jobs, code_arg, keep_db):
    sd = bl.RUNS / stamp
    if not sd.is_dir():
        raise SystemExit(f'no run stamp {stamp}')
    found = infra_runs(sd)
    if not found:
        say(f'{stamp}: no infra runs')
        return
    code = bl.use_code(code_arg or json.loads((sd / 'run.json').read_text()).get('code'))
    man = bl.manifest()
    tasks = {t['id']: t for t in load_tasks(sorted({f[0] for f in found}))}
    jobs_ = []
    for tid, model, rep, rd in found:
        n = 1
        while (sd / '_infra' / tid / model / f'{rep}.{n}').exists():
            n += 1
        dest = sd / '_infra' / tid / model / f'{rep}.{n}'
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(rd), str(dest))
        jobs_.append((tasks[tid], model, rep))
    meta = json.loads((sd / 'run.json').read_text()) if (sd / 'run.json').exists() else {}
    meta.setdefault('reruns', []).append({'at': datetime.now().isoformat(timespec='seconds'), 'code': code.name,
                                          'runs': [f'{t["id"]}/{m}/{r}' for t, m, r in jobs_]})
    (sd / 'run.json').write_text(json.dumps(meta, indent=1))
    gate = Gate.from_env().start()
    say(f'stamp {stamp}: rerunning {len(jobs_)} infra runs, code {code.name}')
    try:
        with ThreadPoolExecutor(max_workers=max(1, jobs)) as ex:
            list(ex.map(lambda j: run_one(*j, sd, gate, code, man, keep_db), jobs_))
    finally:
        gate.stop()
    say(f'done: {sd}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tasks', nargs='*')
    ap.add_argument('--rerun-infra', metavar='STAMP', help='run the infra runs of STAMP again, in place')
    ap.add_argument('--models', default=','.join(DEFAULT_MODELS))
    ap.add_argument('--reps', type=int, default=1)
    ap.add_argument('--jobs', type=int, default=1, help='runs at once (the gate still allows 2 model calls)')
    ap.add_argument('--stamp', default=None)
    ap.add_argument('--code', default=None, help='a code/<sha> to run instead of code/CURRENT')
    ap.add_argument('--keep-db', action='store_true')
    a = ap.parse_args()
    if a.rerun_infra:
        if a.tasks:
            raise SystemExit('--rerun-infra takes no task names')
        return rerun_infra(a.rerun_infra, a.jobs, a.code, a.keep_db)
    code = bl.use_code(a.code)
    man = bl.manifest()
    tasks = load_tasks(a.tasks)
    models = [m.strip() for m in a.models.split(',') if m.strip()]
    stamp = a.stamp or datetime.now().strftime('%Y%m%d-%H%M%S')
    sd = bl.RUNS / stamp
    sd.mkdir(parents=True, exist_ok=True)
    (sd / 'run.json').write_text(json.dumps({
        'code': code.name, 'snapshot_built': man['built_at'], 'importers_commit': man['importers_commit'],
        'models': models, 'reps': a.reps, 'tasks': [t['id'] for t in tasks], 'argv': sys.argv[1:],
        'started': datetime.now().isoformat(timespec='seconds')}, indent=1))
    gate = Gate.from_env().start()
    say(f'stamp {stamp}: {len(tasks)} tasks x {len(models)} models x {a.reps} reps, code {code.name}')
    jobs = [(t, m, r) for t in tasks for m in models for r in range(1, a.reps + 1)]
    try:
        with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
            list(ex.map(lambda j: run_one(*j, sd, gate, code, man, a.keep_db), jobs))
    finally:
        gate.stop()
    say(f'done: {sd}')


if __name__ == '__main__':
    main()
