"""A citation's list of references, read by one reader for every app
(`core.refs.read_ref_list`) through the same `read_ref` every tool uses."""

import pytest

from plaid_agent.core.refs import read_ref_list

IGT, UD = (('w', 'm'), False), (('w',), True)


@pytest.mark.parametrize('ref,want', [
    ('s3', ['s3']),
    ('s3.w2,w5', ['s3.w2', 's3.w5']),
    ('s3.w2.m1,m3', ['s3.w2.m1', 's3.w2.m3']),
    ('s3.w2 and w5', ['s3.w2', 's3.w5']),
    ('s3.w2,s4.w1', ['s3.w2', 's4.w1']),
    ('s3.w2;w4 w6', ['s3.w2', 's3.w4', 's3.w6']),
    ('s3.w2,garbage', ['s3.w2']),
    # Spelled as a tool takes it, not only as a tool prints it.
    ('S3.W2', ['s3.w2']),
    ('s3:w2', ['s3.w2']),
])
def test_igt(ref, want):
    assert read_ref_list(ref, *IGT) == want


@pytest.mark.parametrize('ref,want', [
    ('s3.w2,w5', ['s3.w2', 's3.w5']),
    ('s1.w2-3', ['s1.w2-3']),
    ('s3.w2,3', ['s3.w2', 's3.w3']),
    ('s3.w2, w4-5', ['s3.w2', 's3.w4-5']),
    ('s3.w2,s4', ['s3.w2', 's4']),
])
def test_ud(ref, want):
    assert read_ref_list(ref, *UD) == want


@pytest.mark.parametrize('ref', ['s3.w0', 's3.m1', 'garbage', '', 's0'])
def test_a_list_that_names_nothing_is_refused(ref):
    """A zero is no 1-based place, and a morpheme needs its word."""
    with pytest.raises(ValueError):
        read_ref_list(ref, *IGT)
