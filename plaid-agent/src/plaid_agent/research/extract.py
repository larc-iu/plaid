"""Extract the research dataset from a Plaid SQLite database.

    python -m plaid_agent.research.extract DB OUT --salt-file SALT [--project ID ...]

DB is opened read-only (``mode=ro`` and ``query_only``), never written. With
no ``--project`` every project with assistant use is taken: a conversation
record, or an operation an approved plan wrote. OUT receives the dataset
(see DATASET.md, copied there as README.md). SALT is where the pseudonym key
is kept, and must be outside OUT.
"""

import argparse
import json
import shutil
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any, Dict, List, Optional

from . import fates as F
from .pseudo import Pseudonyms, load_salt
from .records import Conversations, iter_records, seconds_between

EXTRACTOR_VERSION = '6'
HERE = Path(__file__).parent


def open_ro(path: str) -> sqlite3.Connection:
    p = Path(path).resolve()
    if not p.is_file():
        raise SystemExit(f'No database at {p}')
    db = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
    db.execute('PRAGMA query_only = ON')
    return db


def latest(db) -> Optional[str]:
    """The horizon: the latest time the database holds, from the audit log,
    the user data (conversation records) and the client events. Nothing
    happened between the last of them and the copy that the database could
    have recorded, but the copy's own time is not in it."""
    from .records import parse_ts
    found = [db.execute(q).fetchone()[0] for q in ('SELECT max(ts) FROM audit_writes',
                                                   'SELECT max(updated_at) FROM user_data',
                                                   'SELECT max(ts) FROM client_events')]
    found = [t for t in found if parse_ts(t)]
    return max(found, key=parse_ts) if found else None


def assistant_projects(db) -> List[str]:
    """Projects with assistant use: a conversation record, or an operation
    an approved plan wrote (tagged, or labelled as the assistant labels)."""
    found = set()
    for (key,) in db.execute("SELECT key FROM user_data WHERE key LIKE '%:assistant:%'"):
        parts = key.split(':')
        if len(parts) >= 3:
            found.add(parts[2])
    for (pid,) in db.execute(
            "SELECT DISTINCT o.project_id FROM operation_groups g JOIN operations o ON o.group_id = g.id "
            "WHERE (g.kind = 'assistant-plan' OR g.message LIKE 'Assistant: %' "
            "OR g.message LIKE 'Assistant, partly applied: %') AND o.project_id IS NOT NULL"):
        found.add(pid)
    live = {r[0] for r in db.execute('SELECT id FROM projects')}
    return sorted(found & live) + sorted(found - live)


