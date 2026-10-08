"""The agent's reading of a pattern (core/java_regex.py) against plaid-ui's
(src/domain/javaRegex.js) and against Java itself.

A replace finds its values with the server's search, which runs Java's
``java.util.regex``, and rewrites them here. Handing the same text to both
engines rewrote other values than the search found: ``^\\w+$`` matched 17,762
word forms in Java and 27,016 in Python's ``re`` (H23-SEARCH-3). Both clients
now write the pattern out themselves, in a form both engines read the same
way. So: the two clients write the same pattern for the server (the mirror),
and for every value the local pattern matches exactly when Java's matches (the
oracle, through plaid-ui/tools/JavaRegex.java, which compiles as the server
does, with UNICODE_CHARACTER_CLASS).
"""

import json
import os
import re
import shutil
import subprocess

import pytest

from node_exe import node_or_skip
from plaid_agent.core.corpus import rx
from plaid_agent.core.java_case_folds import FOLDS
from plaid_agent.core.java_regex import PatternError, SERVER_PATTERN_MAX, matcher, nfc, translate
from plaid_agent.core.replace import replacer
from plaid_agent.core.tools import ToolError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'java_regex_mirror.mjs')
UI = os.path.join(HERE, '..', '..', 'plaid-ui')
JAVA_TOOL = os.path.join(UI, 'tools', 'JavaRegex.java')
#: The never-matching branch every server pattern ends in (java_regex._SUPPLEMENTARY).
S = '(?:(?!)' + chr(0x10FFFF) + ')?'

PATTERNS = [
    r'\p{L}', r'\p{Lu}', r'\pL', r'\p{IsL}', r'\p{gc=Lu}', r'\P{L}', r'[\p{L}\d]', r'[^\p{L}]',
    r'\p{M}', r'\p{N}', r'\p{P}', r'\p{Z}', r'\p{C}', r'\bko\b', r'\b', r'^\w+$', r'\bx', r'x\b', r'\b\w+\b', r'(?<=\p{L})x', r'(?<!\p{L})x',
    r'\w', r'\W', r'\d', r'\D', r'\s', r'\S', r'\h', r'\H', r'\v', r'\V', r'.$', r'\w+$', r'a$',
    r'^$', r'a\Z', r'a\z', r'\Aa', r'.', r'^.$', r'(?s)^.$', r'(?s:a.)', r'(?i)a', r'(?i)k',
    r'(?i)s', r'(?i)i', r'(?i)ß', r'(?i)ẞ', r'(?i)σ', r'(?i)ǆ', r'(?i)[a-z]', r'(?i)[^a-z]',
    r'(?iu)ц', r'a(?i)b', r'((?i)a)b', r'(?i)\w', r'(?i)µ', r'(a)\1', r'(\w+)-\1',
    r'(?<x>ba)-\k<x>', r'a{2}', r'a{1,2}', r'a+?', r'(?:ab|ba)+', r'[a-c]', r'[^a-c]', r'[-a]',
    r'[a-]', r'[\]]', r'[\w-]', r'[.]', r'\$', r'\.', r'\Qa.b\E', r'\x41', r'\x{1F600}',
    r'😀', r'\0101', r'\cA', r']', r'}', r'(?=a)a', r'(?!a).', r'(?<=a)b', r'(?<!a)b',
    r'(?<=\ba)b', r'(?<=a|bc)d', r'[\w-]+', r'\d+', r'[^\w]', r'\bцу', r'\bتے\b', r'\bə́mə\b', r'[\p{Lu}\p{Nd}]', '\\s*=', r'\ ', r'\#',
    # Scripts, by every spelling Java takes, and Java's Unicode classes.
    r'\p{IsArabic}', r'^\p{IsArabic}+$', r'\p{IsCyrillic}', r'^\p{IsHan}+$', r'\p{sc=Devanagari}',
    r'\P{script=Latin}', r'[\p{IsGreek}\p{IsCyrillic}]', r'[^\p{IsLatin}\s]', r'\p{IsCommon}',
    r'\p{IsInherited}', r'^\p{IsArab}\p{M}*$', r'\p{Isarabic}', r'\p{Script=Arab}', r'\p{IsHebrew}+',
    r'\P{IsOld_Italic}', r'\p{IsSignWriting}', r'(?i)\p{IsGreek}', r'\p{GC=Lu}', r'(?U)\w',
    r'^[\w\s]+$', r'\S+', r'^\s$', r'\b\w', r'^\W+$', r'\w\b', r'a{1,2}?b', r'^.{2}$',
    # Refused, with the same message in both clients.
    '[[:alpha:]]', r'\p{InCyrillic}', r'\p{blk=Cyrillic}', r'\p{Alpha}', r'\p{Arabic}',
    r'\p{IsAlphabetic}', r'\p{IsUnknown}', r'\p{scx=Arabic}', r'\p{javaLowerCase}', '(?-U)a', '(?m)^a', 'a*+', '(?>a)', r'\G', r'\B', r'[\W]', r'(a)?\1', r'(?i)(a)\1',
    r'(?i)\p{Lu}', '(?<=a*)b', '*a', 'a{', '(a', 'a)', '[a', '[z-a]', 'a{3,2}', '\\', r'\y',
]
CASES = ([[p, {}] for p in PATTERNS]
         + [[p, {'literal': True, 'caseInsensitive': True}]
            for p in ['ka', 'KA', '?a', 'ß', 'ẞ', 'ﬀ', 'ı', 'ǆ', 'ц', 'Ω', 'a.b(c']]
         + [['ka', {'literal': True, 'caseInsensitive': True, 'whole': True}],
            ['a+', {'whole': True}], ['run', {'literal': True, 'whole': True}],
            ['a' * (SERVER_PATTERN_MAX + 1), {}]])

