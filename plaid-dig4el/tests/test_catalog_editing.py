"""Offline checks of the catalog editors' helpers: dig4el's requirement graph on the
bundled concept graph, and the value choices offered for a requirement leaf."""

from plaid_dig4el.legacy import graphs_utils as g
from plaid_dig4el.reference import catalog
from plaid_dig4el.web.app import value_options


def test_requirement_graph_has_dig4el_shape():
    cg = catalog.concepts()
    q = catalog.questionnaires()["1716852912"]
    seg = q.segments[0]
    built = g.create_requirement_graph(list(seg.concept), cg)
    assert built["sentence"]["requires"] == list(seg.concept)
    for c in seg.concept:
        assert built[c]["is_required_by"] == ["sentence"] and built[c]["path"] == ["sentence", c]
    for name, entry in built.items():
        assert entry["path"][0] == "sentence" and entry["value"] == ""
        for req in entry["requires"]:
            assert built[req]["is_required_by"] == [name]
    # the bundled graph was built by the same function on an earlier concept graph:
    # every concept's direct requirements it still has appear in the fresh build
    shared = set(built) & set(seg.graph)
    assert len(shared) > len(seg.concept)
    assert all(built[k]["path"] == seg.graph[k]["path"] for k in shared)


def test_value_options_follow_the_editor_walk():
    cg = catalog.concepts()
    # a terminal feature offers its children
    node = next(n for n in cg if g.get_children(cg, n) and g.get_children(cg, n) == g.get_leaves_from_node(cg, n))
    groups = value_options(cg, node, ["seeing"])
    assert groups == [(node, [(c, c) for c in sorted(g.get_children(cg, node), key=str.lower)])]
    # an absolute reference offers the sentence's concepts, and None stands for the node
    assert value_options(cg, "ABSOLUTE REFERENCE", ["seeing", "picture"]) == [
        ("Concepts of this sentence", [("seeing", "seeing"), ("picture", "picture"), ("None", "ABSOLUTE REFERENCE")])]
    # a leaf with no children offers itself
    leaf = next(n for n in cg if not g.get_children(cg, n))
    assert value_options(cg, leaf, []) == [(leaf, [(leaf, leaf)])]
