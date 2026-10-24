"""Tables from the score.json files of a run stamp, as Markdown.

    ./report STAMP [--out FILE]          one stamp
    ./report STAMP_A STAMP_B [--out F]   what changed from A to B

One stamp: per app and model, the success rate, tool calls, failed calls
(and how many were recovered in the same turn), wall time, model time, slot
wait and tokens. Then the failed calls by tool and error class, and one row
per task (passes out of repeats).

A run is flagged "would time out in production" when one of its model
calls went silent for longer than PROD_TIMEOUT_S (120 s): production's model
timeout is a read timeout that every streamed chunk resets (plaid-client-py
workflows/llm.py `_streamed`), so a long call that keeps streaming does not
time out there. The silence of a call is the longer of its wait for the
first chunk and its longest gap after it (`first_chunk_s` and `max_gap_s` in
the run's gate.jsonl, the last attempt only, no slot wait). The bench gives
each call far longer, so a flagged run can pass here and still fail for a
user. The counts are per app and model and per task, and the flagged runs
are listed.

A gate log from before those fields has only the
call's total time. A call of at most 120 s cannot have been silent longer,
and a call that streamed nothing at all was silent the whole time, so both
are judged. A longer call that did stream cannot be judged: it is counted
as "not measured", apart from the flag, and never as a timeout.

A run marked `infra` (it failed while a turn ended on the endpoint's error:
a 429, a 5xx or a timeout that outlasted the gate's retries) is not the
assistant's failure. It is left out of every pass rate and every assistant
measure, counted in its own column, and listed in its own table. `run.py
--rerun-infra STAMP` runs them again.

Storage, per task (rule-shaped plans):
the conversation record's bytes and the tool results prune dropped (the
extractor's conversations.jsonl), the largest undecided plan as stored after
a turn (turns.json `plan_bytes`, written by run.py, blank for runs made
before it), every plan of the final record as stored (settled plans are
compacted), each divided by the changes it proposes, and the approval time.
Bytes are counted as core counts them (run.core_bytes).

Two stamps: per task and model, the pass rate and mean tool calls, failed
calls and wall time in each, the record bytes and settled plan bytes per
change, and the difference.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean

sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
from benchlib import RUNS  # noqa: E402
from gate import infra_of  # noqa: E402
PROD_TIMEOUT_S = 120  # production's model timeout (the bench allows 600)


def scores(stamp):
    d = RUNS / stamp
    if not d.is_dir():
        raise SystemExit(f'no run stamp {stamp}')
    out = []
    for p in sorted(d.glob('*/*/*/score.json')):
        s = json.loads(p.read_text())
        s['_slow'], s['_unmeasured'] = slow_calls(p.parent / 'gate.jsonl')
        if 'infra' not in s:
            s['infra'] = infra_of(s, p.parent / 'gate.jsonl')
        s['_store'] = storage(p.parent)
        out.append(s)
    return out


def core_bytes(value) -> int:
    """The bytes core counts for a value in user data (run.core_bytes)."""
    return len(json.dumps(value, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/'))


def _changes(plan) -> int:
    n = plan.get('proposed_count')
    return int(n) if isinstance(n, int) else len(plan.get('changes') or plan.get('ops') or [])


def _jsonl(p: Path):
    if not p.exists():
        return []
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()]


def storage(run_dir: Path):
    """The run's storage numbers, or None for a value the run did not leave:
    record bytes, tool results dropped, the largest undecided plan (bytes,
    changes), every plan of the final record (bytes, changes), approval
    seconds."""
    convs = _jsonl(run_dir / 'extract' / 'conversations.jsonl')
    out = {'record_bytes': sum(c.get('record_bytes') or 0 for c in convs) if convs else None,
           'dropped': sum(c.get('tool_results_dropped') or 0 for c in convs) if convs else None,
           # Stored beside the record, one round per model call.
           'rounds_bytes': sum(c.get('rounds_bytes') or 0 for c in convs) if convs else None,
           'undecided_bytes': None, 'undecided_changes': None, 'settled_bytes': None,
           'settled_changes': None, 'approve_s': None, 'approve_first_s': None, 'send_first_s': None}
    tp = run_dir / 'turns.json'
    turns = json.loads(tp.read_text()) if tp.exists() else []
    sized = [t for t in turns if isinstance(t.get('plan_bytes'), int)]
    if sized:
        big = max(sized, key=lambda t: t['plan_bytes'])
        out['undecided_bytes'], out['undecided_changes'] = big['plan_bytes'], big.get('plan_changes')
    approvals = [t.get('wall_s') or 0 for t in turns if t.get('kind') == 'approve']
    if approvals:
        out['approve_s'] = round(sum(approvals), 2)
    # The model-free part of a request, until its first progress: an
    # approval's marker and checks, a send's recording of the message
    # (`recorded`), now that the service writes the record alone.
    firsts = [t['first_progress_s'] for t in turns
              if t.get('kind') == 'approve' and isinstance(t.get('first_progress_s'), (int, float))]
    if firsts:
        out['approve_first_s'] = round(sum(firsts), 3)
    sends = [t['first_progress_s'] for t in turns
             if t.get('kind') == 'turn' and isinstance(t.get('first_progress_s'), (int, float))]
    if sends:
        out['send_first_s'] = round(mean(sends), 3)
    rp = run_dir / 'record.json'
    if rp.exists():
        conv = (json.loads(rp.read_text()).get('conversation') or {})
        plans = [d['plan'] for d in conv.get('display') or [] if isinstance(d, dict) and d.get('plan')]
        out['settled_bytes'] = sum(core_bytes(p) for p in plans)
        out['settled_changes'] = sum(_changes(p) for p in plans)
    return out


def per_change(b, n):
    return round(b / n) if isinstance(b, (int, float)) and n else ''


def kb(b):
    return round(b / 1024, 1) if isinstance(b, (int, float)) else ''


def silence_of(rec):
    """The longest silence (s) of one gate record's call, the wait for its
    first chunk included, or None when the log cannot tell (an old record of
    a call over the limit that streamed something)."""
    if 'max_gap_s' in rec:
        first = rec.get('first_chunk_s')  # None: no chunk came, max_gap_s is the whole wait
        return max(rec.get('max_gap_s') or 0, first if isinstance(first, (int, float)) else 0)
    up = rec.get('upstream_s')
    if not isinstance(up, (int, float)):
        return 0
    if up <= PROD_TIMEOUT_S or not rec.get('bytes'):
        return up
    return None


def slow_calls(gate_log: Path):
    """The silences (s) of the run's model calls that were silent longer than
    production allows, and the total times of the calls over the limit whose
    silence the log does not tell (an older gate)."""
    if not gate_log.exists():
        return [], []
    slow, unknown = [], []
    for line in gate_log.read_text().splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        t = silence_of(rec)
        if t is None:
            unknown.append(rec.get('upstream_s'))
        elif t > PROD_TIMEOUT_S:
            slow.append(t)
    return slow, unknown


def slow_cell(runs):
    """Runs flagged as production timeouts, and those an older gate log
    cannot judge, as "N" or "N (+U not measured)"."""
    n = sum(1 for s in runs if s['_slow'])
    u = sum(1 for s in runs if s['_unmeasured'] and not s['_slow'])
    return f'{n} (+{u} not measured)' if u else n


def num(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return mean(xs) if xs else 0


def fmt(x, nd=1):
    return f'{x:.{nd}f}' if isinstance(x, float) else str(x)


def table(headers, rows):
    out = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join('---' for _ in headers) + '|']
    out += ['| ' + ' | '.join(fmt(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out)


def one(stamp):
    ss = scores(stamp)
    lines = [f'# Bench run {stamp}', '']
    meta = RUNS / stamp / 'run.json'
    if meta.exists():
        m = json.loads(meta.read_text())
        lines += [f'Code {m.get("code")}, snapshot built {m.get("snapshot_built")}, models '
                  f'{", ".join(m.get("models") or [])}, {m.get("reps")} repeat(s).', '']
    infra = [s for s in ss if s.get('infra')]
    groups = defaultdict(list)
    for s in ss:
        groups[(s['app'], s['model'])].append(s)
    rows = []
    for (app, model), g0 in sorted(groups.items()):
        g = [s for s in g0 if not s.get('infra')]
        n = len(g)
        rows.append([app, model, n, f'{sum(s["pass"] for s in g)}/{n}', len(g0) - n,
                     sum(1 for s in g if s.get('harness_error')),
                     num([s.get('tool_calls') for s in g]), num([s.get('failed_calls') for s in g]),
                     sum(s.get('recovered_in_turn') or 0 for s in g), num([s.get('turn_wall_s') for s in g]),
                     num([s.get('model_s') for s in g]), num([s.get('gate_wait_s') for s in g]),
                     int(num([s.get('prompt_tokens') for s in g])), int(num([s.get('completion_tokens') for s in g])),
                     slow_cell(g)])
    lines += ['## By app and model', '', table(
        ['app', 'model', 'runs', 'passed', 'infra (not counted)', 'harness errors', 'tool calls (mean)', 'failed calls (mean)',
         'recovered in turn (total)', 'turn wall s (mean)', 'model s (mean)', 'slot wait s (mean)',
         'prompt tokens (mean)', 'completion tokens (mean)',
         f'would time out in production (runs with a call silent over {PROD_TIMEOUT_S} s)'], rows), '']
    if infra:
        lines += ['## Infra runs (not counted)', '',
                  'Failed while a turn ended on the endpoint\'s error. Not the assistant\'s failure. '
                  '`run --rerun-infra STAMP` runs them again.', '',
                  table(['app', 'task', 'model', 'rep', 'endpoint error', 'request errors'],
                        [[s['app'], s['task'], s['model'], s.get('rep'), s['infra'],
                          '; '.join(sorted({e[:80] for e in s.get('request_errors') or []}))] for s in infra]), '']
    ss = [s for s in ss if not s.get('infra')]
    slow = [s for s in ss if s['_slow']]
    if slow:
        lines += ['## Would time out in production', '',
                  f'One model call or more went silent for over {PROD_TIMEOUT_S} s (no chunk streamed), '
                  'production\'s timeout.', '',
                  table(['app', 'task', 'model', 'rep', 'passed here', 'calls silent over the limit',
                         'longest silence s'],
                        [[s['app'], s['task'], s['model'], s.get('rep'), s['pass'], len(s['_slow']),
                          float(max(s['_slow']))] for s in slow]), '']
    unknown = [s for s in ss if s['_unmeasured']]
    if unknown:
        lines += ['## Calls over the limit whose silence was not logged', '',
                  f'These runs come from a gate that logged only each call\'s total time. A call over '
                  f'{PROD_TIMEOUT_S} s that streamed may or may not have gone silent that long, so it is not '
                  'counted as a timeout.', '',
                  table(['app', 'task', 'model', 'rep', 'passed here', 'calls', 'longest call s'],
                        [[s['app'], s['task'], s['model'], s.get('rep'), s['pass'], len(s['_unmeasured']),
                          float(max(s['_unmeasured']))] for s in unknown]), '']
    fails = defaultdict(int)
    for s in ss:
        for tool, by in (s.get('failed_by_tool') or {}).items():
            for cls, k in by.items():
                fails[(s['app'], s['model'], tool, cls)] += k
    if fails:
        lines += ['## Failed calls by tool and error class', '', table(
            ['app', 'model', 'tool', 'error class', 'count'],
            [[*k, v] for k, v in sorted(fails.items(), key=lambda kv: -kv[1])]), '']
    per = defaultdict(list)
    for s in ss:
        per[(s['app'], s['task'], s['model'])].append(s)
    for s in infra:
        per.setdefault((s['app'], s['task'], s['model']), [])
    rows = []
    for (app, task, model), g in sorted(per.items()):
        ends = sorted({e for s in g for e in s.get('turn_ends') or []})
        errs = '; '.join(sorted({(s.get('harness_error') or '')[:80] for s in g if s.get('harness_error')}))
        ninfra = sum(1 for s in infra if (s['app'], s['task'], s['model']) == (app, task, model))
        rows.append([app, task, model, f'{sum(s["pass"] for s in g)}/{len(g)}', ninfra,
                     num([s.get('tool_calls') for s in g]),
                     num([s.get('failed_calls') for s in g]), num([s.get('turn_wall_s') for s in g]),
                     ', '.join(ends), slow_cell(g), errs])
    task_rows, rows = rows, []
    for (app, task, model), g in sorted(per.items()):
        st = [s['_store'] for s in g]
        if not st:
            continue

        def m(k):
            xs = [x[k] for x in st if isinstance(x.get(k), (int, float))]
            return mean(xs) if xs else None
        ub, uc, sb, sc = m('undecided_bytes'), m('undecided_changes'), m('settled_bytes'), m('settled_changes')
        rows.append([app, task, model, kb(m('record_bytes')), kb(m('rounds_bytes')),
                     '' if m('dropped') is None else m('dropped'),
                     kb(ub), '' if uc is None else uc, per_change(ub, uc), kb(sb), '' if sc is None else sc,
                     per_change(sb, sc), '' if m('approve_s') is None else m('approve_s'),
                     '' if m('approve_first_s') is None else round(m('approve_first_s'), 3),
                     '' if m('send_first_s') is None else round(m('send_first_s'), 3)])
    lines += ['## Storage', '',
              'Means over the counted runs. KB as core counts them. The undecided plan is the largest one a turn '
              'left. Settled is every plan of the final record.', '',
              table(['app', 'task', 'model', 'record KB', 'rounds KB', 'tool results dropped', 'undecided plan KB',
                     'its changes', 'B per change', 'plans in record KB', 'their changes', 'B per change',
                     'approval s', 'approval until started s', 'send until recorded s'], rows), '']
    lines += ['## Tasks', '', table(['app', 'task', 'model', 'passed', 'infra', 'tool calls', 'failed calls',
                                     'turn wall s', 'turn ends', 'would time out in production', 'harness error'],
                                    task_rows), '']
    return '\n'.join(lines)


def two(a, b):
    def agg(stamp):
        g = defaultdict(list)
        for s in scores(stamp):
            g[(s['task'], s['model'])].append(s)
        out = {}
        for k, v0 in g.items():
            v = [s for s in v0 if not s.get('infra')]
            out[k] = {'pass': sum(s['pass'] for s in v) / len(v) if v else '', 'n': len(v),
                      'infra': len(v0) - len(v), 'calls': num([s.get('tool_calls') for s in v]),
                      'failed': num([s.get('failed_calls') for s in v]), 'wall': num([s.get('turn_wall_s') for s in v]),
                      'slow': slow_cell(v),
                      'record': num([s['_store'].get('record_bytes') for s in v]),
                      'per': num([per_change(s['_store'].get('settled_bytes'), s['_store'].get('settled_changes'))
                                  for s in v])}
        return out
    A, B = agg(a), agg(b)
    rows = []
    for k in sorted(set(A) | set(B)):
        x, y = A.get(k), B.get(k)

        def cell(r, f):
            return '' if r is None else r[f]

        def delta(f):
            if x is None or y is None or x[f] == '' or y[f] == '':
                return ''
            return y[f] - x[f]
        rows.append([k[0], k[1], cell(x, 'pass'), cell(y, 'pass'), delta('pass'), cell(x, 'calls'), cell(y, 'calls'),
                     cell(x, 'failed'), cell(y, 'failed'), delta('failed'), cell(x, 'wall'), cell(y, 'wall'),
                     cell(x, 'slow'), cell(y, 'slow'), cell(x, 'infra'), cell(y, 'infra'),
                     kb(cell(x, 'record')), kb(cell(y, 'record')), cell(x, 'per'), cell(y, 'per')])
    return '\n'.join([f'# Bench diff {a} -> {b}', '', table(
        ['task', 'model', f'pass {a}', f'pass {b}', 'Δ pass', f'calls {a}', f'calls {b}', f'failed {a}',
         f'failed {b}', 'Δ failed', f'wall {a}', f'wall {b}', f'prod timeouts {a}', f'prod timeouts {b}',
         f'infra {a}', f'infra {b}', f'record KB {a}', f'record KB {b}', f'plan B per change {a}',
         f'plan B per change {b}'],
        rows), ''])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stamps', nargs='+')
    ap.add_argument('--out')
    a = ap.parse_args()
    text = one(a.stamps[0]) if len(a.stamps) == 1 else two(*a.stamps[:2])
    if a.out:
        Path(a.out).write_text(text)
    else:
        sys.stdout.write(text)


if __name__ == '__main__':
    main()
