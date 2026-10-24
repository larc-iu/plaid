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
    is_protected, needs_review, verify_on_edit, contribute_on_edit,
    service_source, user_source,
    REVIEW_KEY, read_review, project_role, is_reviewed, with_reviewed_user, WriterPolicy,
    VALUE_PROBS_KEY, FORM_PROBS_KEY, read_value_probs,
)
from plaid_client.metadata_ops import apply_metadata_ops, metadata_ops

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
    after = apply_metadata_ops(before, metadata_ops(frag))
    assert after == {**CONTRIB, 'provProb': 0.8, 'provDetail': {'value': 'PL'}}
    assert prov_state(after) == CONTRIBUTED_STATE
    assert prov_state(apply_metadata_ops(None, metadata_ops(frag))) == CONTRIBUTED_STATE


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


def test_value_edit_stamp_matches_the_js_client():
    v = WriterPolicy(None)
    m = stamp_inferred('service:x', prob=0.8, detail={'value': 'cat'})
    assert v.value_edit_stamp(m) == {'provConfirmed': True, 'provProb': None}
    assert v.value_edit_stamp(m, prob=0.15) == {'provConfirmed': True, 'provProb': 0.15}
    assert v.value_edit_stamp(m, changes=False) == {'provConfirmed': True}
    assert v.value_edit_stamp(m, changes=False, prob=0.15) == {'provConfirmed': True}
    assert v.value_edit_stamp(None) is None
    assert v.value_edit_stamp({**m, 'provConfirmed': True}) == {'provProb': None}
    c = WriterPolicy('ann@x.com')
    assert c.value_edit_stamp(m) == {**CONTRIB, 'provConfirmed': None, 'provProb': None}
    assert c.value_edit_stamp(m, prob=0.15) == {**CONTRIB, 'provConfirmed': None, 'provProb': 0.15}


# R5 and REV-PROV-3: provProb is the producer's probability for the value now
# held, however it was entered, read from the entity's own distribution.
# Mirrors provenance.test.js row for row.
def test_value_edit_stamp_reads_the_producers_probability_for_the_new_value():
    v = WriterPolicy(None)
    m = stamp_inferred('service:x', prob=0.6, detail={
        'value': 'NOUN', 'valueProbs': {'NOUN': 0.6, 'PROPN': 0.3, 'X': 2, '': 0.1},
        'formProbs': {'kat': 0.7}})
    assert v.value_edit_stamp(m, value='PROPN') == {'provConfirmed': True, 'provProb': 0.3}
    assert v.value_edit_stamp(m, value='VERB') == {'provConfirmed': True, 'provProb': None}
    assert v.value_edit_stamp(m, value='X') == {'provConfirmed': True, 'provProb': None}
    assert v.value_edit_stamp(m, value='constructor') == {'provConfirmed': True, 'provProb': None}
    assert v.value_edit_stamp(m, value='PROPN', prob=0.25) == {'provConfirmed': True, 'provProb': 0.25}
    assert v.value_edit_stamp(m, value='PROPN', changes=False) == {'provConfirmed': True}
    assert v.value_edit_stamp(m, value='kat', probs_key=FORM_PROBS_KEY) == {
        'provConfirmed': True, 'provProb': 0.7}
    assert v.value_edit_stamp(m, value='PROPN', probs_key=FORM_PROBS_KEY) == {
        'provConfirmed': True, 'provProb': None}
    c = WriterPolicy('ann@x.com')
    assert c.value_edit_stamp(m, value='PROPN') == {**CONTRIB, 'provConfirmed': None, 'provProb': 0.3}
    verified = {**stamp_inferred('service:x', detail={'valueProbs': {'a': 0}}), 'provConfirmed': True}
    assert v.value_edit_stamp(verified, value='a') == {'provProb': 0}


