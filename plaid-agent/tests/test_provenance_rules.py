"""The provenance convention's rules live in plaid_client.provenance, and the
agent reads them from there (beta review A7-1, A7-4, A7-8).

- Provenance keys are the convention's list, PROVENANCE_KEYS, never a prefix:
  an entry field of the user's own named "provenance" or "proverb" is content.
- What a value edit does to provProb is WriterPolicy.value_edit_stamp's.
"""
import pathlib
import re

from plaid_agent.igt.lexview import entry_line

REPO = pathlib.Path(__file__).resolve().parents[2]
TREES = ['plaid-agent/src', 'plaid-client-py/src', 'plaid-igt/services', 'plaid-ud/services', 'plaid-umr/services']
OWNER = REPO / 'plaid-client-py/src/plaid_client/provenance.py'
FORBIDDEN = [
    (re.compile(r"""startswith\(\s*['"]prov['"]"""), 'a prov prefix test: use PROVENANCE_KEYS'),
    (re.compile(r"""['"]provProb['"]\s*:\s*None|PROV_PROB_KEY\s*:\s*None"""),
     "a hand-written provProb drop: use WriterPolicy.value_edit_stamp"),
    (re.compile(r"""\(\s*['"]prov['"]\s*,\s*['"]provSource['"]"""), 'a hand list of the keys: use PROVENANCE_KEYS'),
]


def test_no_provenance_rule_outside_the_client_module():
    found = []
    for tree in TREES:
        for path in sorted((REPO / tree).rglob('*.py')):
            if path == OWNER:
                continue
            for i, line in enumerate(path.read_text(encoding='utf8').splitlines(), 1):
                code = line.split('#', 1)[0]
                for pattern, why in FORBIDDEN:
                    if pattern.search(code):
                        found.append(f'{path.relative_to(REPO)}:{i}: {why}')
    assert found == []


def test_an_entry_field_named_like_provenance_is_content():
    line = entry_line({'form': 'dog', 'metadata': {'provenance': 'Smith 1990', 'provSource': 'service:x'}})
    assert 'provenance=Smith 1990' in line
    assert 'service:x' not in line
