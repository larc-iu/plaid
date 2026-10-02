"""Ids drawn in order from a seed, and the one rule for when a create refused
``id-taken`` was made by an earlier send of the same work (R1-DEBT-CORE-6).
The JS twin of ``minted_taken`` is ``mintedTaken`` in plaid-client-js."""

import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.http import minted_taken  # noqa: E402
from plaid_client.ids import drawn_uuid7, uuid7  # noqa: E402


def test_drawn_ids_are_uuidv7s_in_order_after_the_seed_and_the_same_every_time():
    seed = uuid7()
    ids = [drawn_uuid7(seed, n) for n in range(5000)]
    assert all(uuid.UUID(i).version == 7 for i in ids)
    assert ids == sorted(ids) and len(set(ids)) == len(ids) and seed < ids[0]
    assert [drawn_uuid7(seed, n) for n in range(5000)] == ids
    other = uuid7()
    assert not {drawn_uuid7(other, n) for n in range(100)} & set(ids)
    ms = lambda u: uuid.UUID(u).int >> 80  # noqa: E731
    assert ms(ids[-1]) - ms(seed) in (1, 2)


def test_a_seed_that_is_not_a_uuidv7_is_refused():
    with pytest.raises(ValueError):
        drawn_uuid7(str(uuid.uuid4()), 0)


def test_a_taken_id_is_made_only_when_it_was_minted_and_its_row_is_not_deleted():
    mine = {'a', 'b'}
    assert minted_taken(409, {'error': 'id-taken', 'id': 'a'}, mine)
    # A row deleted since is not made for this work: it surfaces.
    assert not minted_taken(409, {'error': 'id-taken', 'id': 'a', 'deleted': True}, mine)
    assert not minted_taken(409, {'error': 'id-taken', 'id': 'c'}, mine)
    assert not minted_taken(409, {'error': 'Document version mismatch'}, mine)
    assert not minted_taken(422, {'error': 'id-taken', 'id': 'a'}, mine)
    assert not minted_taken(409, {'error': 'id-taken', 'id': 'a'}, None)
    assert not minted_taken(409, None, mine)
