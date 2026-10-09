"""What became of machine work: each write a machine run (or an approved
assistant plan) made, followed through the audit log to the database's end.

The audit log is post-image only (each row is an entity as a write left it,
a delete has no image), ordered by ``(ts, seq)``. A row belongs to an
operation, and an operation to a unit: its operation group, else its batch,
else itself, which is how the audit read folds them too. A unit is classed
by its group's ``kind`` when it has one. Units from before kinds were
recorded (2026-09-29) are classed by what they wrote: a group the assistant
labelled ``Assistant: ...`` is an assistant plan, and a unit that wrote
machine provenance (``prov`` set, not confirmed, not contributed) is a
machine run.

Each stream of rows (one document, or one vocabulary's entries) is read
whole and in order, so a unit's class is decided from its rows in that
stream. A unit is tracked when its class is one of ``track``. For each
entity it wrote, the last row it wrote is what it left, and every later row
by another unit is what happened to it, classed by what changed and by who.
"""

import json
import unicodedata
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .pseudo import Pseudonyms, clip
from .records import seconds_between

TABLES = ('tokens', 'spans', 'relations', 'vocab_links', 'vocab_items')
PROV_KEYS = ('prov', 'provSource', 'provConfirmed', 'provProb', 'provDetail')

# Who a unit's writes count as.
ACTOR = {
    'assistant-plan': 'assistant',
    'service-run': 'machine',
    'untagged-machine': 'machine',
    'import': 'import',
    'repair': 'repair',
    'bulk-edit': 'person',
    'review': 'person',
    'guess-adoption': 'person',
    'person-untagged': 'person',
}
DEFAULT_TRACK = ('assistant-plan', 'service-run', 'guess-adoption', 'untagged-machine')
LEGACY_ASSISTANT_LABELS = ('Assistant: ', 'Assistant, partly applied: ')
# The provSource an importer stamps on what the imported file says a machine
# made (FLEx's parser guesses). An untagged unit whose machine stamps all
# carry it is an import, not a machine run.
IMPORT_SOURCES = ('flex-import',)

# The fields that make an entity's value, per table. A token's value is its
# form when it has one (an igt morpheme), kept in metadata.
VALUE_FIELDS = {
    'spans': ('value',),
    'relations': ('value', 'source_span_id', 'target_span_id'),
    'vocab_links': ('vocab_item_id',),
    'vocab_items': ('form',),
    'tokens': (),
}
EXTENT_FIELDS = ('begin', 'end_', 'precedence', 'tokens')

ROW_SQL = """
SELECT w.ts, w.seq, w.target_table, w.target_id, w.change_type, w.post_image, w.document_id, w.vocab_layer_id,
       o.id, o.user_id, o.token_id, {credential}, o.group_id, o.batch_id, o.project_id,
       g.kind, g.ref, g.message, g.user_id, g.created_at
FROM audit_writes w
JOIN operations o ON o.id = w.op_id
LEFT JOIN operation_groups g ON g.id = o.group_id
WHERE {where} AND w.change_type != 'doc-version-bump'
  AND w.target_table IN ('tokens', 'spans', 'relations', 'vocab_links', 'vocab_items')
ORDER BY w.ts, w.seq
"""


def prov_state(meta: Optional[Dict[str, Any]]) -> str:
    """The four provenance states (plaid_client.provenance), read off an
    image's metadata."""
    meta = meta or {}
    prov = meta.get('prov')
    if prov is None:
        return 'human'
    if meta.get('provConfirmed') is True:
        return 'verified'
    if prov == 'contributed':
        return 'contributed'
    return 'machine'


