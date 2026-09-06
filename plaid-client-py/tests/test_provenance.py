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
    REVIEW_KEY, read_review, project_role, is_reviewed, with_reviewed_user, WriterPolicy,
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


# --- review norm + writer policy --------------------------------------------------

def _project(review=None):
    return {'id': 'p', 'maintainers': ['lead@x.com'], 'writers': ['ann@x.com'], 'readers': ['bob@x.com'],
            'config': {'plaid': {REVIEW_KEY: review}} if review else {}}


def test_read_review_normalizes():
    assert read_review(None) == {'users': [], 'roles': []}
    assert read_review({'plaid': {}}) == {'users': [], 'roles': []}
    assert read_review({'plaid': {'review': {'users': ['a', 3, None]}}}) == {'users': ['a'], 'roles': []}
    assert read_review({'plaid': {'review': {'roles': ['writer'], 'users': 'x'}}}) == {'users': [], 'roles': ['writer']}


def test_project_role_and_is_reviewed():
    p = _project()
    assert project_role(p, 'lead@x.com') == 'maintainer'
    assert project_role(p, 'ann@x.com') == 'writer'
    assert project_role(p, 'bob@x.com') == 'reader'
    assert project_role(p, 'root@x.com') is None
    assert project_role(p, 'root@x.com', is_admin=True) == 'maintainer'
    assert not is_reviewed(p, 'ann@x.com')
    assert is_reviewed(_project({'users': ['ann@x.com']}), 'ann@x.com')
    assert is_reviewed(_project({'users': ['lead@x.com']}), 'lead@x.com')
    assert is_reviewed(_project({'roles': ['writer']}), 'ann@x.com')
    assert not is_reviewed(_project({'roles': ['writer']}), 'lead@x.com')
    assert is_reviewed(_project({'roles': ['maintainer']}), 'root@x.com', is_admin=True)
    assert not is_reviewed(None, 'ann@x.com')


def test_with_reviewed_user_is_pure_and_keeps_roles():
    r = {'users': ['ann@x.com'], 'roles': ['writer']}
    assert with_reviewed_user(r, 'bob@x.com', True) == {'users': ['ann@x.com', 'bob@x.com'], 'roles': ['writer']}
    assert with_reviewed_user(r, 'ann@x.com', False) == {'users': [], 'roles': ['writer']}
    assert with_reviewed_user(None, 'ann@x.com', True) == {'users': ['ann@x.com'], 'roles': []}
    assert r == {'users': ['ann@x.com'], 'roles': ['writer']}


def test_writer_policy():
    v = WriterPolicy(None)
    assert not v.is_contributor and v.create_stamp is None
    assert v.edit_stamp(CONTRIB) == {'provConfirmed': True}
    assert v.confirm_stamp(stamp_inferred('x')) == {'provConfirmed': True}
    assert v.confirm_stamp(confirmed_inferred('x')) is None
    assert v.reviewable(CONTRIB) and v.reviewable_state(CONTRIBUTED_STATE)
    assert v.adopt_stamp('g', {'value': 'cat'}) == {'prov': 'inferred', 'provSource': 'g', 'provConfirmed': True,
                                                   'provDetail': {'value': 'cat'}}
    c = WriterPolicy('ann@x.com')
    assert c.is_contributor and c.create_stamp == CONTRIB
    assert c.edit_stamp(confirmed_inferred('x')) == {**CONTRIB, 'provConfirmed': None}
    assert c.confirm_stamp(stamp_inferred('x')) == {**CONTRIB, 'provConfirmed': None}
    assert c.confirm_stamp(CONTRIB) is None
    assert c.reviewable(stamp_inferred('x')) and not c.reviewable(CONTRIB)
    assert not c.reviewable_state(CONTRIBUTED_STATE)
    assert c.adopt_stamp('g', {'value': 'cat'}) == {**CONTRIB, 'provDetail': {'value': 'cat', 'guess': 'g'}}