def link_plans(conv: Conversations, fates: F.Fates) -> Dict[str, Any]:
    """Each applied (or partly applied) plan's operation, by the plan id its
    reference names, else (before references were recorded) by its label,
    owner and project: the earliest unclaimed assistant operation labelled
    with the plan's summary that started after the plan was proposed."""
    units = fates.units
    by_plan = {u['plan_id']: u for u in units.values() if u['kind'] == 'assistant-plan' and u.get('plan_id')}
    legacy = sorted((u for u in units.values() if u['kind'] == 'assistant-plan' and not u.get('plan_id')),
                    key=lambda u: u['started_at'])
    claimed = set()
    writes_by_unit: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for w in fates.writes:
        writes_by_unit[w['unit_id']].append(w)
    for plan in conv.plans:
        if plan['status'] not in ('applied', 'partial') and not plan['interrupted']:
            continue
        unit = by_plan.get(plan['plan_id'])
        how = 'ref' if unit else None
        if unit is None:
            owner = conv.owner_of_plan.get(plan['plan_id'])
            summary = conv.summary_of_plan.get(plan['plan_id']) or ''
            for u in legacy:
                if u['unit_id'] in claimed or u['project_id'] != plan['project_id'] or u['_user_id'] != owner:
                    continue
                msg = u.get('_message') or ''
                if msg != f'Assistant: {summary}' and not msg.startswith('Assistant, partly applied: '):
                    continue
                if plan['proposed_at'] and (seconds_between(plan['proposed_at'], u['started_at']) or 0) < 0:
                    continue
                unit, how = u, 'label'
                break
        if unit is None:
            continue
        claimed.add(unit['unit_id'])
        unit['plan_found'] = True
        plan['group_id'], plan['group_link'] = unit['unit_id'], how
        plan['writes'] = sum(unit['counts'].values())
        if not plan['settled_at']:
            plan['settled_at'] = unit['started_at']
            plan['settled_at_source'] = 'audit_group_start'
            plan['seconds_to_settle'] = seconds_between(plan['proposed_at'], plan['settled_at'])
    # An applied plan's operation whose plan no record holds: its
    # conversation was deleted, which deletes its plans (the person's choice).
    # The operation keeps its kind and reference.
    conversations = {c['conversation_id'] for c in conv.conversations}
    for u in units.values():
        if u['kind'] != 'assistant-plan':
            continue
        u.setdefault('plan_found', False)
        if u['plan_found']:
            u['plan_record'] = 'found'
        elif u.get('conversation_id') and u['conversation_id'] in conversations:
            u['plan_record'] = 'missing'
        else:
            u['plan_record'] = 'deleted'
    for u in units.values():
        u.setdefault('plan_record', None)
    # Each proposed change: whether the plan's operation wrote it, and what
    # became of that write. A change names what it targets (a word, a
    # span), and a write is matched when it is that entity or is about it
    # (`fates.Fates._anchors`).
    plan_unit = {p['plan_id']: p['group_id'] for p in conv.plans if p['group_id']}
    for c in conv.plan_changes:
        uid = plan_unit.get(c['plan_id'])
        if not uid or not c['target']:
            continue
        ws = writes_by_unit.get(uid, ())
        # The entity itself first, then what the change left in place
        # before what it removed (a new head's relation before the old one).
        hits = sorted((w for w in ws if w['target_id'] == c['target'] or c['target'] in w.get('_anchors', ())),
                      key=lambda w: (w['target_id'] != c['target'], w['written_change'] == 'delete'))
        c['target_written'] = bool(hits)
        c['matched_writes'] = len(hits)
        c['fate'] = hits[0]['fate'] if hits else None
        c['fates'] = dict(Counter(w['fate'] for w in hits))
    return {'linked_by_ref': sum(1 for p in conv.plans if p['group_link'] == 'ref'),
            'linked_by_label': sum(1 for p in conv.plans if p['group_link'] == 'label'),
            'applied_unlinked': sum(1 for p in conv.plans
                                    if p['status'] in ('applied', 'partial') and not p['group_id']),
            'operations_without_plan': sum(1 for u in units.values()
                                           if u['kind'] == 'assistant-plan' and not u.get('plan_found')),
            'operations_plan_deleted': sum(1 for u in units.values() if u.get('plan_record') == 'deleted')}


def _v7_at(value: Any) -> Optional[int]:
    """A UUIDv7's millisecond and counter as one number (as
    ``plaid_client.ids.drawn_uuid7`` counts them), else None."""
    import uuid
    try:
        u = uuid.UUID(str(value))
    except ValueError:
        return None
    if u.version != 7:
        return None
    top = u.int >> 64
    return ((top >> 16) << 12) + (top & 0xFFF)


# How many ids after its own a plan's creates may reach: far more than the
# largest plan (MAX ops) draws.
DRAWN_MAX = 1 << 20