def decoded(v):
    """A span's or a relation's value as the API gives it. The column holds
    it as JSON text, and so does the audit image ('"kai"' for kai)."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def value_of(table: str, image: Optional[Dict[str, Any]]):
    if not image:
        return None
    if table == 'tokens':
        return (image.get('metadata') or {}).get('form')
    if table in ('spans', 'relations'):
        return decoded(image.get('value'))
    field = VALUE_FIELDS.get(table, ())
    return image.get(field[0]) if field else None


def field_of(table: str, image: Dict[str, Any], field: str):
    """A field of an image as it compares: a span's or a relation's value
    decoded, since one value has had two stored spellings (a core before
    2026-10-09 wrote "\\u0434" and "a\\/b" where one now writes the letters),
    and the audit log keeps the old images."""
    v = image.get(field)
    return decoded(v) if field == 'value' and table in ('spans', 'relations') else v


def value_key(table: str, image: Optional[Dict[str, Any]]):
    """Everything that makes the entity's value, for comparing two images."""
    if not image:
        return None
    if table == 'tokens':
        return ((image.get('metadata') or {}).get('form'),)
    return tuple(field_of(table, image, f) for f in VALUE_FIELDS.get(table, ()))


def nfc_key(key):
    """A value key with its strings composed (NFC), to compare a value as
    written with the same value after a repair composed it."""
    if key is None:
        return None
    return tuple(unicodedata.normalize('NFC', v) if isinstance(v, str) else v for v in key)


def change_category(table: str, prev: Optional[Dict[str, Any]], cur: Optional[Dict[str, Any]]) -> Tuple[str, List[str]]:
    """What an update changed: ``value``, ``metadata`` (a non-provenance
    key), ``extent`` (where it sits: offsets, its tokens), ``provenance``
    only, or ``none`` (the image is the same). The fields that changed come
    with it, metadata keys as ``metadata.<key>``."""
    prev, cur = prev or {}, cur or {}
    changed = []
    for k in sorted(set(prev) | set(cur)):
        if k in ('metadata', 'id', 'document_id'):
            continue
        if field_of(table, prev, k) != field_of(table, cur, k):
            changed.append(k)
    pm, cm = prev.get('metadata') or {}, cur.get('metadata') or {}
    meta_changed = sorted(k for k in set(pm) | set(cm) if pm.get(k) != cm.get(k))
    changed += [f'metadata.{k}' for k in meta_changed]
    if value_key(table, prev) != value_key(table, cur):
        return 'value', changed
    if any(k not in PROV_KEYS for k in meta_changed):
        return 'metadata', changed
    if any(k in EXTENT_FIELDS for k in changed):
        return 'extent', changed
    if meta_changed:
        return 'provenance', changed
    if changed:
        return 'structure', changed
    return 'none', changed


def credential_column(db) -> str:
    """What ROW_SQL reads for an operation's credential: the column, or NULL
    in a database from before operations recorded it (2026-10-06)."""
    cols = {r[1] for r in db.execute('PRAGMA table_info(operations)')}
    return 'o.credential' if 'credential' in cols else 'NULL'


class Row:
    __slots__ = ('ts', 'seq', 'table', 'target', 'change', 'raw', '_image', 'document_id', 'vocab_layer_id',
                 'op_id', 'user_id', 'token_id', 'credential', 'group_id', 'batch_id', 'project_id', 'kind', 'ref',
                 'message', 'group_user', 'group_created', 'unit', 'state')

    def __init__(self, r):
        (self.ts, self.seq, self.table, self.target, self.change, self.raw, self.document_id, self.vocab_layer_id,
         self.op_id, self.user_id, self.token_id, self.credential, self.group_id, self.batch_id, self.project_id,
         self.kind, self.ref, self.message, self.group_user, self.group_created) = r
        self._image = None
        self.unit = self.group_id or self.batch_id or self.op_id
        # The entity as it stands after this row: the key-merge of every
        # post-image of it so far, as `plaid.history.read` folds them. An
        # image holds only what its write set (a span's tokens and its
        # metadata ride on their own rows), so one image alone is not the
        # entity. None after a delete.
        self.state = None

    @property
    def image(self) -> Optional[Dict[str, Any]]:
        if self._image is None and self.raw:
            try:
                self._image = json.loads(self.raw)
            except ValueError:
                self._image = {}
        return self._image


