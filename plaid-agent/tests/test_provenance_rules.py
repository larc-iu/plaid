"""The provenance convention's rules live in plaid_client.provenance, and the
agent reads them from there (beta review A7-1, A7-4, A7-8).

- Provenance keys are the convention's list, PROVENANCE_KEYS, never a prefix:
  an entry field of the user's own named "provenance" or "proverb" is content.
- What a value edit does to provProb is WriterPolicy.value_edit_stamp's.
- The keys are listed only there, as PROVENANCE_KEYS.

A key named alone in quotes stays allowed: QL patterns and prompts match on
one key, which restates no rule.
"""
import pathlib
import re

import pytest

from plaid_agent.igt.lexview import entry_line

REPO = pathlib.Path(__file__).resolve().parents[2]
TREES = ['plaid-agent/src', 'plaid-client-py/src', 'plaid-igt/services', 'plaid-ud/services', 'plaid-umr/services']
OWNER = REPO / 'plaid-client-py/src/plaid_client/provenance.py'
_KEY = r"""['"](?:prov|provSource|provConfirmed|provDetail|provProb)['"]"""
_CONST = r'\bPROV_(?:SOURCE_|CONFIRMED_|DETAIL_|PROB_)?KEY\b'
FORBIDDEN = [
    (re.compile(r"""(?:startswith\(|\.find\()\s*(?:['"]prov['"]|PROV_KEY\b)|\[\s*:\s*4\s*\]\s*[!=]=\s*['"]prov['"]|['"]\^prov"""),
     'a prov prefix test: use PROVENANCE_KEYS'),
    (re.compile(r"""['"]provProb['"]\s*:\s*None|PROV_PROB_KEY\s*:\s*None"""
                r"""|\.pop\(\s*(?:['"]provProb['"]|PROV_PROB_KEY\b)|\bdel\s+\w[\w.]*\[\s*(?:['"]provProb['"]|PROV_PROB_KEY\b)"""
                r"""|\[\s*(?:['"]provProb['"]|PROV_PROB_KEY)\s*\]\s*=(?!=)|\bprovProb\s*=\s*None"""),
     "a hand-written provProb drop: use WriterPolicy.value_edit_stamp"),
    (re.compile(_KEY + r'\s*,\s*' + _KEY + '|' + _CONST + r'\s*,\s*' + _CONST),
     'a hand list of the keys: use PROVENANCE_KEYS'),
]

# The shapes the gate exists for (beta review REV-PROV-4), and lines it must
# leave alone: a query pattern or a read names one key, which is not a rule.
PLANTED = [
    "md = {**md, 'provProb': None}",
    'md = {**md, PROV_PROB_KEY: None}',
    "md.pop('provProb', None)",
    'md.pop(PROV_PROB_KEY, None)',
    "del md['provProb']",
    'del piece.metadata[PROV_PROB_KEY]',
    "own = [k for k in md if not k.startswith('prov')]",
    'own = [k for k in md if not k.startswith(PROV_KEY)]',
    "own = [k for k in md if k[:4] != 'prov']",
    "own = [k for k in md if not re.match(r'^prov', k)]",
    "KEYS = ('prov', 'provSource', 'provConfirmed', 'provDetail', 'provProb')",
    "KEYS = ['prov', 'provSource', 'provConfirmed']",
    "KEYS = {'prov', 'provSource'}",
    'KEYS = (PROV_KEY, PROV_SOURCE_KEY, PROV_CONFIRMED_KEY, PROV_DETAIL_KEY)',
    'md[PROV_PROB_KEY] = None',
    "md['provProb'] = None",
    'md = dict(md, provProb=None)',
    "own = [k for k in md if k.find('prov') == 0]",
    'own = [k for k in md if k.find(PROV_KEY) != 0]',
]
CLEAN = [
    "unconfirmed = ['not', ['span', '?s', {'metadata': {'provConfirmed': True}}]]",
    "source = meta.get('provSource')",
    "p = prob if ok else None  # {'provProb': None} was written here once",
    "label = 'provenance'",
    'from plaid_client.provenance import PROV_CONFIRMED_KEY, PROV_PROB_KEY, stamp_inferred',
    "same = md['provProb'] == p",
    "return [{'prov': 'contributed', **({'provSource': f'user:{user}'} if user else {})}]",
]


def _broken(code):
    return [why for pattern, why in FORBIDDEN if pattern.search(code)]


def _code_lines(text):
    """(line number, code) for each line outside a comment and an import,
    a parenthesised import's continuation lines included."""
    in_import = False
    for i, line in enumerate(text.splitlines(), 1):
        code = line.split('#', 1)[0]
        stripped = code.strip()
        if in_import:
            in_import = ')' not in code
            continue
        if stripped.startswith(('import ', 'from ')):
            in_import = '(' in code and ')' not in code
            continue
        yield i, code


def test_no_provenance_rule_outside_the_client_module():
    found = []
    for tree in TREES:
        for path in sorted((REPO / tree).rglob('*.py')):
            if path == OWNER:
                continue
            for i, code in _code_lines(path.read_text(encoding='utf8')):
                for why in _broken(code):
                    found.append(f'{path.relative_to(REPO)}:{i}: {why}')
    assert found == []


@pytest.mark.parametrize('line', PLANTED)
def test_the_gate_catches_a_planted_rule(line):
    assert [why for _, code in _code_lines(line) for why in _broken(code)]


@pytest.mark.parametrize('line', CLEAN)
def test_the_gate_leaves_a_single_key_alone(line):
    assert [why for _, code in _code_lines(line) for why in _broken(code)] == []


def test_an_entry_field_named_like_provenance_is_content():
    line = entry_line({'form': 'dog', 'metadata': {'provenance': 'Smith 1990', 'provSource': 'service:x'}})
    assert 'provenance=Smith 1990' in line
    assert 'service:x' not in line