def link_comments(db, conv: Conversations, project_ids: List[str]) -> Dict[str, Any]:
    """The comments each approved plan wrote, found by their ids.

    Comments are not in the audit log (by design), so a plan's comments
    leave no operation. Since 2026-09-30 a plan draws the id of every row
    it creates from its own id (``plaid_client.ids.drawn_uuid7``), so a
    comment the plan wrote is recognized by its id alone: the nth id after
    the plan's. A plan made before then has no such ids, and what it
    commented is not recoverable (``comment_link: unrecoverable``, set
    when such a plan was applied and no operation of it was found).

    Returns the comment rows (no text: the entity, the document, when it was
    written and edited, whether it is still there) for ``comments.jsonl``."""
    from plaid_client.ids import drawn_uuid7
    from .records import seconds_between
    plans = [p for p in conv.plans if p['status'] in ('applied', 'partial') or p['interrupted']]
    approved = {p['plan_id'] for p in plans}
    seeds = [(at, p) for p in plans if (at := _v7_at(p['plan_id'])) is not None]
    rows: List[Dict[str, Any]] = []
    if seeds and project_ids:
        q = ','.join('?' * len(project_ids))
        found = db.execute(
            f'SELECT c.id, c.project_id, c.document_id, c.vocab_layer_id, c.entity_type, c.entity_id, c.author_id, '
            f'c.created_at, c.updated_at FROM comments c '
            f'WHERE c.project_id IN ({q}) OR c.vocab_layer_id IN '
            f'(SELECT vocab_layer_id FROM project_vocabs WHERE project_id IN ({q}))',
            project_ids + project_ids).fetchall()
        for cid, pid, did, vid, etype, eid, author, created, updated in found:
            at = _v7_at(cid)
            if at is None:
                continue
            for seed_at, p in seeds:
                n = at - seed_at - 1
                if 0 <= n < DRAWN_MAX and drawn_uuid7(p['plan_id'], n) == str(cid):
                    rows.append({'plan_id': p['plan_id'], 'conversation_id': p['conversation_id'], 'app': p['app'],
                                 'project_id': p['project_id'], 'project': p['project'], 'comment_id': str(cid),
                                 'entity_type': etype, 'entity_id': eid, 'document_id': did,
                                 'vocab_layer_id': vid, 'created_at': created,
                                 'edited_after_s': (seconds_between(created, updated)
                                                    if updated and updated != created else None),
                                 'author_is_requester': author == conv.owner_of_plan.get(p['plan_id'])})
                    break
    by_plan: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_plan[r['plan_id']].append(r)
    for p in conv.plans:
        mine = by_plan.get(p['plan_id'])
        p['comments_written'] = len(mine) if mine else 0
        if mine:
            p['comment_link'] = 'minted_id'
        elif p['plan_id'] in approved and not p['group_id'] and _v7_at(p['plan_id']) is None:
            p['comment_link'] = 'unrecoverable'
        else:
            p['comment_link'] = None
    for c in conv.plan_changes:
        mine = by_plan.get(c['plan_id'])
        if c['kind'] != 'add_comment' or not mine:
            continue
        hits = [r for r in mine if r['entity_id'] == c['target']]
        c['target_written'] = bool(hits)
        c['matched_writes'] = len(hits)
        fates = ['comment_edited' if r['edited_after_s'] is not None else 'comment_kept' for r in hits]
        c['fate'] = fates[0] if fates else None
        c['fates'] = dict(Counter(fates))
    return {'comments': rows,
            'plans_with_comments': len(by_plan),
            'plans_unrecoverable': sum(1 for p in conv.plans if p.get('comment_link') == 'unrecoverable')}


def tool_inventory(apps: List[str]) -> Dict[str, List[str]]:
    out = {}
    for app in apps:
        try:
            import importlib
            mod = importlib.import_module(f'plaid_agent.{app}.toolkit')
            out[app] = [t['function']['name'] for t in mod.TOOLS]
        except Exception:  # noqa: BLE001 - an app this checkout does not have
            out[app] = []
    return out


def tool_stats(conv: Conversations, inventory: Dict[str, List[str]]) -> Dict[str, Any]:
    per: Dict[tuple, Dict[str, Any]] = {}
    for t in conv.tool_calls:
        s = per.setdefault((t['app'], t['tool']), {'app': t['app'], 'tool': t['tool'], 'calls': 0, 'failed': 0,
                                                  'recovered_in_turn': 0, 'result_kept': 0,
                                                  'turns': set(), 'conversations': set(),
                                                  'error_classes': Counter()})
        s['calls'] += 1
        s['failed'] += t['failed']
        s['recovered_in_turn'] += bool(t['recovered_in_turn'])
        s['result_kept'] += t['result_kept']
        s['turns'].add((t['conversation_id'], t['item_index']))
        s['conversations'].add(t['conversation_id'])
        if t['failed']:
            s['error_classes'][t['error_class']] += 1
    rows = []
    for s in per.values():
        rows.append({**s, 'turns': len(s['turns']), 'conversations': len(s['conversations']),
                     'error_classes': dict(s['error_classes']),
                     'in_inventory': s['tool'] in inventory.get(s['app'], ())})
    rows.sort(key=lambda r: (r['app'], -r['calls']))
    used = defaultdict(set)
    for r in rows:
        used[r['app']].add(r['tool'])
    apps = sorted({t['app'] for t in conv.turns})
    return {'tools': rows,
            'never_used': {a: [t for t in inventory.get(a, ()) if t not in used[a]] for a in apps},
            'not_in_inventory': {a: sorted(t for t in used[a] if t not in inventory.get(a, ())) for a in apps},
            'inventory_size': {a: len(inventory.get(a, ())) for a in apps}}