class Unit:
    def __init__(self, row: Row):
        self.id = row.unit
        self.kind = row.kind
        self.ref = row.ref
        self.message = row.message
        self.user_id = row.group_user or row.user_id
        self.project_id = row.project_id
        self.group_created = row.group_created
        self.machine_stamped = False
        self.sources: Counter = Counter()
        self.first_ts = row.ts
        self.last_ts = row.ts
        self.counts: Counter = Counter()
        self.documents = set()
        self.via_token = False
        self.credentials: Counter = Counter()

    def take(self, row: Row) -> None:
        self.last_ts = row.ts
        self.counts[f'{row.table}.{row.change}'] += 1
        if row.document_id:
            self.documents.add(row.document_id)
        if row.token_id:
            self.via_token = True
        if row.credential:
            self.credentials[row.credential] += 1
        if row.project_id and not self.project_id:
            self.project_id = row.project_id
        if row.change != 'delete':
            meta = (row.image or {}).get('metadata') or {}
            state = prov_state(meta)
            if state == 'machine':
                self.machine_stamped = True
            if meta.get('provSource') and state in ('machine', 'verified'):
                self.sources[meta['provSource']] += 1

    @property
    def cls(self) -> str:
        if self.kind:
            return self.kind
        if isinstance(self.message, str) and self.message.startswith(LEGACY_ASSISTANT_LABELS):
            return 'assistant-plan'
        if self.machine_stamped:
            if self.sources and all(str(k).startswith(IMPORT_SOURCES) for k in self.sources):
                return 'import'
            return 'untagged-machine'
        return 'person-untagged'

    @property
    def legacy(self) -> bool:
        return not self.kind and self.cls != 'person-untagged'


