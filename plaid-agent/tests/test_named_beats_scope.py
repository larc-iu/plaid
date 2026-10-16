"""A change made by name beats one a scope finds at approval, in every app,
and the drop is noted for the applied message (core.opkind.named_beats_scope).
igt used to drop it silently, and ud did for a change named twice."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.plan import rule_keep


def test_igt_notes_a_found_change_the_plan_already_makes_by_name():
    ws = fake_ws(FakeClient())
    named = {'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-2', 'span_id': None, 'value': 'fish',
             'label': 'Text 1 s1.w2 "gam": Gloss = "fish"'}
    found = {**named, 'value': 'net', 'label': 'Text 1 s1.w2 "gam": Gloss = "net"'}
    other = {**named, 'token_id': 'w-3', 'label': 'Text 1 s1.w3 "akuna": Gloss = "fish"'}
    notes = []
    keep = rule_keep(ws, [named], notes)
    assert not keep(found) and keep(other)
    assert notes == ['dropped: Text 1 s1.w2 "gam": Gloss = "net" (the plan names its own change there)']
    # At staging nothing is noted.
    assert not rule_keep(ws, [named])(found)