SUBJECTS = [
    # Outside the BMP: Adlam, CJK Extension B, Osage (REV-W2 F2).
    '\U0001e900x', 'a\U0001e900\U0001e901x', '\U0001e900\U0001e901 \U0001e902', '\U00020000x', 'x\U00020000',
    '\U000104b0\U000104d8',
    'Kalamang', 'KALAMANG', 'kĭkoⁿtu´', 'ayiⁿdŭko´', 'dŭko', 'ko', 'koko', 'a\n', 'a\r\n',
    'a\r', 'a\u0085', 'a ', 'ab\n', '\n', '', 'x', '_', 'a b', 'a b', 'a\tb',
    'x\u000bx', '٣', '😀', 'a😀b', 'aa', 'abab', 'ka-t', 'ba-ba', 'ba-bo', 'a.b', 'a$b', '[x]',
    '{x}', 'a|b', '?a', '?', 'é', 'é', 'x​y', 'x　y', 'Цвез', 'цвез', 'ЦӀуьд',
    'ñaa', 'Ñu', 'ə́mə', 'اَتےِ', 'sbj:3.PFV', '12', 'a\u0000b', 'x\u0085', 'Number = Sing',
    'a#b', 'x y', 'run', 'Run', 'running',
    # Java's Unicode \\w and \\s: a joiner inside a Persian word, a letter number,
    # an alphabetic symbol, other spaces.
    'می\u200cخواهم', 'x\u200dy', 'Ⅶ', 'Ⓐb', '\u0345', 'a\u202fb', 'a\u2007b', 'x\u180ey',
    # Several scripts, with their marks and digits.
    'الكتاب', 'Цвет', '汉字', 'हिन्दी', '१२', 'שָׁלוֹם', 'Ελληνικά', 'ქართული', 'ሰላም', 'ไทย',
    'カタカナ', 'ひらがな', 'ㄅㄆ', 'Ꭰꭰ', '\U0001e950', 'abc١', 'ⁿ', '´', 'ǅ',
] + [c for cls in FOLDS for c in cls]


def _options(o):
    return {'literal': o.get('literal', False), 'case_insensitive': o.get('caseInsensitive', False),
            'whole': o.get('whole', False)}


def _ours(p, o):
    try:
        return {'server': translate(p, **_options(o)).server, 'error': None}
    except PatternError as e:
        return {'server': None, 'error': str(e)}


