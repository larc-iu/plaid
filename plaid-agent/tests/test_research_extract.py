"""The research extractor's pieces that need no database: how a tool's
refusal, a turn's end and an audit change are classed, and the pseudonyms.
The whole extractor runs against a real core in test_research_extract_live.py."""

import pytest

from plaid_agent.core.conversation import PROPOSED_VALUE_MAX
from plaid_agent.research.fates import change_category, prov_state, value_of
from plaid_agent.research.pseudo import VALUE_MAX, Pseudonyms, clip, load_salt
from plaid_agent.research.records import error_class, snake, turn_end, uuid7_time


@pytest.mark.parametrize('text,cls', [
    ('Error: Query rejected: HTTP 400 :find must be a list of vars', 'query_rejected'),
    ('Error: "Gloss" names several fields; say which: Gloss (Word), Gloss (Morpheme)', 'ambiguous'),
    ('Error: Several entries match "kai"; pass entry_id', 'ambiguous'),
    ('Error: No lexicon entry "kai". Use read_lexicon to look', 'not_found'),
    ('Error: s1.w2: sentence s1 has 1 words', 'not_found'),
    ("Error: lexicon_entry cannot be called with those arguments. It takes: form.", 'bad_arguments'),
    ('Error: That would bring the plan to 3163 changes, more than the 3000 one plan may hold.', 'plan_limit'),
    ('Error: Traceback (most recent call last):\n  File "x"', 'code_exception'),
    ('Error: No parser is connected to this project right now.', 'unavailable'),
    ('Error: query failed, which is a fault in the tool rather than in the request.', 'tool_fault'),
    ('Error: s1.w5 already starts sentence s1.', 'plan_conflict'),
    ('Error: something new', 'other'),
    (None, 'unknown'),
])
def test_error_classes(text, cls):
    assert error_class(text) == cls


def test_turn_ends():
    assert turn_end({'kind': 'error', 'stopped': True}) == 'stopped'
    assert turn_end({'kind': 'error'}) == 'failed'
    assert turn_end({'kind': 'assistant', 'text': 'x\n\n*(Stopped after the same step failed 3 times.)*'}) == \
        'stopped_repeat'
    assert turn_end({'kind': 'assistant', 'text': 'x\n\n*(Stopped at the step limit.)*'}) == 'step_limit'
    assert turn_end({'kind': 'assistant', 'text': '(The model returned an empty reply.)'}) == 'empty_reply'
    assert turn_end({'kind': 'assistant', 'text': "x\n\n*(The reply was cut off at the model's output limit.)*"}) \
        == 'cut_at_length'
    assert turn_end({'kind': 'assistant', 'text': 'Here.'}) == 'answered'


def test_changes_are_classed_on_folded_images():
    span = {'id': 's', 'value': '"kai"', 'tokens': ['t1'], 'metadata': {'prov': 'inferred', 'provSource': 'x'}}
    assert change_category('spans', span, {**span, 'value': '"kae"'})[0] == 'value'
    assert change_category('spans', span, {**span, 'metadata': {**span['metadata'], 'note': 'n'}})[0] == 'metadata'
    assert change_category('spans', span, {**span, 'tokens': ['t2']})[0] == 'extent'
    confirmed = {**span, 'metadata': {**span['metadata'], 'provConfirmed': True}}
    assert change_category('spans', span, confirmed) == ('provenance', ['metadata.provConfirmed'])
    assert change_category('spans', span, dict(span))[0] == 'none'
    assert value_of('spans', span) == 'kai'
    assert value_of('tokens', {'metadata': {'form': '-ar'}}) == '-ar'


def test_provenance_states():
    assert prov_state(None) == 'human'
    assert prov_state({'prov': 'inferred'}) == 'machine'
    assert prov_state({'prov': 'inferred', 'provConfirmed': True}) == 'verified'
    assert prov_state({'prov': 'contributed'}) == 'contributed'
    assert prov_state({'prov': 'something-else'}) == 'machine'


def test_clip_matches_the_plan_record():
    assert VALUE_MAX == PROPOSED_VALUE_MAX
    assert clip('x' * 30) == 'x' * 23 + '…' and clip('short') == 'short' and clip(3) == 3 and clip({}) is None


def test_record_keys_and_ids():
    assert snake({'op-count': 1, 'plan': {'proposed-count': 2}}) == {'op_count': 1, 'plan': {'proposed_count': 2}}
    assert uuid7_time('01999c3e-8a40-7000-8000-000000000000').startswith('2025-')
    assert uuid7_time('3fbfaf98e4974effa862e603e248db3f') is None


def test_pseudonyms_and_the_salt(tmp_path):
    out = tmp_path / 'out'
    with pytest.raises(SystemExit):
        load_salt(out / 'salt', out)
    salt = load_salt(tmp_path / 'salt', out)
    assert load_salt(tmp_path / 'salt', out) == salt
    p = Pseudonyms(salt)
    assert p.user('a@b.com') == p.user('a@b.com') != Pseudonyms(b'x' * 32).user('a@b.com')
    assert 'a@b.com' not in p.user('a@b.com') and p.source('user:a@b.com').startswith('user:u-')
    assert p.source('service:polygloss') == 'service:polygloss'
