"""What the igt read tools spend of a turn's context (FABLE-REVIEW
2026-11-12, change 2). search and concordance printed the whole sentence
after every hit, so a sentence holding five hits was printed five times, and
20 of the 43 recorded concordances ended at the 12,000-character cap with the
rest cut mid-line. A sentence is now printed once with its hits under it, a
render stops at a whole hit and says how many it showed, and concordance
lists 30 occurrences unless asked for more."""
from fixtures import fake_ws, FakeClient

from plaid_agent.igt import reads
from plaid_agent.igt.project import FORMAT_LEGEND
from plaid_agent.igt.toolkit import TOOLS, call_tool


def igt_ws():
    return fake_ws(FakeClient())


def test_a_search_prints_each_sentence_once_above_its_hits():
    out = call_tool(igt_ws(), 'search', {'pattern': 'a'})
    assert out.count('Ali-di gam akuna.') == 1, out
    assert out.startswith('4 hits:\n[s1] Ali-di gam akuna.\n  s1.w1 Ali-di'), out
    assert '\n  s1.w2 gam\n  s1.w3 akuna\n[s2] Gam-ar.\n  s2.w1 Gam-ar' in out, out


def test_a_concordance_prints_each_sentence_once_above_its_occurrences():
    out = call_tool(igt_ws(), 'concordance', {'pattern': 'a', 'regex': True})
    assert out.count('Ali-di gam akuna.') == 1, out
    body = out.split('Occurrences, under their sentence')[1]
    assert '\n  [s1] Ali-di gam akuna.\n    s1.w1.m1 ' in body and '\n    s1.w2.m1 ' in body, out
    assert ' || ' not in body, out


def test_concordance_lists_thirty_unless_asked_for_more():
    assert reads.CONCORDANCE_LIMIT == 30
    tool = next(t for t in TOOLS if t['function']['name'] == 'concordance')
    assert 'default 30' in tool['function']['parameters']['properties']['limit']['description']


def test_a_search_that_would_pass_the_budget_stops_at_a_whole_hit_and_says_so():
    from plaid_agent.igt.queries import _hit_lines
    w = igt_ws()
    doc = w.doc('d1')
    rows = [[{'id': wd.id, 'document': 'd1', 'value': wd.surface}] for s in doc.sentences for wd in s.words]
    lines, shown = _hit_lines(w.corpus, rows, 0, 40, budget=200)
    assert shown == 3, lines
    assert lines[-1] == ('  … stopped at 3 hits, the most one answer holds: name a document or narrow the '
                         'pattern for the rest')
    assert all('[truncated' not in x for x in lines)


def test_a_concordance_that_would_pass_the_budget_stops_at_a_whole_occurrence_and_says_so(monkeypatch):
    whole = call_tool(igt_ws(), 'concordance', {'pattern': 'a', 'regex': True})
    monkeypatch.setattr(reads, 'RENDER_BUDGET', len(whole) - 20)
    out = call_tool(igt_ws(), 'concordance', {'pattern': 'a', 'regex': True})
    assert '[truncated' not in out
    import re
    shown = int(re.match(r'4 occurrences of "a" in morpheme \(showing (\d)\)\.', out).group(1))
    assert 1 <= shown < 4 and out.count('\n    s') == shown, out
    assert out.endswith(f'  ... stopped at {shown} of the 4 asked for, the most one answer holds: name a document '
                        f'for the rest'), out


def test_the_overview_no_longer_asks_to_be_called_first():
    for app in ('igt', 'ud', 'umr'):
        kit = __import__(f'plaid_agent.{app}.toolkit', fromlist=['TOOLS'])
        tool = next(t for t in kit.TOOLS if t['function']['name'] == 'project_overview')
        assert 'Call this first' not in tool['function']['description'], app


def test_the_read_legend_says_how_to_read_a_line_and_nothing_the_prompt_says():
    assert len(FORMAT_LEGEND) < 700
    assert '<cite' not in FORMAT_LEGEND and 'Address items' not in FORMAT_LEGEND
