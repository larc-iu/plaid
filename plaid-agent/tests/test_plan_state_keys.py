"""A plan's stored state names no member by an op: an entry key is the op
itself as JSON, and a merge of an entry with 1,365 links made one of 694,290
characters, which core refuses as a JSON member name (over 50,000), so the
plan was never stored and resume_plan could not take it (H17-ASSIST-7)."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def _member_names(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _member_names(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _member_names(v)


def test_no_member_name_of_the_stored_plan_is_an_op():
    w = fake_ws(FakeClient())
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss',
                                     'value': 'fish'})
    assert 'Planned' in out, out
    state = w.plan_state()
    assert state.get('requests'), state
    # An entry key is JSON (key_of): as a member name it grows with the op.
    assert not [k for k in _member_names(state) if k[:1] in '[{']