def telemetry(db, pseudo: Pseudonyms, project_ids: List[str]) -> List[Dict[str, Any]]:
    from .pseudo import clip
    if not project_ids:
        return []
    q = ','.join('?' * len(project_ids))
    out = []
    for (eid, pid, did, uid, typ, target, data, cts, ts) in db.execute(
            f'SELECT id, project_id, document_id, user_id, type, target_id, data, client_ts, ts '
            f'FROM client_events WHERE project_id IN ({q}) ORDER BY ts, id', project_ids):
        try:
            d = json.loads(data) if data else {}
        except ValueError:
            d = {}
        out.append({'event_id': eid, 'project_id': pid, 'project': pseudo.project(pid), 'document_id': did,
                    'user': pseudo.user(uid), 'type': typ, 'target_id': target,
                    'data': {k: (pseudo.source(v) if k == 'source' else clip(v) if k in ('value', 'written') else v)
                             for k, v in (d or {}).items()},
                    'client_ts': cts, 'ts': ts})
    return out


def _dist(values: List[float]) -> Optional[Dict[str, float]]:
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return {'n': len(values), 'min': values[0], 'median': median(values), 'max': values[-1]}


def summarize(conv: Conversations, fates: F.Fates, units: List[Dict[str, Any]], tools: Dict[str, Any],
              events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate counts, for a first look and for reports. No identities."""
    plans = conv.plans
    w_by_kind: Dict[str, Counter] = defaultdict(Counter)
    edit_delay: Dict[str, List[float]] = defaultdict(list)
    for w in fates.writes:
        w_by_kind[w['unit_kind']][w['fate']] += 1
        if w['first_edit']:
            edit_delay[w['unit_kind']].append(w['first_edit']['after_s'])
    edit_prov = defaultdict(Counter)
    for w in fates.writes:
        if w['first_edit']:
            e = w['first_edit']
            edit_prov[w['unit_kind']][f'{e["actor_class"]}:{e["prov_after"]}'] += 1
    return {
        'conversations': len(conv.conversations),
        'conversations_by_app': dict(Counter(c['app'] for c in conv.conversations)),
        'turns': len(conv.turns), 'turn_ends': dict(Counter(t['end'] for t in conv.turns)),
        'plans': len(plans), 'plans_by_status': dict(Counter(p['status'] for p in plans)),
        'plans_by_app_status': dict(Counter(f'{p["app"]}:{p["status"]}' for p in plans)),
        'plans_by_proposed_source': dict(Counter(p['proposed_source'] for p in plans)),
        'proposed_changes_total': sum(p['proposed_count'] or 0 for p in plans),
        'proposed_changes_by_status': dict(Counter({s: sum(p['proposed_count'] or 0 for p in plans if p['status'] == s)
                                                    for s in {p['status'] for p in plans}})),
        'seconds_to_settle': {s: _dist([p['seconds_to_settle'] for p in plans if p['status'] == s])
                              for s in sorted({p['status'] for p in plans})},
        'plans_with_proposal_time': sum(1 for p in plans if p['proposed_at']),
        'plans_with_settle_time': dict(Counter(p['settled_at_source'] or 'none' for p in plans)),
        'units_by_kind': dict(Counter(u['kind'] for u in units)),
        'writes_by_kind': {k: sum(c.values()) for k, c in w_by_kind.items()},
        'fates_by_kind': {k: dict(c) for k, c in w_by_kind.items()},
        'first_edit_delay_s': {k: _dist(v) for k, v in edit_delay.items()},
        'deletions_by_kind': {k: dict(Counter(f'{w["deletion"]["actor_class"]}'
                                              f'{":cascade" if w["deletion"]["cascade"] else ""}'
                                              for w in fates.writes if w['unit_kind'] == k and w['deletion']))
                              for k in w_by_kind},
        'first_edit_actor_prov': {k: dict(c) for k, c in edit_prov.items()},
        'first_edit_credential': {k: dict(Counter(f'{w["first_edit"]["actor_class"]}:{w["first_edit"]["credential"]}'
                                                  for w in fates.writes if w['unit_kind'] == k and w['first_edit']))
                                  for k in w_by_kind},
        'deletion_credential': {k: dict(Counter(f'{w["deletion"]["actor_class"]}:{w["deletion"]["credential"]}'
                                                for w in fates.writes if w['unit_kind'] == k and w['deletion']))
                                for k in w_by_kind},
        'units_by_credential': dict(Counter(c for u in units for c in u['credentials'])),
        'writes_by_credential': dict(sum((Counter(u['credentials']) for u in units), Counter())),
        'plan_operations_by_record': dict(Counter(u['plan_record'] for u in units if u['kind'] == 'assistant-plan')),
        'plans_by_comment_link': dict(Counter(str(p.get('comment_link')) for p in plans)),
        'turns_dated': sum(1 for t in conv.turns if t['created_at']),
        'turns_retried': sum(1 for t in conv.turns if t['retry']),
        'failed_or_stopped_turn_steps': sum(t['n_steps'] for t in conv.turns if t['end'] in ('failed', 'stopped')),
        'plan_change_fates': dict(Counter(str(c['fate']) for c in conv.plan_changes if c['plan_status'] in
                                          ('applied', 'partial'))),
        'plan_changes_target_written': dict(Counter(str(c['target_written']) for c in conv.plan_changes
                                                    if c['plan_status'] in ('applied', 'partial'))),
        'tool_calls': len(conv.tool_calls),
        'tool_calls_failed': sum(t['failed'] for t in conv.tool_calls),
        'tool_error_classes': dict(Counter(t['error_class'] for t in conv.tool_calls if t['failed'])),
        'tool_results_kept': sum(t['result_kept'] for t in conv.tool_calls),
        'never_used': tools['never_used'], 'not_in_inventory': tools['not_in_inventory'],
        'telemetry_events': len(events), 'telemetry_by_type': dict(Counter(e['type'] for e in events)),
    }


def write_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    with path.open('w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, default=_default, sort_keys=True) + '\n')


def _default(v):
    if isinstance(v, (set, frozenset)):
        return sorted(v)
    return str(v)


def extract(db_path: str, out: Path, salt_file: Path, projects: Optional[List[str]] = None,
            keep_project_names: bool = False, include_text: bool = False,
            track: Optional[List[str]] = None, quiet: bool = False,
            include_rounds: bool = False) -> Dict[str, Any]:
    out = Path(out)
    salt = load_salt(salt_file, out)
    pseudo = Pseudonyms(salt)
    db = open_ro(db_path)
    log = (lambda *_: None) if quiet else (lambda m: print(m, file=sys.stderr, flush=True))

    horizon = latest(db)
    retention = db.execute('SELECT pruned_below_ts FROM audit_retention').fetchone()
    scope = list(projects) if projects else assistant_projects(db)
    log(f'{len(scope)} project(s) in scope, horizon {horizon}')

    conv = Conversations(pseudo, include_text=include_text, include_rounds=include_rounds)
    rows = db.execute("SELECT user_id, key, value, updated_at FROM user_data WHERE key LIKE '%:assistant:%'")
    for user_id, app, project_id, conv_id, c, meta, nbytes, updated, rounds, rbytes in iter_records(rows):
        if project_id in scope:
            conv.add(user_id, app, project_id, conv_id, c, meta, nbytes, updated, rounds, rbytes)
    log(f'{len(conv.conversations)} conversation(s), {len(conv.plans)} plan(s)')

    fates = F.Fates(pseudo, horizon, track or F.DEFAULT_TRACK)
    docs, vocabs = F.project_streams(db, scope) if scope else ([], [])
    F.run(db, fates, docs, vocabs)
    link = link_plans(conv, fates)
    commented = link_comments(db, conv, scope)
    link['linked_by_comments'] = commented['plans_with_comments']
    link['applied_unrecoverable'] = commented['plans_unrecoverable']
    units = fates.unit_rows()
    log(f'{len(units)} machine unit(s), {len(fates.writes)} write(s) followed')

    apps = sorted({c['app'] for c in conv.conversations})
    inventory = tool_inventory(apps)
    tools = tool_stats(conv, inventory)
    events = telemetry(db, pseudo, scope)

    names = dict(db.execute('SELECT id, name FROM projects').fetchall())
    project_rows = []
    for pid in scope:
        row = {'project_id': pid, 'project': pseudo.project(pid), 'exists': pid in names,
               'conversations': sum(1 for c in conv.conversations if c['project_id'] == pid),
               'plans': sum(1 for p in conv.plans if p['project_id'] == pid),
               'units': dict(Counter(u['kind'] for u in units if u['project_id'] == pid))}
        if keep_project_names:
            row['name'] = names.get(pid)
        project_rows.append(row)

    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'projects.jsonl', project_rows)
    write_jsonl(out / 'conversations.jsonl', conv.conversations)
    write_jsonl(out / 'turns.jsonl', conv.turns)
    write_jsonl(out / 'tool_calls.jsonl', conv.tool_calls)
    write_jsonl(out / 'plans.jsonl', conv.plans)
    write_jsonl(out / 'plan_changes.jsonl', conv.plan_changes)
    write_jsonl(out / 'units.jsonl', units)
    write_jsonl(out / 'writes.jsonl', [{k: v for k, v in w.items() if k != '_anchors'} for w in fates.writes])
    write_jsonl(out / 'telemetry.jsonl', events)
    write_jsonl(out / 'comments.jsonl', commented['comments'])
    (out / 'tool_inventory.json').write_text(json.dumps(
        {'inventory': inventory, **tools}, indent=1, default=_default, sort_keys=True), encoding='utf-8')
    private = out / 'PRIVATE_text.jsonl'
    if include_text:
        private_rows = list(conv.private)
        for u in fates.units.values():
            if u.get('_message'):
                private_rows.append({'kind': 'operation_label', 'unit_id': u['unit_id'], 'text': u['_message']})
        write_jsonl(private, private_rows)
    elif private.exists():
        private.unlink()
    full = out / 'PRIVATE_rounds.jsonl'
    if include_rounds:
        write_jsonl(full, conv.round_calls)
    elif full.exists():
        full.unlink()
    summary = summarize(conv, fates, units, tools, events)
    manifest = {
        'extractor_version': EXTRACTOR_VERSION,
        'extracted_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'database': Path(db_path).name, 'horizon': horizon,
        'audit_pruned_below': retention[0] if retention else None,
        'projects': len(scope), 'tracked_kinds': sorted(fates.track),
        'keep_project_names': keep_project_names, 'include_text': include_text,
        'private_text_file': private.name if include_text else None,
        'include_rounds': include_rounds,
        'private_rounds_file': full.name if include_rounds else None,
        'linking': link, 'summary': summary,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1, default=_default, sort_keys=True),
                                       encoding='utf-8')
    shutil.copyfile(HERE / 'DATASET.md', out / 'README.md')
    db.close()
    return manifest


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('db', help='the Plaid SQLite database, opened read-only')
    ap.add_argument('out', help='the directory the dataset is written to')
    ap.add_argument('--salt-file', required=True, help='where the pseudonym key is kept, outside OUT')
    ap.add_argument('--project', action='append', help='a project id to take (repeatable), '
                                                         'default: every project with assistant use')
    ap.add_argument('--keep-project-names', action='store_true', help='write project names into projects.jsonl')
    ap.add_argument('--include-text', action='store_true',
                    help="ALSO write PRIVATE_text.jsonl: user messages, model replies, the text the model wrote "
                         "between tool calls, tool errors and operation labels, for the researcher's own review. "
                         "Never share it with the dataset.")
    ap.add_argument('--include-rounds', action='store_true',
                    help="ALSO write PRIVATE_rounds.jsonl: every tool call's whole arguments and the output the model "
                         "was sent. Project text, several times the dataset's size. Never share it with the dataset.")
    ap.add_argument('--track', action='append', choices=sorted(F.ACTOR),
                    help='a kind of unit whose writes are followed (repeatable), '
                         f'by default {", ".join(F.DEFAULT_TRACK)}')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args(argv)
    m = extract(a.db, Path(a.out), Path(a.salt_file), a.project, a.keep_project_names, a.include_text, a.track,
                a.quiet, a.include_rounds)
    print(json.dumps(m['summary'], indent=1, default=_default, sort_keys=True))


if __name__ == '__main__':
    main()
