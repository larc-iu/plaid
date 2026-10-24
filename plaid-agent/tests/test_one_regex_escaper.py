"""A literal goes into a server (Java) regex through one escaper,
``ud.grew.escape_regex`` (A6-3). Python's ``re.escape`` follows Python's
rules, not Java's, and nothing would check that it stays Java-safe."""

from pathlib import Path

UD = Path(__file__).resolve().parents[1] / 'src' / 'plaid_agent' / 'ud'


def test_no_re_escape_in_ud():
    found = [p.name for p in sorted(UD.rglob('*.py')) if 're.escape(' in p.read_text(encoding='utf-8')]
    assert found == []
