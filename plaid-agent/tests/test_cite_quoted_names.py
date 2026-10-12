"""A cited document whose name holds a quote: the value runs to the quote that
ends the attribute, not the first one inside the name. 17 of 25 citations in
one reply showed as raw tags over Coniugazione "potere" (2026-10-12 survey)."""
import re

import pytest

from plaid_agent.core.citations import cited, tag_parts

NEVER = re.compile(r'(?!)')


@pytest.mark.parametrize('attrs, doc, ref', [
    (' doc="Coniugazione "potere"" ref="s1.w2"', 'Coniugazione "potere"', 's1.w2'),
    (' doc="Il verbo "potere" al presente" ref="s3" ', 'Il verbo "potere" al presente', 's3'),
    (' ref="s3" doc="Coniugazione "potere""', 'Coniugazione "potere"', 's3'),
    (" doc='The children's story' ref='s2'", "The children's story", 's2'),
    (' doc="Text 1" ref="s4"', 'Text 1', 's4'),
    (' doc="Text 1"ref="s4"', 'Text 1', 's4'),
])
def test_a_quoted_value_runs_to_its_closing_quote(attrs, doc, ref):
    assert tag_parts(attrs)[:2] == (doc, ref)


def test_a_reply_citing_a_quoted_name_finds_every_citation():
    text = ('Two forms: <cite doc="Coniugazione "potere"" ref="s1"/> and '
            '<cite doc="Coniugazione "potere"" ref="s2" />.')
    assert [(d, r) for _k, d, r, _v, _p in cited(text, '', NEVER, NEVER)] == [
        ('Coniugazione "potere"', 's1'), ('Coniugazione "potere"', 's2')]