class Fates:
    """The tracked units and their writes, built stream by stream."""

    def __init__(self, pseudo: Pseudonyms, horizon: str, track: Iterable[str] = DEFAULT_TRACK):
        self.p = pseudo
        self.horizon = horizon
        self.track = set(track)
        self.units: Dict[str, Dict[str, Any]] = {}
        self.writes: List[Dict[str, Any]] = []

    def stream(self, rows: Iterable[tuple]) -> None:
        rows = [Row(r) for r in rows]
        if not rows:
            return
        units: Dict[str, Unit] = {}
        for r in rows:
            u = units.get(r.unit)
            if u is None:
                u = units[r.unit] = Unit(r)
            u.take(r)
        by_target: Dict[Tuple[str, str], List[int]] = defaultdict(list)
        current: Dict[Tuple[str, str], Optional[Dict[str, Any]]] = {}
        for i, r in enumerate(rows):
            key = (r.table, r.target)
            by_target[key].append(i)
            if r.change == 'delete':
                current[key] = None
            else:
                current[key] = {**(current.get(key) or {}), **(r.image or {})}
            r.state = current[key]
        tracked = {uid: u for uid, u in units.items() if u.cls in self.track}
        if not tracked:
            return
        # What each unit deleted here, to tell a deletion that came with the
        # token or span under an entity (a cascade) from one of the entity.
        self._deleted: Dict[str, set] = defaultdict(set)
        for r in rows:
            if r.change == 'delete':
                self._deleted[r.unit].add(r.target)
        for uid, u in tracked.items():
            self._unit_row(u)
        # Each tracked unit's rows, by target, in order.
        mine: Dict[Tuple[str, Tuple[str, str]], List[int]] = defaultdict(list)
        for i, r in enumerate(rows):
            if r.unit in tracked:
                mine[(r.unit, (r.table, r.target))].append(i)
        for (uid, key), idx in mine.items():
            w = self._fate(units[uid], rows, idx, by_target[key], units)
            w['_anchors'] = self._anchors(rows, idx, by_target)
            self.writes.append(w)

    @staticmethod
    def _anchors(rows: List[Row], idx: List[int], by_target) -> List[str]:
        """The ids a write is ABOUT, so a proposed change that names a word
        can be matched to the gloss span over it or the dependency on it: the
        entity itself, the tokens it covers, a relation's two spans and their
        tokens. A deleted entity is read from the last image of it before
        the delete."""
        def image_at(table, target, before):
            for i in reversed(by_target.get((table, target), ())):
                if i <= before and rows[i].state:
                    return rows[i].state
            return None
        last = rows[idx[-1]]
        image = image_at(last.table, last.target, idx[-1])
        out = [last.target]
        if image:
            out += [t for t in image.get('tokens') or [] if isinstance(t, str)]
            for end in ('source_span_id', 'target_span_id'):
                sid = image.get(end)
                if sid:
                    out.append(sid)
                    span = image_at('spans', sid, idx[-1])
                    out += [t for t in (span or {}).get('tokens') or [] if isinstance(t, str)]
        return list(dict.fromkeys(out))

    def _unit_row(self, u: Unit) -> None:
        row = self.units.get(u.id)
        if row is None:
            row = self.units[u.id] = {
                'unit_id': u.id, 'kind': u.cls, 'legacy': u.legacy, 'ref': u.ref,
                'conversation_id': None, 'plan_id': None, 'service': None,
                'requester': self.p.user(u.user_id), 'project_id': u.project_id,
                'project': self.p.project(u.project_id), 'started_at': u.first_ts, 'ended_at': u.last_ts,
                'via_token': u.via_token, 'credentials': Counter(),
                'documents': set(), 'counts': Counter(), 'sources': Counter(),
                '_user_id': u.user_id, '_message': u.message,
            }
            if u.cls == 'assistant-plan' and isinstance(u.ref, str):
                for part in u.ref.split('/', 2):
                    if part.startswith('conv:'):
                        row['conversation_id'] = part[5:]
                    elif part.startswith('plan:'):
                        row['plan_id'] = part[5:]
                    elif part.startswith('service:'):
                        row['service'] = part[8:]
                if row['service'] is None and '/service:' in u.ref:
                    row['service'] = u.ref.split('/service:', 1)[1]
            elif isinstance(u.ref, str) and u.ref.startswith(('service:', 'builtin:')):
                row['service'] = u.ref
        row['started_at'] = min(row['started_at'], u.first_ts)
        row['ended_at'] = max(row['ended_at'], u.last_ts)
        row['via_token'] = row['via_token'] or u.via_token
        row['documents'] |= u.documents
        row['counts'] += u.counts
        row['sources'] += u.sources
        row['credentials'] += u.credentials

    def _event(self, unit: Unit, written_at: str, r: Row, units: Dict[str, Unit], category=None, fields=None):
        other = units[r.unit]
        ev = {'at': r.ts, 'after_s': seconds_between(written_at, r.ts),
              'actor_class': ACTOR.get(other.cls, 'person'), 'actor_kind': other.cls,
              'actor': self.p.user(other.user_id),
              'by_requester': bool(other.user_id and other.user_id == unit.user_id),
              'via_token': bool(r.token_id), 'credential': r.credential, 'unit_id': other.id}
        if r.change != 'delete':
            meta = (r.state or {}).get('metadata') or {}
            ev.update({'category': category, 'fields': fields, 'prov_after': prov_state(meta),
                       'source_after': self.p.source(meta.get('provSource')),
                       'value_after': clip(value_of(r.table, r.state))})
        return ev

    def _fate(self, unit: Unit, rows: List[Row], idx: List[int], all_idx: List[int], units) -> Dict[str, Any]:
        first, last = rows[idx[0]], rows[idx[-1]]
        written = last.state
        meta = (written or {}).get('metadata') or {}
        out = {
            'unit_id': unit.id, 'unit_kind': unit.cls, 'legacy': unit.legacy,
            'project_id': unit.project_id, 'table': last.table, 'target_id': last.target,
            'document_id': last.document_id, 'vocab_layer_id': last.vocab_layer_id,
            'written_change': ('delete' if last.change == 'delete'
                               else 'insert' if first.change == 'insert' else 'update'),
            'written_at': last.ts, 'observed_s': seconds_between(last.ts, self.horizon),
            'prov_written': prov_state(meta) if written is not None else None,
            'source_written': self.p.source(meta.get('provSource')) if written is not None else None,
            'model_written': (meta['provDetail'].get('model') if isinstance(meta.get('provDetail'), dict)
                              else None),
            'value_written': clip(value_of(last.table, written)),
            'fate': None, 'later_writes': 0, 'later_by': {},
            'first_event': None, 'first_edit': None, 'first_review': None, 'deletion': None,
            'final_exists': last.change != 'delete', 'final_value_same': None,
        }
        if last.change == 'delete':
            out['fate'] = 'deleted_by_run'
            return out
        later = [rows[i] for i in all_idx if i > idx[-1] and rows[i].unit != unit.id]
        prev = written
        by = Counter()
        cats = []
        repaired = False
        for r in later:
            actor = ACTOR.get(units[r.unit].cls, 'person')
            if actor == 'repair' and r.change != 'delete':
                # A repair (an app's repair on open, or a conversion of the
                # stored data such as composing text to NFC) is nobody's
                # edit: the entity reads as it left it from here on, and the
                # write is counted in later_by, but it is never the first
                # event, edit or review, and it decides no fate.
                category, _ = change_category(r.table, prev, r.state)
                prev = r.state
                if category != 'none':
                    by[f'repair.{category}'] += 1
                    repaired = True
                continue
            if r.change == 'delete':
                ev = self._event(unit, last.ts, r, units)
                under = set((prev or {}).get('tokens') or []) | {
                    (prev or {}).get(k) for k in ('source_span_id', 'target_span_id')} - {None}
                ev['cascade'] = bool(under & self._deleted.get(r.unit, set()))
                by[f'{actor}.delete'] += 1
                out['deletion'] = ev
                out['first_event'] = out['first_event'] or {**ev, 'category': 'delete'}
                out['final_exists'] = False
                cats.append('delete')
                prev = None
                break
            category, fields = change_category(r.table, prev, r.state)
            prev = r.state
            if category == 'none':
                continue
            by[f'{actor}.{category}'] += 1
            cats.append(category)
            ev = self._event(unit, last.ts, r, units, category, fields)
            out['first_event'] = out['first_event'] or ev
            if category in ('value', 'metadata') and not out['first_edit']:
                out['first_edit'] = ev
            if category == 'provenance' and not out['first_review']:
                out['first_review'] = ev
        out['later_writes'] = sum(by.values())
        out['later_by'] = dict(by)
        if prev is not None:
            key = nfc_key if repaired else (lambda k: k)
            out['final_value_same'] = key(value_key(last.table, prev)) == key(value_key(last.table, written))
        if 'delete' in cats:
            out['fate'] = f'deleted_by_{out["deletion"]["actor_class"]}'
        elif out['first_edit']:
            out['fate'] = f'edited_by_{out["first_edit"]["actor_class"]}'
        elif 'extent' in cats or 'structure' in cats:
            out['fate'] = 'reshaped'
        elif out['first_review']:
            out['fate'] = f'reviewed_by_{out["first_review"]["actor_class"]}'
        else:
            out['fate'] = 'unchanged'
        return out

    def unit_rows(self) -> List[Dict[str, Any]]:
        out = []
        for row in self.units.values():
            r = {k: v for k, v in row.items() if not k.startswith('_')}
            r['documents'] = len(row['documents'])
            r['counts'] = dict(row['counts'])
            r['credentials'] = dict(row['credentials'])
            r['sources'] = {self.p.source(k): v for k, v in row['sources'].items()}
            r['writes'] = sum(row['counts'].values())
            out.append(r)
        return out


