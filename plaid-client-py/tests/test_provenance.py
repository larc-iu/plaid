"""Tests for plaid_client.provenance (mirror of the JS client's
test/provenance.test.js).

Run with::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.provenance import (
    HUMAN, MACHINE, CONTRIBUTED_STATE, VERIFIED, INFERRED, CONTRIBUTED,
    stamp_inferred, confirmed_inferred, stamp_contributed, prov_state, prov_origin,
    is_protected, needs_review, verify_on_edit, contribute_on_edit, merge_metadata,
    service_source, user_source,
)

CONTRIB = {'prov': 'contributed', 'provSource': 'user:ann@x.com'}


def test_stamps():
    assert stamp_inferred('service:p') == {'prov': 'inferred', 'provSource': 'service:p'}
    assert confirmed_inferred('flex-import') == {'prov': 'inferred', 'provSource': 'flex-import',
                                                 'provConfirmed': True}
    assert stamp_contributed('ann@x.com') == CONTRIB
    assert service_source('p') == 'service:p'
    assert user_source('ann@x.com') == 'user:ann@x.com'


def test_prov_state_classifies_the_four_states():
    assert prov_state(None) == HUMAN
    assert prov_state({}) == HUMAN
    assert prov_state(stamp_inferred('x')) == MACHINE
    assert prov_state(confirmed_inferred('x')) == VERIFIED
    assert prov_state(CONTRIB) == CONTRIBUTED_STATE
    assert prov_state({**CONTRIB, 'provConfirmed': True}) == VERIFIED
    # an unknown prov value reads as machine, not as human
    assert prov_state({'prov': 'some-future-vocab'}) == MACHINE


def test_prov_origin_survives_confirmation():
    assert prov_origin(None) is None
    assert prov_origin(stamp_inferred('x')) == INFERRED
    assert prov_origin(confirmed_inferred('x')) == INFERRED
    assert prov_origin(CONTRIB) == CONTRIBUTED
    assert prov_origin({**CONTRIB, 'provConfirmed': True}) == CONTRIBUTED


def test_protected_and_needs_review():
    assert is_protected(None)
    assert not is_protected(stamp_inferred('x'))
    assert is_protected(confirmed_inferred('x'))
    assert is_protected(CONTRIB)
    assert not needs_review(None)
    assert needs_review(stamp_inferred('x'))
    assert needs_review(CONTRIB)
    assert not needs_review(confirmed_inferred('x'))
    assert not needs_review({**CONTRIB, 'provConfirmed': True})


def test_verify_on_edit_stamps_only_what_needs_review():
    assert verify_on_edit(stamp_inferred('x')) == {'provConfirmed': True}
    assert verify_on_edit(CONTRIB) == {'provConfirmed': True}
    assert verify_on_edit(None) is None
    assert verify_on_edit(confirmed_inferred('x')) is None


def test_contribute_on_edit_marks_anything_contributed_and_drops_the_confirmation():
    frag = contribute_on_edit(confirmed_inferred('service:x'), 'ann@x.com')
    assert frag == {**CONTRIB, 'provConfirmed': None}
    before = confirmed_inferred('service:x', prob=0.8, detail={'value': 'PL'})
    after = merge_metadata(before, frag)
    assert after == {**CONTRIB, 'provProb': 0.8, 'provDetail': {'value': 'PL'}}
    assert prov_state(after) == CONTRIBUTED_STATE
    assert prov_state(merge_metadata(None, frag)) == CONTRIBUTED_STATE


def test_merge_metadata_deletes_none_valued_keys_and_leaves_the_input_alone():
    m = {'a': 1, 'b': 2}
    assert merge_metadata(m, {'a': None, 'c': 3}) == {'b': 2, 'c': 3}
    assert m == {'a': 1, 'b': 2}
    assert merge_metadata(None, None) == {}
