"""The plaid-agent items of the 2026-10-16 sweep outside the plan rules
(build-2026-10-15/SWEEP-OPEN.md, fix round FX-G-AGENT)."""
from fixtures import fake_ws, FakeClient

from plaid_agent.igt.toolkit import call_tool


def igt_ws():
    return fake_ws(FakeClient())


def test_an_igt_label_names_the_place_once_whatever_form_the_ref_carries():
    """A word named by its form, or with its form beside the number, is
    labelled by its place and its form once: never `s1."gam" "gam"`."""
    for ref in ('s1."gam"', 's1.w2 "gam"', 's1.w2'):
        w = igt_ws()
        out = call_tool(w, 'set_field', {'document': 'd1', 'refs': [ref], 'field': 'Gloss',
                                        'value': 'n'})
        assert out.startswith('Planned'), out
        assert w.ops[-1]['label'] == 'Text 1 s1.w2 "gam": Gloss = "n"', (ref, w.ops[-1]['label'])
