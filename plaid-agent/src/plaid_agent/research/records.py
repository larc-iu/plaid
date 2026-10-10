"""Reading the assistants' conversation records into dataset rows.

A conversation is two values in its owner's user data (see
:mod:`plaid_agent.core.conversation`): the sidebar entry (``meta``) and the
record (``conv``: ``messages``, the model transcript, and ``display``, what
the person sees). The store keeps them with their keys in kebab case, as the
clients send them. Everything here reads them with the keys in snake case.

What the record does NOT keep, and so no row here can say:

* when an item was written, before items carried ``created_at``
  (2026-10-06). A plan's id is a UUIDv7 minted when its turn staged it, so a
  plan's proposal time is read off its id. A turn with no plan has only its
  duration (``elapsed_ms``, since 2026-10-05).
* the tool calls of a failed or stopped turn, before such a turn kept them on
  its error item (``steps`` and ``calls``, 2026-10-06). From 2026-10-09 every
  turn's calls are in its rounds (core/rounds.py), stored beside the record,
  which hold what prune drops from it; a step that names no round is older.
* a conversation the user deleted, and every value the record was pruned of:
  old tool results (``DROPPED``), old steps and citations, a settled plan's
  ``ops`` (compacted, only ``proposed`` stays, and only on plans staged since
  ``proposed`` was recorded).
* the record's earlier states. User data is not in the audit log, so only
  the latest version of a record exists.
"""

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .pseudo import Pseudonyms, clip

DROPPED = '[This result was dropped to keep the conversation within its size limit.]'
KEY_RE = re.compile(r'^(?P<app>[^:]+):assistant:(?P<project>[^:]+):(?P<what>conv|meta):(?P<conv>[^:]+)$')
# One model call of a turn, stored beside the conversation (core/rounds.py).
ROUND_RE = re.compile(r'^(?P<app>[^:]+):assistant:(?P<project>[^:]+):round:(?P<conv>[^:]+):(?P<round>[^:]+)$')

# What the loop appends to a reply that ended some other way than an answer
# (plaid_agent.core.agent). Matched on the end of the text, which is never
# exported by default.
STOPPED_REPEAT = re.compile(r'\*\(Stopped after the same step (failed|was repeated) \d+ times\.\)\*\s*$')
STEP_LIMIT = re.compile(r'\*\(Stopped at the step limit\.\)\*\s*$')
CUT_AT_LENGTH = re.compile(r"\*\(The reply was cut off at the model's output limit\.\)\*\s*$")
EMPTY_REPLY = '(The model returned an empty reply.)'

# A tool's refusal, by what it says. The first that matches wins, and the
# order matters: a query the server refused also says "rejected".
ERROR_CLASSES: List[Tuple[str, re.Pattern]] = [(name, re.compile(rx, re.I)) for name, rx in (
    ('query_rejected', r'^Query rejected'),
    ('tool_fault', r'which is a fault in the tool'),
    ('code_exception', r'^Traceback'),
    ('bad_arguments', r'cannot be called with those arguments|has the wrong type|unexpected keyword|'
                      r'not valid JSON|^Give |must be (a|an|one of|given)|is not a (number|whole number|list)'),
    # A reference at the wrong level: a word where a morpheme was wanted, a
    # sentence where a word was, a multi-word token where one of its words was.
    ('wrong_level', r'\bis not an? (sentence|word|morpheme)\b|names a sentence or a multi-word token|'
                    r'is (a|inside the) multi-word token|, not (sentences|single morphemes)\b|'
                    r'is an? \w+ field, not an? \w+ field'),
    ('ambiguous', r'names several|several \w+ match|more than one'),
    ('plan_limit', r'more than the [\d,]+ one plan may hold'),
    ('unavailable', r'is connected to this project|not configured|not available|is offline'),
    ('server_refused', r'could not be read'),
    ('plan_conflict', r"this plan's set_words renumbers"),
    ('not_found', r'^No |has no |has \d+ words?\b|not found|does not exist|no such|is not in '),
    ('plan_conflict', r'^This plan |already|discard_plan first|cannot be planned|would (delete|replace|lose)'),
)]