def test_the_agent_sends_the_server_what_the_app_sends(tmp_path):
    node = node_or_skip('the pattern translator mirror')
    path = tmp_path / 'cases.json'
    path.write_text(json.dumps(CASES))
    run = subprocess.run([node, RUNNER, str(path)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    theirs = json.loads(run.stdout)
    differ = [(p, o, ours, app) for (p, o), app in zip(CASES, theirs)
              if (ours := _ours(p, o)) != app]
    assert differ == []


def _oracle(lines):
    java = shutil.which('java')
    assert java, 'java is needed to check the translator against the server\'s engine'
    run = subprocess.run([java, JAVA_TOOL, 'oracle'], input='\n'.join(lines) + '\n',
                         capture_output=True, text=True, timeout=300)
    assert run.returncode == 0, run.stderr
    return run.stdout.split()


def _hexed(pattern, s):
    return f"{pattern.encode('utf-8').hex()}\t{s.encode('utf-8').hex()}"


def _differences(rows):
    """Java's answer for each (pattern, options, pattern sent to Java) on each
    subject, against the local matcher's."""
    # A character newer than the server's Java's Unicode tables is a known
    # difference (the module says so): leave out what Java reads as unassigned.
    assigned = _oracle([_hexed(r'\p{Cn}', s) for s in SUBJECTS])
    known = [s for s, a in zip(SUBJECTS, assigned) if a == '0']
    assert len(known) > 0.9 * len(SUBJECTS)
    # The server's REGEXP reads the pattern and the value in NFC, as the local
    # matcher does (H10-SCRIPTS-5), and the oracle is Java's engine alone.
    lines = [_hexed(nfc(sent), nfc(s)) for _, _, sent in rows for s in known]
    answers = _oracle(lines)
    assert len(answers) == len(lines)
    differ = []
    k = 0
    for p, o, _ in rows:
        m = matcher(p, **_options(o))
        for s in known:
            mine = '1' if m(s) else '0'
            if answers[k] != mine:
                differ.append((p, o, s, answers[k], mine))
            k += 1
    return differ


def test_a_local_match_is_a_match_in_java():
    usable = [(p, o) for p, o in CASES if _ours(p, o)['error'] is None]
    assert _differences([(p, o, translate(p, **_options(o)).server) for p, o in usable])[:10] == []


def test_a_local_match_is_what_the_server_finds_for_the_typed_pattern():
    # A script's query sends the typed pattern, which the server compiles with
    # UNICODE_CHARACTER_CLASS. \w, \d, \s, \b and scripts read the same here.
    # (?i) is left out: Java folds İ and ı with i, the translators do not
    # (ruled 2026-10-02). The suffix puts the typed lookbehinds on code points.
    typed = [(p, o, p + S) for p, o in CASES
             if not o and _ours(p, o)['error'] is None and not re.search(r'\(\?[a-zU]*i', p)]
    assert len(typed) > 100
    assert _differences(typed)[:10] == []


def test_every_script_the_server_knows_is_read():
    java = shutil.which('java')
    assert java
    run = subprocess.run([java, JAVA_TOOL, 'scripts'], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    names = [line.split('\t')[0] for line in run.stdout.split('\n') if line]
    assert len(names) > 150
    for name in names:
        server = translate(rf'\p{{Is{name}}}').server
        assert server.upper().startswith(rf'\P{{SC={name}}}'), name


def test_any_case_folds_as_unicode_does():
    # Simple case folding: ı and İ are not an i (ruled 2026-10-02, REV-W2 Q1).
    assert translate('i', literal=True, case_insensitive=True).server == '[Ii]' + S
    assert matcher('i', literal=True, case_insensitive=True)('kıt') is False
    assert matcher('s', literal=True, case_insensitive=True)('\u017f') is True


def test_the_server_cap_is_core_s():
    # The client refuses first, so a cap left behind here is the one that holds.
    clauses = open(os.path.join(HERE, '..', '..', 'plaid-core', 'src', 'main', 'plaid', 'query',
                                'clauses.clj'), encoding='utf-8').read()
    cap = int(re.search(r'\(def regex-max-len (\d+)\)', clauses).group(1))
    assert SERVER_PATTERN_MAX == cap
    assert translate(r'\bko\b|\bka\b|\bta\b').server.endswith(S)


def test_search_and_replace_read_a_pattern_alike():
    # The hunter's cases: Python's re read \w and [[:alpha:]] otherwise.
    assert rx(r'^\w+', regex=True, case_sensitive=True) == {
        'regex': r'^[\x{200c}\x{200d}\p{IsAlphabetic}\p{M}\p{Nd}\p{Pc}]+' + S}
    rewrite = replacer(r'^\w+$', 'X', True, False, True)
    assert rewrite('abc') == 'X'
    # A word character in any script (ruled 2026-10-02).
    assert rewrite('añb') == 'X'
    assert rewrite('a b') == 'a b'
    # Java's Unicode \w takes a joiner inside a Persian word.
    assert rewrite('می\u200cخواهم') == 'X'
    assert replacer(r'\p{L}', 'x', True, False, True)('ñ1') == 'x1'
    assert replacer('ka', 'ga', False, False)('KAlamang') == 'galamang'
    with pytest.raises(ToolError, match='Nested'):
        rx('[[:alpha:]]', regex=True)
    with pytest.raises(ValueError, match='cannot be used: Nested'):
        replacer('[[:alpha:]]', 'x', True, False)
