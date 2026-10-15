"""The igt app's user guide behind one short schema (survey item 16,
ec2aac2c): the outline with no topic, a part by name, and a near miss
answered with the parts that mention it. The guide is the app's own."""

from fixtures import FakeClient, fake_ws

from plaid_agent.core.bidi import for_model
from plaid_agent.igt import guide
from plaid_agent.igt.toolkit import TOOLS, call_tool
from plaid_agent.igt.trace import TRACER, describe_step


def _call(args):
    return for_model(call_tool(fake_ws(FakeClient()), 'app_guide', args))


def test_no_topic_lists_the_parts_of_the_guide():
    out = _call({})
    assert out.startswith('The Plaid IGT user guide. Ask for a part with topic')
    assert '  Projects: Sentences, words, and morphemes, Documents' in out and '  Media' not in out
    assert 'Media, Tokenize' in out


def test_a_topic_gives_that_part_as_the_guide_has_it():
    out = _call({'topic': 'transcript'})
    assert out.startswith('From the Plaid IGT user guide, "Projects > Media > Transcript":\n### Transcript')
    assert 'New segment' in out and '++++' not in out and ':toc:' not in out
    # A whole chapter carries its sections, and one too long for an answer lists them.
    assert '## Timeline' in _call({'topic': 'Media'})
    out = _call({'topic': 'Projects'})
    assert len(out) <= guide.MAX_CHARS + 600 and 'Its parts, each asked for by name: "Sentences, words' in out


def test_a_topic_no_part_is_called_names_the_parts_that_mention_it():
    out = _call({'topic': 'split a segment'})
    assert out.startswith('No part of the guide is called "split a segment". Parts that mention it: '
                          '"Projects > Media > Transcript"')
    out = _call({'topic': 'zzzqqq'})
    assert out.startswith('No part of the guide is called "zzzqqq" or mentions it. Its parts:')


def test_the_guide_is_the_apps_own_and_the_package_carries_a_copy():
    if guide.REPO_GUIDE.is_file():
        assert guide.guide_source() == guide.REPO_GUIDE.read_text(encoding='utf-8')
    assert guide.PACKAGED_GUIDE.is_file()
    assert guide.parse(guide.PACKAGED_GUIDE.read_text(encoding='utf-8')).children


def test_it_is_one_short_schema_and_a_read_of_the_manual():
    [schema] = [t for t in TOOLS if t['function']['name'] == 'app_guide']
    assert len(schema['function']['description']) < 100
    assert list(schema['function']['parameters']['properties']) == ['topic']
    assert TRACER.call_kind('app_guide', {'topic': 'Media'}) == 'meta'
    line = describe_step('app_guide', {'topic': 'Media'})
    assert (line['text'] if isinstance(line, dict) else str(line)) == 'Read the app guide on “Media”'


def test_no_answer_carries_asciidoc_markup():
    """H16-IGT-TOOLS-11: a cross reference reads as the name of the part it
    points to, which app_guide takes as a topic, and a table as rows of
    cells. Every part of the guide."""
    import re
    root = guide.parse(guide.guide_source())
    every = list(guide._walk(root))
    for s in every:
        text = s.text()
        assert not re.search(r'<<|>>|\|===|\[cols=|^----$|\[\[', text, re.M), (s.path, text)
        assert not re.search(r'(?<![\w"])_[a-z]+_[a-z_]+', text), (s.path, text)
        # Every quoted part name a reference left is one app_guide finds.
    out = _call({'topic': 'Services'})
    assert '"Services"' in out or 'Services' in out
    sentences = _call({'topic': 'Sentences, words, and morphemes'})
    assert '| Scope | What it is' not in sentences and 'Scope | What it is' in sentences, sentences
    assert 'Sentence | A stretch of the baseline text.' in sentences.replace('**', ''), sentences


def test_a_reference_names_a_part_app_guide_finds():
    import re
    root = guide.parse(guide.guide_source())
    refs = set()
    for s in guide._walk(root):
        for line in s.lines:
            refs.update(re.findall(r'\(see "([^"]+)"\)', line))
    assert refs, 'the guide has references'
    for r in refs:
        named, _ = guide.find(root, r)
        assert named and named[0].path.endswith(r.split(' > ')[-1]), r