def test_read_value_probs_keeps_only_the_probabilities_under_the_key_asked_for():
    md = {'provDetail': {'valueProbs': {'a': 0.5, 'b': 2, 'c': 'x', 'd': float('nan'), '': 0.2, 'e': 0},
                         'formProbs': {'f': 1}}}
    assert read_value_probs(md) == {'a': 0.5, 'e': 0}
    assert read_value_probs(md, VALUE_PROBS_KEY) == {'a': 0.5, 'e': 0}
    assert read_value_probs(md, FORM_PROBS_KEY) == {'f': 1}
    for bad in [None, {}, {'provDetail': None}, {'provDetail': {'valueProbs': [0.5]}},
                {'provDetail': {'valueProbs': {'a': 3}}}, {'provDetail': {'valueProbs': 'x'}}]:
        assert read_value_probs(bad) is None, bad


# REV-PROV-5: provProb is a probability, in [0, 1], and both clients take
# nothing else as one. Mirrors provenance.test.js row for row.
ODD_PROBS = [2, -1, 1.0001, float('nan'), float('inf'), float('-inf'), '0.5', True, False, {}, [0.5]]


def test_value_edit_stamp_takes_only_a_probability_as_a_picks_prob():
    v = WriterPolicy(None)
    m = stamp_inferred('service:x', prob=0.8)
    for prob in ODD_PROBS:
        assert v.value_edit_stamp(m, prob=prob) == {'provConfirmed': True, 'provProb': None}, prob
    assert v.value_edit_stamp(m, prob=0) == {'provConfirmed': True, 'provProb': 0}
    assert v.value_edit_stamp(m, prob=1) == {'provConfirmed': True, 'provProb': 1}
    assert v.value_edit_stamp({'prov': 'inferred', 'provSource': 'x', 'provConfirmed': True}, prob=2) is None


def test_a_machine_stamp_carries_prov_prob_only_when_it_is_a_probability():
    for prob in ODD_PROBS:
        assert stamp_inferred('service:p', prob=prob) == {'prov': 'inferred', 'provSource': 'service:p'}, prob
        assert confirmed_inferred('service:p', prob=prob) == {
            'prov': 'inferred', 'provSource': 'service:p', 'provConfirmed': True}, prob
    assert stamp_inferred('service:p', prob=1) == {'prov': 'inferred', 'provSource': 'service:p', 'provProb': 1}


def test_repoint_stamp_matches_the_js_client():
    m = confirmed_inferred('service:stanza', prob=0.9, detail={'value': 'obl'})
    assert WriterPolicy(None).repoint_stamp(m) == {
        'prov': None, 'provSource': None, 'provConfirmed': None, 'provProb': None, 'provDetail': None}
    assert WriterPolicy(None).repoint_stamp(None) is None
    assert WriterPolicy(None).repoint_stamp({'note': 'x'}) is None
    assert WriterPolicy('ann@x.com').repoint_stamp(m) == {
        **CONTRIB, 'provConfirmed': None, 'provProb': None, 'provDetail': None}
    assert WriterPolicy('ann@x.com').repoint_stamp(None) == CONTRIB
    ops = metadata_ops(WriterPolicy(None).repoint_stamp(m))
    assert apply_metadata_ops({**m, 'note': 'x'}, ops) == {'note': 'x'}


def test_confidence_threshold_and_doubtful_values_match_the_js_client():
    from plaid_client import (DEFAULT_CONFIDENCE_THRESHOLD, read_confidence_threshold,
                              machine_prob, is_doubtful, stamp_inferred)
    assert read_confidence_threshold(None) == DEFAULT_CONFIDENCE_THRESHOLD == 0.5
    assert read_confidence_threshold({'plaid': {'confidence': {'threshold': 0.3}}}) == 0.3
    assert read_confidence_threshold({'plaid': {'confidence': {'threshold': 0}}}) == 0
    for bad in (1.5, '0.3', True, None):
        assert read_confidence_threshold({'plaid': {'confidence': {'threshold': bad}}}) == 0.5
    m = stamp_inferred('service:x', prob=0.38)
    assert machine_prob(m) == 0.38 and is_doubtful(m, 0.5) and not is_doubtful(m, 0.3)
    assert machine_prob({**m, 'provConfirmed': True}) is None
    assert machine_prob({**m, 'prov': 'contributed'}) is None
    assert machine_prob(stamp_inferred('service:x')) is None
    assert machine_prob({**m, 'provProb': float('nan')}) is None
