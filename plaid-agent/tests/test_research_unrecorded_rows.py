"""The extractor reads a document's live rows that no audit row names as
inserts by the operation that created the document, as core's as-of read
does. Core writes no audit row for the rows an import (or a copy, or an
assistant plan's new document) makes in a document it created, and records
such a row whole before its first change."""

import json
import sqlite3

from plaid_agent.research import fates as F
from plaid_agent.research.pseudo import Pseudonyms

SCHEMA = """
CREATE TABLE operation_groups (id TEXT PRIMARY KEY, kind TEXT, ref TEXT, message TEXT, user_id TEXT, created_at TEXT);
CREATE TABLE operations (id TEXT PRIMARY KEY, op_type TEXT, project_id TEXT, document_id TEXT, user_id TEXT,
                         token_id TEXT, group_id TEXT, batch_id TEXT, ts TEXT, credential TEXT);
CREATE TABLE audit_writes (id INTEGER PRIMARY KEY, op_id TEXT, seq INTEGER, target_table TEXT, target_id TEXT,
                           change_type TEXT, post_image TEXT, ts TEXT, document_id TEXT, vocab_layer_id TEXT);
CREATE TABLE tokens (id TEXT PRIMARY KEY, text_id TEXT, token_layer_id TEXT, document_id TEXT, begin INTEGER,
                     end_ INTEGER, precedence INTEGER);
CREATE TABLE spans (id TEXT PRIMARY KEY, span_layer_id TEXT, document_id TEXT, value TEXT);
CREATE TABLE span_tokens (span_id TEXT, token_id TEXT, order_idx INTEGER);
CREATE TABLE relations (id TEXT PRIMARY KEY, relation_layer_id TEXT, document_id TEXT, source_span_id TEXT,
                        target_span_id TEXT, value TEXT);
CREATE TABLE vocab_links (id TEXT PRIMARY KEY, vocab_item_id TEXT, document_id TEXT);
CREATE TABLE vocab_link_tokens (vocab_link_id TEXT, token_id TEXT, order_idx INTEGER);
CREATE TABLE entity_metadata (entity_type TEXT, entity_id TEXT, key TEXT, value TEXT);
"""


def ts(n):
    return f'2026-10-20T00:00:{n:02d}.000000000Z'


def world():
    """An import made document d1 and its tokens and glosses, with no audit
    row for them. A service run then drew a relation between the two glosses
    and changed the second, which core recorded whole first."""
    db = sqlite3.connect(':memory:')
    db.executescript(SCHEMA)
    db.execute("INSERT INTO operation_groups VALUES ('gi', 'import', NULL, 'Import', 'ada@x', ?)", (ts(0),))
    db.execute("INSERT INTO operation_groups VALUES ('gs', 'service-run', 'service:s', 'Run', 'ada@x', ?)", (ts(9),))
    ops = [('oi1', 'document/create', 'gi', 1), ('oi2', 'token/bulk-create', 'gi', 2),
           ('oi3', 'span/bulk-create', 'gi', 3), ('os1', 'relation/create', 'gs', 10),
           ('os2', 'span/update-attributes', 'gs', 11)]
    for op, typ, g, n in ops:
        db.execute('INSERT INTO operations VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
                   (op, typ, 'p1', 'd1', 'ada@x' if g == 'gi' else 'svc@x', g, ts(n), 'login'))
    aw = lambda op, seq, table, target, change, image, n: db.execute(  # noqa: E731
        'INSERT INTO audit_writes (op_id, seq, target_table, target_id, change_type, post_image, ts, document_id)'
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (op, seq, table, target, change, json.dumps(image) if image else None, ts(n), 'd1'))
    aw('oi1', 0, 'documents', 'd1', 'insert', {'name': 'D'}, 1)
    for t, b in (('t1', 0), ('t2', 3)):
        db.execute("INSERT INTO tokens VALUES (?, 'x', 'tl', 'd1', ?, ?, NULL)", (t, b, b + 2))
    db.execute("INSERT INTO spans VALUES ('s1', 'sl', 'd1', '\"NOUN\"')")
    db.execute("INSERT INTO spans VALUES ('s2', 'sl', 'd1', '\"later\"')")
    db.execute("INSERT INTO span_tokens VALUES ('s1', 't1', 0), ('s2', 't2', 0)")
    db.execute("INSERT INTO entity_metadata VALUES ('span', 's1', 'prov', '\"imported\"')")
    db.execute("INSERT INTO relations VALUES ('r1', 'rl', 'd1', 's1', 's2', '\"dep\"')")
    # the service's relation, recorded on insert
    aw('os1', 0, 'relations', 'r1', 'insert',
       {'relation_layer_id': 'rl', 'source_span_id': 's1', 'target_span_id': 's2', 'value': '"dep"',
        'metadata': {'prov': 'inferred', 'provSource': 'service:s'}}, 10)
    # s2 recorded whole under the import's first operation, then its update
    aw('oi1', -1, 'spans', 's2', 'insert', {'span_layer_id': 'sl', 'value': '"VERB"', 'tokens': ['t2']}, 1)
    aw('os2', 0, 'spans', 's2', 'update',
       {'span_layer_id': 'sl', 'value': '"later"', 'metadata': {'prov': 'inferred', 'provSource': 'service:s'}}, 11)
    return db


def test_a_relation_between_unrecorded_glosses_is_anchored_on_their_words():
    fates = F.Fates(Pseudonyms(b'k' * 32), ts(30))
    F.run(world(), fates, ['d1'], [])
    by = {w['target_id']: w for w in fates.writes}
    assert set(by) == {'r1', 's2'}
    assert set(by['r1']['_anchors']) == {'r1', 's1', 's2', 't1', 't2'}
    assert by['s2']['written_change'] == 'update' and by['s2']['fate'] == 'unchanged'


def test_an_import_counts_the_rows_it_left_unrecorded():
    fates = F.Fates(Pseudonyms(b'k' * 32), ts(30), track=('import',))
    F.run(world(), fates, ['d1'], [])
    [unit] = fates.unit_rows()
    assert unit['kind'] == 'import'
    assert unit['counts'] == {'tokens.insert': 2, 'spans.insert': 2}
    by = {w['target_id']: w for w in fates.writes}
    assert by['s1']['fate'] == 'unchanged' and by['s1']['value_written'] == 'NOUN'
    assert by['s2']['fate'] == 'edited_by_machine'
    assert by['t1']['written_at'] == ts(1)


def test_a_document_whose_rows_are_all_recorded_reads_as_before():
    db = world()
    rows = db.execute(F.ROW_SQL.format(where='w.document_id = ?', credential='o.credential'), ('d1',)).fetchall()
    for table, target in (('tokens', 't1'), ('tokens', 't2'), ('spans', 's1')):
        rows.append((ts(1), 0, table, target, 'insert', '{}', 'd1', None))
    assert len(F.unrecorded_rows(db, 'd1', rows, 'o.credential')) == 0