def snake(value: Any) -> Any:
    """``value`` with every dict key in snake case, as the Python client
    reads the store. Keys of metadata content are opaque elsewhere, and
    nothing here reads them."""
    if isinstance(value, dict):
        return {(k.replace('-', '_') if isinstance(k, str) else k): snake(v) for k, v in value.items()}
    if isinstance(value, list):
        return [snake(v) for v in value]
    return value


def uuid7_time(value: Optional[str]) -> Optional[str]:
    """The millisecond a UUIDv7 was minted, as ISO 8601, or None for any
    other id."""
    try:
        u = uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None
    if u.version != 7:
        return None
    ms = int(u.hex[:12], 16)
    return iso_ms(ms)


def iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec='milliseconds').replace(
        '+00:00', 'Z')


def parse_ts(ts: Optional[str]) -> Optional[datetime]:
    """An ISO 8601 instant from the record or the audit log (which has
    nanoseconds), or None."""
    if not isinstance(ts, str) or not ts:
        return None
    t = ts.strip().replace('Z', '+00:00')
    m = re.match(r'^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$', t)
    if m:
        frac = (m.group(2) or '')[:7]
        t = m.group(1) + frac + (m.group(3) or '+00:00')
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def seconds_between(a: Optional[str], b: Optional[str]) -> Optional[float]:
    da, db = parse_ts(a), parse_ts(b)
    if not da or not db:
        return None
    return round((db - da).total_seconds(), 3)


def error_class(text: Optional[str]) -> str:
    """What kind of refusal a tool's ``Error: ...`` answer was."""
    if not isinstance(text, str):
        return 'unknown'
    body = text[len('Error:'):].strip() if text.startswith('Error:') else text.strip()
    for name, rx in ERROR_CLASSES:
        if rx.search(body):
            return name
    return 'other'


def arg_names(args: Any) -> Optional[List[str]]:
    """The names of the arguments a tool call was given (never their values),
    each clipped, or None when the record no longer holds them. Arguments
    that were not a JSON object are ``['(not an object)']``."""
    if args is None:
        return None
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return ['(not an object)']
    if not isinstance(args, dict):
        return ['(not an object)']
    return sorted(clip(str(k)) for k in args)


def turn_end(item: Dict[str, Any]) -> str:
    """How a turn ended: an answer, or which of the ways it can stop."""
    if item.get('kind') == 'error':
        return 'stopped' if item.get('stopped') else 'lost' if item.get('lost') else 'failed'
    text = item.get('text') or ''
    if STOPPED_REPEAT.search(text):
        return 'stopped_repeat'
    if STEP_LIMIT.search(text):
        return 'step_limit'
    if text.strip().startswith(EMPTY_REPLY):
        return 'empty_reply'
    if CUT_AT_LENGTH.search(text):
        return 'cut_at_length'
    return 'answered'


_PROPOSED_KEYS: Dict[str, Any] = {}


def proposed_keys(app: str):
    """The app's ``proposed_keys`` (what a change targets, its value and its
    other end), read from its service class, or None for an app this
    package does not have."""
    if app in _PROPOSED_KEYS:
        return _PROPOSED_KEYS[app]
    keys = None
    try:
        import importlib
        mod = importlib.import_module(f'plaid_agent.{app}.service')
        for obj in vars(mod).values():
            if isinstance(obj, type) and getattr(obj, 'APP', None) == app and getattr(obj, 'proposed_keys', None):
                keys = obj.proposed_keys
                break
    except Exception:  # noqa: BLE001 - an app this checkout cannot load derives nothing
        keys = None
    _PROPOSED_KEYS[app] = keys
    return keys


def derive_proposed(app: str, ops: List[Dict[str, Any]]) -> Optional[Tuple[List[list], int]]:
    """What the turn would have recorded as ``proposed`` for a plan staged
    before it did, from the ops the record still holds (an undecided plan,
    or one settled before compaction)."""
    keys = proposed_keys(app)
    if not keys:
        return None
    from plaid_agent.core.conversation import proposed_changes
    return proposed_changes(ops, *keys)