def project_streams(db, project_ids: List[str]) -> Tuple[List[str], List[str]]:
    """The documents (live or deleted) and vocabularies whose rows belong to
    these projects."""
    q = ','.join('?' * len(project_ids))
    docs = {r[0] for r in db.execute(
        f'SELECT DISTINCT document_id FROM operations WHERE project_id IN ({q}) AND document_id IS NOT NULL',
        project_ids)}
    docs |= {r[0] for r in db.execute(f'SELECT id FROM documents WHERE project_id IN ({q})', project_ids)}
    vocabs = {r[0] for r in db.execute(f'SELECT vocab_layer_id FROM project_vocabs WHERE project_id IN ({q})',
                                       project_ids)}
    return sorted(docs), sorted(vocabs)


def run(db, fates: Fates, documents: List[str], vocabs: List[str], progress=None) -> None:
    credential = credential_column(db)
    for n, doc in enumerate(documents):
        fates.stream(db.execute(ROW_SQL.format(where='w.document_id = ?', credential=credential), (doc,)))
        if progress:
            progress(f'document {n + 1}/{len(documents)}')
    for vocab in vocabs:
        fates.stream(db.execute(ROW_SQL.format(where='w.vocab_layer_id = ? AND w.document_id IS NULL',
                                               credential=credential), (vocab,)))
