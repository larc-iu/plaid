"""An approved correction of one morpheme (set_morpheme) is stamped as the
editor's updateMorphemeForm and setMorphemeType stamp it, so a corrected
machine morpheme is reviewed work and a re-analysis without Overwrite leaves
it alone. A respelling carried into a morpheme's form stays unstamped, as in
Bulk Edit."""

from plaid_client.testing import as_fragment

from fixtures import FakeClient, document_raw, scan_ws

from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool

MACHINE = {'prov': 'inferred', 'provSource': 'service:igt:analyze:llm', 'provDetail': {'form': 'di'}}
SOURCE = 'service:igt:assist:x'


def machine_analysed():
    """The fixture with w1's two morphemes and their glosses made by a model."""
    raw = document_raw()
    for tl in raw['text_layers']:
        for tk in tl['token_layers']:
            for t in tk.get('tokens', []):
                if t['id'] in ('m-1a', 'm-1b'):
                    t['metadata'] = {**t['metadata'], **MACHINE}
            for sl in tk.get('span_layers', []):
                for sp in sl.get('spans', []):
                    if set(sp.get('tokens') or []) & {'m-1a', 'm-1b'}:
                        sp['metadata'] = dict(MACHINE)
    return raw


def _token_patch(c, token_id):
    return next(as_fragment(p) for tid, p in c.patches('tokens') if tid == token_id)


def test_an_approved_form_correction_is_stamped():
    w = scan_ws(FakeClient(documents={'d1': machine_analysed()}))
    assert 'Planned 1' in call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m2', 'form': 'de'})
    w.client.calls.clear()
    execute_plan(w.client, w.ops, source=SOURCE, label='l', project=w.project)
    patch = _token_patch(w.client, 'm-1b')
    assert patch['form'] == 'de'
    assert patch['prov'] == 'inferred' and patch['provSource'] == SOURCE and patch['provConfirmed'] is True
    # What the analyzer recorded describes the form this replaces.
    assert patch['provDetail'] is None


def test_an_approved_type_correction_is_stamped_and_a_contributors_is_contributed():
    w = scan_ws(FakeClient(documents={'d1': machine_analysed()}))
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's1.w1.m2', 'type': 'prefix'})
    w.client.calls.clear()
    execute_plan(w.client, w.ops, source=SOURCE, label='l', project=w.project,
                 stamp_mode='contributed', contributor='bob@x.com')
    patch = _token_patch(w.client, 'm-1b')
    assert patch['morphType'] == 'prefix'
    assert patch['prov'] == 'contributed' and patch['provSource'] == 'user:bob@x.com'
    assert patch['provConfirmed'] is None


def test_a_respelling_carried_into_a_morphemes_form_is_not_stamped():
    ops = [{'kind': 'set_morpheme_form', 'morpheme_id': 'm-1b', 'form': 'de', 'label': ''}]
    c = FakeClient(documents={'d1': machine_analysed()})
    execute_plan(c, ops, source=SOURCE, label='l')
    assert _token_patch(c, 'm-1b') == {'form': 'de'}
