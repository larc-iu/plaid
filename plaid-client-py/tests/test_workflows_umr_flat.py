"""Joining a graph a model wrote flat (``plaid_client.workflows.umr.flat``).

The replies below are real: gpt-oss-120b drafting a Spanish story, one request
at a time, recorded in the UMR round of 2026-09-28. Four of its thirteen
replies were written one block per node. The owner's ruling
(umr-draft-unreadable-replies) joins each extra block whose variable an
earlier block uses, where it is first used, and refuses the rest.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src'))

from plaid_client.workflows.umr import join_flat_graph, parse_penman, serialize_penman  # noqa: E402
from plaid_client.workflows.umr.flat import top_level_blocks  # noqa: E402

#: Sentence 2, second run: seven blocks, every one used by an earlier one.
GOAT = '''\
(h / have-01
   :ARG0 e1
   :ARG1 g
   :aspect state
   :other-role c)

(e1 / person
   :name n1)

(n1 / name
   :op1 "Ella")

(g / goat
   :color w
   :other-role c)

(w / white)

(c / call-01
   :ARG0 g
   :ARG1 n2
   :aspect imperfective)

(n2 / name
   :op1 "Luna")'''

#: Sentence 3: a root and three leaves.
CORRAL = '''\
(e / be-01
   :ARG0 g
   :ARG1 l
   :polarity -
   :aspect imperfective
   :temporal t)
(g / goat)
(l / corral)
(t / morning)'''

#: Sentence 1: joins whole, and the joined graph is still refused for its
#: value under :size, by the draft's own check.
TOWN = '''\
(e / live-01 :aspect imperfective :actor m :place p)
(m / person :name n1)
(n1 / name :op1 "María")
(p / town :size small :other-role n2)
(n2 / near-91 :theme p :co-theme mtn)
(mtn / mountain :quant plural)'''

#: Sentence 2, first run: `c` is used by no block before it, so the reply
#: stays refused.
UNUSED = '''\
(h / have-01
   :ARG0 e
   :ARG1 g
   :aspect imperfective)
(e / person)
(g / goat
   :color "white")
(c / call-01
   :ARG0 g
   :ARG1 n)
(n / name :op1 "Luna")'''


def _read(text):
    graph = parse_penman(join_flat_graph(text))
    return graph, [e.message for e in graph.errors]


def test_a_reply_written_one_block_per_node_reads_as_one_graph():
    graph, errors = _read(GOAT)
    assert errors == []
    assert graph.root == 'h'
    assert sorted(graph.nodes) == ['c', 'e1', 'g', 'h', 'n1', 'n2', 'w']
    # Every link the blocks made by variable is an edge of the one graph.
    edges = {(var, child.rel, child.value) for var, node in graph.nodes.items()
             for child in node.children if child.kind == 'node'}
    assert edges == {('h', ':ARG0', 'e1'), ('h', ':ARG1', 'g'), ('h', ':other-role', 'c'),
                     ('e1', ':name', 'n1'), ('g', ':color', 'w'), ('g', ':other-role', 'c'),
                     ('c', ':ARG0', 'g'), ('c', ':ARG1', 'n2')}


def test_a_block_is_joined_where_its_variable_is_first_used():
    """`c` is named last by the root but first inside `g`, which the join
    has already put under :ARG1: reading order decides, as PENMAN's own."""
    graph, _ = _read(GOAT)
    assert serialize_penman(graph) == '\n'.join([
        '(h / have-01',
        '    :ARG0 (e1 / person',
        '        :name (n1 / name',
        '            :op1 "Ella"))',
        '    :ARG1 (g / goat',
        '        :color (w / white)',
        '        :other-role (c / call-01',
        '            :ARG0 g',
        '            :ARG1 (n2 / name',
        '                :op1 "Luna")',
        '            :aspect imperfective))',
        '    :aspect state',
        '    :other-role c)',
    ])


def test_the_children_keep_the_order_the_model_wrote_them_in():
    graph, errors = _read(CORRAL)
    assert errors == []
    assert [(c.rel, c.value) for c in graph.nodes['e'].children] == [
        (':ARG0', 'g'), (':ARG1', 'l'), (':polarity', '-'), (':aspect', 'imperfective'),
        (':temporal', 't')]


def test_a_joined_graph_still_carries_what_is_wrong_with_it():
    graph, errors = _read(TOWN)
    assert errors == []
    [town] = [c for c in graph.nodes['p'].children if c.rel == ':size']
    assert (town.kind, town.value) == ('atom', 'small')


def test_a_block_nothing_before_it_uses_is_still_refused():
    _, errors = _read(UNUSED)
    assert errors == ["Unexpected content after the topmost closing bracket: '(c / call-01'."]


def test_a_block_used_only_by_a_later_block_is_not_joined():
    _, errors = _read('(a / one :ARG0 b)\n(c / three)\n(b / two :ARG1 c)')
    assert errors == ["Unexpected content after the topmost closing bracket: '(c / three)'."]


def test_a_variable_defined_twice_is_not_joined_over_itself():
    text = '(a / one :ARG0 (b / two))\n(b / again)'
    assert join_flat_graph(text) == text
    assert _read(text)[1] == [
        "Unexpected content after the topmost closing bracket: '(b / again)'."]


def test_a_name_inside_a_string_or_a_comment_is_not_a_use():
    text = '(a / one :op1 "b" # :ARG1 b\n :ARG0 b)\n(b / two)'
    graph, errors = _read(text)
    assert errors == []
    assert [(c.rel, c.kind, c.value) for c in graph.nodes['a'].children] == [
        (':op1', 'string', '"b"'), (':ARG0', 'node', 'b')]


def test_a_time_of_day_holds_no_role():
    graph, errors = _read('(a / meet-01 :time 15:30 :ARG0 b)\n(b / person)')
    assert errors == []
    assert [(c.rel, c.value) for c in graph.nodes['a'].children] == [
        (':time', '15:30'), (':ARG0', 'b')]


def test_a_bracket_inside_a_string_does_not_end_a_block():
    graph, errors = _read('(a / one :ARG0 b)\n(b / name :op1 "x (y")')
    assert errors == []
    assert graph.nodes['b'].children[0].value == '"x (y"'


def test_text_that_is_one_graph_or_not_a_run_of_blocks_is_left_as_it_was():
    for text in ['', '(a / one :ARG0 (b / two))', 'I cannot help with that.',
                 '(a / one) junk', '(a / one :ARG0 b', 'junk (a / one)']:
        assert join_flat_graph(text) == text


def test_blocks_are_found_at_the_top_level_only():
    assert top_level_blocks('(a / x :ARG0 (b / y))\n\n(c / z)') == [(0, 21), (23, 30)]
    assert top_level_blocks('(a / x))') is None
    assert top_level_blocks('(a / x') is None