def _text_or_none(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and v else None


class Conversations:
    """Every row the conversation records give, built by :meth:`add`."""

    def __init__(self, pseudo: Pseudonyms, include_text: bool = False, include_rounds: bool = False):
        self.p = pseudo
        self.include_text = include_text
        # Every call's whole arguments and output, off by default (Luke's
        # ruling D3 of 2026-10-09): several times the dataset's size, and
        # project text.
        self.include_rounds = include_rounds
        self.round_calls: List[Dict[str, Any]] = []
        self.conversations: List[Dict[str, Any]] = []
        self.turns: List[Dict[str, Any]] = []
        self.tool_calls: List[Dict[str, Any]] = []
        self.plans: List[Dict[str, Any]] = []
        self.plan_changes: List[Dict[str, Any]] = []
        self.private: List[Dict[str, Any]] = []
        # Kept for linking plans to the audit log, never written out.
        self.owner_of_plan: Dict[str, str] = {}
        self.summary_of_plan: Dict[str, str] = {}

    def add(self, user_id: str, app: str, project_id: str, conv_id: str,
            conv: Optional[Dict[str, Any]], meta: Optional[Dict[str, Any]],
            record_bytes: int, updated_at: Optional[str],
            rounds: Optional[Dict[str, Dict[str, Any]]] = None, rounds_bytes: int = 0) -> None:
        conv = snake(conv or {})
        meta = snake(meta or {})
        rounds = {k: snake(v) for k, v in (rounds or {}).items() if isinstance(v, dict)}
        calls_of = {(rid, c.get('id')): c for rid, r in rounds.items()
                    for c in r.get('calls') or [] if isinstance(c, dict)}
        user = self.p.user(user_id)
        messages = [m for m in conv.get('messages') or [] if isinstance(m, dict)]
        display = [d for d in conv.get('display') or [] if isinstance(d, dict)]
        results = {m.get('tool_call_id'): m.get('content') for m in messages if m.get('role') == 'tool'}
        arguments = {c.get('id'): (c.get('function') or {}).get('arguments')
                     for m in messages if m.get('role') == 'assistant'
                     for c in m.get('tool_calls') or [] if isinstance(c, dict)}
        base = {'conversation_id': conv_id, 'app': app, 'project_id': project_id,
                'project': self.p.project(project_id), 'user': user}

        n_user = 0
        models, services = set(), set()
        n_plans = 0
        for index, item in enumerate(display):
            kind = item.get('kind')
            if kind == 'user':
                n_user += 1
                if self.include_text:
                    self.private.append({**base, 'item_index': index, 'kind': 'user', 'text': item.get('text')})
                continue
            if kind not in ('assistant', 'error'):
                continue
            if item.get('model'):
                models.add(item['model'])
            if item.get('service'):
                services.add(item['service'])
            asked = next((d for d in reversed(display[:index]) if d.get('kind') == 'user'), {})
            where = asked.get('where') if isinstance(asked.get('where'), dict) else None
            steps = [s for s in item.get('steps') or [] if isinstance(s, dict)]
            usage = item.get('usage') if isinstance(item.get('usage'), dict) else None
            total = (usage or {}).get('total') if isinstance((usage or {}).get('total'), dict) else None
            plan = item.get('plan') if isinstance(item.get('plan'), dict) else None
            turn = {
                **base, 'item_index': index, 'turn': n_user, 'end': turn_end(item),
                'model': item.get('model'), 'version': item.get('version'), 'service': item.get('service'),
                'asked_at': asked.get('created_at'), 'created_at': item.get('created_at'),
                'retry': bool(asked.get('retry')),
                'elapsed_ms': item.get('elapsed_ms'),
                'sent_tokens': (usage or {}).get('sent'), 'received_tokens': (usage or {}).get('received'),
                'window_tokens': (usage or {}).get('window'),
                'total_sent_tokens': (total or {}).get('sent'), 'total_received_tokens': (total or {}).get('received'),
                'model_calls': (total or {}).get('calls'),
                'n_steps': len(steps), 'n_failed_steps': 0,
                'n_citations': len(item.get('citations') or []),
                'plan_id': (plan or {}).get('id'),
                'where_kind': (where or {}).get('kind'), 'where_id': (where or {}).get('id'),
                'files_attached': len(asked.get('files') or []),
                'files_stored': len(item.get('files') or []),
                'unavailable_projects': len(item.get('unavailable_projects') or []),
            }
            # The other projects the question was sent with that the turn
            # could open: what a cross-project turn read besides its own.
            # Ids and pseudonyms only, as for the home project.
            unavailable = {u.get('id') for u in item.get('unavailable_projects') or [] if isinstance(u, dict)}
            others = [pr.get('id') for pr in asked.get('projects') or []
                      if isinstance(pr, dict) and isinstance(pr.get('id'), str)
                      and pr.get('id') not in unavailable and pr.get('id') != project_id]
            others = list(dict.fromkeys(others))
            turn['other_project_ids'] = others
            turn['other_projects'] = [self.p.project(pid) for pid in others]
            # What each call was sent and answered: its round where the step
            # names one (the round holds what prune dropped from the record),
            # else the transcript, else a failed turn's item (2026-10-06 to
            # 2026-10-09).
            own = [c for c in item.get('calls') or [] if isinstance(c, dict)]
            step_results = {**results, **{c.get('id'): c.get('result') for c in own}}
            step_arguments = {**arguments, **{c.get('id'): c.get('arguments') for c in own}}
            for st in steps:
                c = calls_of.get((st.get('round'), st.get('id')))
                if c is not None:
                    step_results[st.get('id')] = c.get('result')
                    step_arguments[st.get('id')] = c.get('arguments')
            failed_steps = self._steps(base, index, n_user, steps, step_results, step_arguments,
                                       turn['end'], calls_of, rounds)
            turn['n_failed_steps'] = failed_steps
            self.turns.append(turn)
            reply_thinking = _text_or_none((rounds.get(item.get('reply_round')) or {}).get('thinking'))
            if self.include_rounds and reply_thinking is not None:
                # The reasoning the reply was written with, in a round of its own.
                self.round_calls.append({**base, 'item_index': index, 'turn': n_user, 'kind': 'reply',
                                         'step': None, 'tool': None, 'arguments': None, 'result': None,
                                         'thinking': reply_thinking})
            if self.include_text:
                self.private.append({**base, 'item_index': index, 'kind': kind, 'text': item.get('text')})
            if plan:
                n_plans += 1
                self._plan(base, app, index, n_user, item, plan, user_id)

        dropped = sum(1 for m in messages if m.get('role') == 'tool' and m.get('content') == DROPPED)
        self.conversations.append({
            **base,
            'created_at': meta.get('created_at'), 'updated_at': meta.get('updated_at') or updated_at,
            'has_meta': bool(meta), 'turns': n_user, 'items': len(display), 'plans': n_plans,
            'models': sorted(models), 'services': sorted(services), 'version': meta.get('version'),
            'pending': bool(meta.get('pending')), 'record_bytes': record_bytes,
            'transcript_messages': len(messages),
            'tool_results_kept': sum(1 for m in messages if m.get('role') == 'tool' and m.get('content') != DROPPED),
            'tool_results_dropped': dropped,
            'about_document': (meta.get('about') or {}).get('document_id') if isinstance(meta.get('about'), dict)
            else None,
            # The service's own count, on the entry since it alone writes the
            # record. The tab that holds the conversation (`holder`) is a
            # per-viewer fact with no research value and is not exported.
            'size_bytes': (meta.get('size') or {}).get('bytes') if isinstance(meta.get('size'), dict) else None,
            # What is stored beside the record: one round per model call.
            'rounds': len(rounds), 'rounds_bytes': rounds_bytes,
        })

    def _steps(self, base, index, turn, steps, results, arguments, end, calls_of=None, rounds=None) -> int:
        failed_n = 0
        rows = []
        for i, s in enumerate(steps):
            legacy = 'args' in s or 'result' in s or 'error' in s
            if legacy:
                text = s.get('result') if isinstance(s.get('result'), str) else None
                failed = bool(s.get('error')) or (isinstance(text, str) and text.startswith('Error'))
                kept = text is not None
                args = s.get('args')
            else:
                text = results.get(s.get('id'))
                kept = isinstance(text, str) and text != DROPPED
                failed = bool(s.get('failed'))
                if not failed and kept and text.startswith('Error'):
                    failed = True
                args = arguments.get(s.get('id'))
            failed_n += failed
            row = {**base, 'item_index': index, 'turn': turn, 'turn_end': end, 'step': i, 'tool': s.get('name'),
                   'step_kind': s.get('kind'), 'failed': failed,
                   'error_class': (error_class(text) if kept else 'unknown') if failed else None,
                   'result_kept': kept, 'planned': s.get('planned') or 0,
                   'document_read': bool(s.get('document')), 'arg_names': arg_names(args),
                   'legacy_shape': legacy}
            # What the call read and how much it answered, from the step and
            # its round. The text the model wrote before it can quote the
            # project, so only its length is here and the text goes with the
            # replies to the private file.
            call = (calls_of or {}).get((s.get('round'), s.get('id')))
            said = s.get('said') if isinstance(s.get('said'), str) else None
            row.update({
                'round_stored': call is not None,
                'saw': [{k: n.get(k) for k in ('n', 'unit', 'of', 'which') if n.get(k) is not None}
                        for n in s.get('saw') or [] if isinstance(n, dict)],
                'result_chars': len(text) if isinstance(text, str) and text != DROPPED else None,
                'arguments_chars': len(args) if isinstance(args, str) else None,
                'cut': bool((call or {}).get('cut')),
                'said_chars': len(said) if said is not None else None,
            })
            if self.include_text and said is not None:
                self.private.append({**base, 'item_index': index, 'kind': 'said', 'step': i,
                                     'tool': s.get('name'), 'text': said})
            if self.include_rounds and call is not None:
                # The model's reasoning in that model call, on its first
                # call's row (Luke's D3: off by default, as the outputs).
                rnd = (rounds or {}).get(s.get('round')) or {}
                first = ((rnd.get('calls') or [{}])[0] or {}).get('id') == s.get('id')
                self.round_calls.append({**base, 'item_index': index, 'turn': turn, 'kind': 'call', 'step': i,
                                         'tool': s.get('name'), 'arguments': call.get('arguments'),
                                         'result': call.get('result'),
                                         'thinking': _text_or_none(rnd.get('thinking')) if first else None})
            if self.include_text and failed and kept:
                self.private.append({**base, 'item_index': index, 'kind': 'tool_error', 'step': i,
                                     'tool': s.get('name'), 'text': text[:500]})
            rows.append(row)
        for i, row in enumerate(rows):
            row['recovered_in_turn'] = (any(r['tool'] == row['tool'] and not r['failed'] for r in rows[i + 1:])
                                        if row['failed'] else None)
        self.tool_calls.extend(rows)
        return failed_n

    def _plan(self, base, app, index, turn, item, plan, user_id) -> None:
        plan_id = plan.get('id')
        status = item.get('status') or 'undecided'
        proposed, count, source = plan.get('proposed'), plan.get('proposed_count'), 'record'
        if proposed is None and isinstance(plan.get('ops'), list):
            derived = derive_proposed(app, plan['ops'])
            if derived:
                proposed, count = derived
                source = 'derived_from_ops'
        if proposed is None:
            source = 'none'
        proposed_at = uuid7_time(plan_id)
        settled_at = item.get('settled_at')
        op_count = plan.get('op_count')
        if op_count is None and isinstance(plan.get('ops'), list):
            op_count = len(plan['ops'])
        row = {
            **base, 'plan_id': plan_id, 'item_index': index, 'turn': turn, 'status': status,
            'interrupted': bool(item.get('interrupted')),
            # A stale plan the reader discarded after the refusal stays stale.
            'dismissed': bool(item.get('dismissed')), 'dismissed_at': item.get('dismissed_at'),
            'model': item.get('model'), 'version': item.get('version'), 'service': item.get('service'),
            'proposed_at': proposed_at, 'settled_at': settled_at,
            'settled_at_source': 'record' if settled_at else None,
            'seconds_to_settle': seconds_between(proposed_at, settled_at),
            'proposed_count': count, 'proposed_kept': len(proposed or []), 'proposed_source': source,
            'op_count': op_count,
            # A settled plan keeps its first rows and counts the rest (`compact_plan`).
            # A plan made since rules (core/rules.py) writes no `labels`: its
            # rows are its `changes`.
            'rows': len(plan.get('changes') or plan.get('labels') or [])
            + int((plan.get('omitted') or {}).get('count') or 0),
            'as_human': item.get('as_human'), 'contributed': bool(item.get('contributed')),
            'partly_applied': status == 'partial', 'rows_written': len(item.get('written') or []),
            'outcome_unknown': bool(item.get('unknown')),
            'apply_notes': len(item.get('apply_notes') or []), 'unwritten_rows': len(item.get('unwritten') or []),
            'kinds': sorted({str(c[0]) for c in proposed or [] if isinstance(c, list) and c}),
            # Filled in by linking (extract.py).
            'group_id': None, 'group_link': None, 'writes': None,
            'comments_written': None, 'comment_link': None,
        }
        self.plans.append(row)
        self.owner_of_plan[plan_id] = user_id
        self.summary_of_plan[plan_id] = plan.get('summary') or ''
        for i, c in enumerate(proposed or []):
            if not isinstance(c, list):
                continue
            self.plan_changes.append({
                **base, 'plan_id': plan_id, 'change': i, 'plan_status': status,
                'kind': c[0] if len(c) > 0 else None, 'target': c[1] if len(c) > 1 else None,
                'value': clip(c[2]) if len(c) > 2 else None, 'other': c[3] if len(c) > 3 else None,
                'source': source,
                # Filled in by linking: what the plan's writes and later edits did to this target.
                'target_written': None, 'matched_writes': None, 'fate': None, 'fates': None,
            })


def iter_records(rows: Iterable[Tuple[str, str, str, str]]):
    """``(user_id, app, project_id, conv_id, conv, meta, bytes, updated_at,
    rounds, rounds_bytes)`` for every conversation in the user-data rows
    ``(user_id, key, value, updated_at)``, with the values parsed, and its
    rounds by id. A conversation with a record and
    no sidebar entry (a write cut off between the two) is still read."""
    import json
    found: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for user_id, key, value, updated_at in rows:
        r = ROUND_RE.match(key)
        if r:
            slot = found.setdefault((user_id, f'{r["app"]}:assistant:{r["project"]}:{r["conv"]}'),
                                    {'user_id': user_id, 'app': r['app'], 'project': r['project'],
                                     'conv_id': r['conv']})
            try:
                slot.setdefault('rounds', {})[r['round']] = json.loads(value)
            except ValueError:
                pass
            slot['rounds_bytes'] = slot.get('rounds_bytes', 0) + len(value.encode('utf-8'))
            continue
        m = KEY_RE.match(key)
        if not m:
            continue
        slot = found.setdefault((user_id, key.rsplit(':', 2)[0] + ':' + m['conv']),
                                {'user_id': user_id, 'app': m['app'], 'project': m['project'], 'conv_id': m['conv']})
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        slot[m['what']] = parsed
        if m['what'] == 'conv':
            slot['bytes'] = len(value.encode('utf-8'))
            slot['updated_at'] = updated_at
    for slot in found.values():
        if 'conv' not in slot:
            continue
        yield (slot['user_id'], slot['app'], slot['project'], slot['conv_id'], slot.get('conv'), slot.get('meta'),
               slot.get('bytes') or 0, slot.get('updated_at'), slot.get('rounds') or {}, slot.get('rounds_bytes', 0))
