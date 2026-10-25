"""The tools a UMR assistant may call (the workspace they run against is
:mod:`.workspace`).

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3``, ``s3.s3e``): see :mod:`.project`
for what a UMR project is shaped like and why the model never handles an id.
"""

import re
import uuid
from typing import Any, Dict, Iterable, List, Optional

from ..core import opkind
from ..core.bidi import plain_quote, qv
from ..core.args import sentence_number
from plaid_client.workflows.umr import (is_variable, parse_attribute_line, unknown_doc_relation_problem,
                                        unknown_relation_problem)
from plaid_client.workflows.umr.inventory import ATTRIBUTE_RELATIONS, ATTRIBUTE_VALUES, edge_only, is_known_relation

from ..core.limits import SAMPLE_LINES
from ..core.tools import ToolError, overview_documents, truncate
from .diff import plan_penman
from .plan import KIND, attr_line, attrs_scope_held, attrs_scope_targets, holds, replacing_phrase
from .project import (DOC_CONSTANTS, GNode, GROUPS, Sentence, UmrDoc, attrs_change,
                      gloss_headers, group_of, node_ref, place_attributes,
                      numbering, render_document_graph)

# The workspace lives in its own module, as igt's does.
from .workspace import PLAN_NOTE, Workspace  # noqa: F401


# --- reading ------------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    p = ws.project
    out = [f'Project "{p.name}" (Uniform Meaning Representation)']
    if p.language:
        out.append(f'Language: {p.language}')
    out.append('')
    out.append('A sentence carries one graph, written in PENMAN. A node is a variable, a concept '
               'and any number of attributes; a relation joins two nodes. A node is addressed by '
               'its sentence and its variable: s3.s3e is the node s3e of sentence 3.')
    lines = gloss_headers(p)
    if lines:
        out.append('Gloss lines under each sentence: ' + ', '.join(lines) + '.')
    docs = ws.documents()
    out.append('')
    try:
        sizes = ws.corpus.sizes()
        out.append(f'Size: {len(docs)} documents, {sizes["sentences"]} sentences, '
                   f'{sizes["nodes"]} graph nodes, {sizes["relations"]} relations. search, '
                   f'find_nodes and frequency_list read the whole corpus at once; read_document '
                   f'reads one document a page at a time.')
        out.append('')
    except Exception:  # noqa: BLE001 - the overview is worth having without the size
        pass
    out.extend(overview_documents(docs))
    return '\n'.join(out)


def t_document_graph(ws: Workspace, document: str = None) -> str:
    out = truncate(render_document_graph(ws.doc(document)))
    ws.note_read(1, 'document')
    return out


# --- addressing helpers ---------------------------------------------------------

def _sentence(ws: Workspace, doc: UmrDoc, sentence) -> Sentence:
    n = sentence_number(str(sentence).split('.')[0] if isinstance(sentence, str) else sentence,
                        'sentence')
    if n is None:
        raise ToolError('Name a sentence, as a number or a reference like "s3".', kind='invalid-argument')
    s = doc.by_number(n)
    if s is None:
        raise ToolError(f's{n}: {numbering(doc)}', kind='not-found')
    return s


def _node(doc: UmrDoc, sentence: Sentence, var: str) -> GNode:
    node = sentence.node(var)
    if node is None:
        known = ', '.join(n.var for n in sentence.nodes[:20]) or 'none'
        raise ToolError(f'Sentence s{sentence.number} has no node "{var}". Its nodes: {known}', kind='not-found')
    return node


# --- planning ------------------------------------------------------------------

def _staged(ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One tool call's ops, tagged with the call that made them, so a second
    call over the same sentence graph can be told apart from this one's."""
    staging = uuid.uuid4().hex
    for op in ops:
        op['staging'] = staging
    return ops


def _no_graph_planned(ws: Workspace, doc: UmrDoc, s: Sentence) -> None:
    """A second change to a sentence whose graph this plan already replaces.

    The second was worked out against the graph the first replaces, so its
    variables name different nodes and its ids may already be gone. Refused
    here, where the tool can name the sentence; ``Workspace.refuse_second_graph``
    and ``validate_ops`` are the backstops.
    """
    key = f'{doc.id}:{s.index}'
    if any(op.get('graph_of') == key for op in ws.ops):
        raise ToolError(f'This plan already replaces the graph of s{s.number} in {plain_quote(doc.name)}, and '
                        f'this change was worked out against the graph it replaces. Keep one of '
                        f'the two (discard_plan and stage the rest again), or plan them in separate turns.',
                        kind='conflict')


def t_apply_penman(ws: Workspace, document: str = None, sentence=None, text: str = None,
                   reorder: bool = False) -> str:
    doc = ws.doc(document)
    s = _sentence(ws, doc, sentence)
    _no_graph_planned(ws, doc, s)
    if not (text or '').strip():
        raise ToolError('Give text: the sentence graph in PENMAN, starting at its root node.', kind='invalid-argument')
    diff = plan_penman(doc, s, text, ws.project, reorder=str(reorder).strip().lower() == 'true')
    if diff.errors:
        if 'after the topmost closing bracket' in diff.errors[0]:
            # Copied whole from a read of a sentence holding several graphs.
            raise ToolError('The text holds more than one graph. apply_penman takes the root\'s graph '
                            'alone, the first one read_document prints, and leaves the parts after it '
                            'as they are: give that one only.', kind='invalid-argument')
        raise ToolError('The graph could not be read. ' + diff.errors[0], kind='invalid-argument')
    if diff.refused:
        raise ToolError(diff.refused, kind='conflict')
    # The order the text writes children in is not applied without reorder.
    # Said, so a user who asked for a new order is not told it was done.
    kept = ''
    if diff.order_kept:
        kept = (f' The text writes the children of {", ".join(diff.order_kept)} in another order than '
                f'they are stored in, and that order was not applied: pass reorder=true only if the '
                f'user asked for it.')
    if not diff.ops:
        return f'Nothing to change: s{s.number} already holds that graph.' + kept
    ws.add_ops(_staged(diff.ops))
    counts: Dict[str, int] = {}
    for op in diff.ops:
        counts[op['kind']] = counts.get(op['kind'], 0) + 1
    what = ', '.join(f'{n} {k.replace("_", " ")}' for k, n in sorted(counts.items()))
    return (f'Planned {len(diff.ops)} change(s) to the graph of s{s.number} in {plain_quote(doc.name)} '
            f'({what}).' + _additions(diff.ops) + _removals(diff.ops) + kept
            + ws.warned(_named_roles_missing(getattr(ws, 'asked', ''), text, _stored_roles(doc, s))))


# A relation written out with its colon, in a message or a graph.
_WRITTEN_RELATION = re.compile(r'(?<![\w:-])(:[A-Za-z][A-Za-z0-9-]*)')


def _stored_roles(doc: UmrDoc, s: Sentence) -> set:
    """The roles sentence ``s``'s graph holds as stored: one the new graph
    lacks is one the plan removes."""
    return {e.role for n in doc.nodes_by_id.values() if n.sentence == s.index for e in n.out}


def _named_roles_missing(asked: str, text: str, removed: Iterable[str] = ()) -> str:
    """The roles the user's message writes out (":experiencer") that the
    graph does not have, said after the plan. Told to use :experiencer and
    :stimulus, models drafted :ARG0 and :ARG1, and a reminder to check the
    roles in general did not stop them. A role the plan removes is one the
    user asked to remove, and is not said (bench q38-2: "names :temporal"
    after every removal of :temporal edges)."""
    named = [r for r in dict.fromkeys(_WRITTEN_RELATION.findall(asked or ''))
             if is_known_relation(r) and not unknown_relation_problem(r) and r not in ATTRIBUTE_RELATIONS]
    written = set(_WRITTEN_RELATION.findall(text or '')) | set(removed)
    missing = [r for r in named if r not in written and f'{r}-of' not in written]
    if not missing:
        return ''
    listed = ', '.join(missing[:-1]) + (' and ' if len(missing) > 1 else '') + missing[-1]
    return (f' The user\'s message names {listed}, and this graph has no '
            f'{"such role" if len(missing) == 1 else "such roles"}. If {"it is" if len(missing) == 1 else "they are"} '
            f'meant for this graph, discard_plan and plan the graph again with {"it" if len(missing) == 1 else "them"}.')


def _additions(ops: List[Dict[str, Any]]) -> str:
    """The nodes and relations the staged changes make, and the attributes
    they set on nodes already there, so the roles, concepts and values the plan
    writes are in front of the model when it reports. A
    count alone let a draft with :ARG0 pass for the :experiencer the user
    asked for."""
    def said(op):
        # A new node's attributes too, so a value written as an attribute
        # where the user asked for a node shows as one.
        line = attr_line(op.get('attrs')) if op.get('kind') == 'create_node' else ''
        label = str(op.get('label'))
        return label.replace(f'/ {op.get("concept")})', f'/ {op.get("concept")} {line})', 1) if line else label
    made = [said(op) for op in ops if op.get('label') and (op.get('kind') in ('create_node', 'create_edge')
                                                            or _sets_attrs(op))]
    if not made:
        return ''
    shown = made[:REMOVALS_SHOWN]
    more = len(made) - len(shown)
    return (' It adds: ' + '; '.join(shown) + (f'; and {more} more' if more else '')
            + '. Check these roles and concepts against any the user named.' + _quoted(ops))


# Relations whose value is text by nature (a name's parts, a wiki id, a list
# item's label), or a fixed word the guidelines give (:polarity -, :mode
# imperative, :degree intensifier).
_TEXT_VALUED = re.compile(r'^:(op[1-9][0-9]*|wiki|li|list-item|value|polarity|mode|polite|degree|'
                          r'refer-definiteness)$')


def _quoted(ops: List[Dict[str, Any]]) -> str:
    """The plain values a new node carries under a relation that can hold a
    node and has no list of values of its own: a quoted string, or a bare
    word. A model asked for "kay has a :mod ikian" wrote :mod "ikian" or
    :mod ikian, a value where the user meant a node, and its report took the
    one for the other. A number is a value and is not mentioned."""
    found = [(op.get('var'), a.get('rel'), str(a.get('value')))
             for op in ops if op.get('kind') == 'create_node'
             for a in op.get('attrs') or []
             if not _TEXT_VALUED.match(str(a.get('rel'))) and str(a.get('rel')) not in ATTRIBUTE_VALUES
             and re.fullmatch(r'"?[^\W\d_][\w.-]*"?', str(a.get('value') or ''))]
    if not found:
        return ''
    _, rel, value = found[0]
    rows = '; '.join(f'{v} {r} {x}' for v, r, x in found[:REMOVALS_SHOWN])
    return (f' A plain value, not a node: {rows}. Where the user meant a concept, it is a node with a '
            f'new variable of its own: {rel} (<variable> / {value.strip(chr(34))}).')


def _sets_attrs(op: Dict[str, Any]) -> bool:
    """Whether a staged change gives a node already there an attribute or a
    new value for one (``attrs_change`` says "adds :rel" or "becomes"). Its
    whole label is shown, as a removal shows it."""
    label = str(op.get('label'))
    return op.get('kind') == 'set_attrs' and ('adds :' in label or ' becomes ' in label)


def _removes(op: Dict[str, Any]) -> bool:
    """Whether a staged change takes something away: a node or a relation
    deleted, or an attribute a node's new line drops (``attrs_change`` says
    "removes :rel"). Asked of the change, not of its label's words, which
    hold concepts such as remove-01."""
    if op.get('kind') in ('delete_node', 'delete_edge'):
        return True
    return op.get('kind') == 'set_attrs' and 'removes :' in str(op.get('label'))


# How many of a plan's removals a tool result names before it counts the rest.
REMOVALS_SHOWN = 20


def _removals(ops: List[Dict[str, Any]]) -> str:
    """What the staged changes take away, in the card's own words: a node
    removed with the document-level relations it takes, a relation removed,
    an attribute a node's new line drops. The count of changes alone left the
    model telling the user it had added an attribute where the card said it
    removed another one."""
    gone = [str(op.get('label')) for op in ops if op.get('label') and _removes(op)]
    if not gone:
        return ''
    shown = gone[:REMOVALS_SHOWN]
    more = len(gone) - len(shown)
    return (' It removes: ' + '; '.join(shown)
            + (f'; and {more} more' if more else '') + '.')


def t_set_attributes(ws: Workspace, document: str = None, sentence=None, var: str = None,
                     line: str = None) -> str:
    doc = ws.doc(document)
    s = _sentence(ws, doc, sentence)
    _no_graph_planned(ws, doc, s)
    node = _node(doc, s, (var or '').strip())
    role = _role_in_attribute_line(line or '', node.concept)
    if role:
        raise ToolError(role + ' Nothing was planned. A role goes through apply_penman: write the sentence\'s '
                        'graph with the edge in it.', kind='invalid-argument')
    attrs, problems = parse_attribute_line(line or '')
    if problems:
        raise ToolError('The attribute line could not be read. ' + problems[0], kind='invalid-argument')
    placed = place_attributes(node, attrs)
    if [(a.get('rel'), a.get('value')) for a in node.attrs] == [(a['rel'], a['value']) for a in placed]:
        return f'Nothing to change: {node.var} already has those attributes.'
    shown = ' '.join(f'{a["rel"]} {a["value"]}' for a in placed) or '(none)'
    # The one key that changes, never the composed namespace: a second op on
    # this node in the same plan then cannot restore it as it was read (see
    # plan._apply_span_meta).
    ws.add_ops(_staged([{
        'kind': 'set_attrs', 'document_id': doc.id, 'ref': node_ref(s, node),
        'sentence': s.index, 'sentence_id': s.id, 'span_id': node.id, 'var': node.var,
        'attrs': placed, 'attr_line': attr_line(placed), 'umr_set': {'attrs': placed},
        'label': f'{node.var}: {attrs_change(node.attrs, placed)}'}]))
    # What changes, as the card says it, so a line that drops an attribute the
    # model did not write says so.
    return (f'Planned the attributes of {node.var} in s{s.number}: {shown} '
            f'({attrs_change(node.attrs, placed)}).' + ws.warned(_dropped(node.attrs, placed)))


def _dropped(before: List[Dict[str, Any]], after: List[Dict[str, Any]]) -> str:
    """The attributes a whole-line write removes because the line left them
    out, said plainly. Asked to change :aspect, models wrote a line of :aspect
    alone, and "removes :modal-strength" inside the change's summary went
    unread."""
    kept = {a.get('rel') for a in after}
    gone = [f'{a.get("rel")} {a.get("value")}' for a in before if a.get('rel') not in kept]
    if not gone:
        return ''
    return (f' The line leaves out {", ".join(gone)}, so this REMOVES '
            f'{"it" if len(gone) == 1 else "them"}. Unless the user asked for that, plan the line again '
            f'with {"it" if len(gone) == 1 else "them"} in it.')


def _role_in_attribute_line(line: str, concept: Optional[str]) -> Optional[str]:
    """Why a set_attributes line points at a node rather than giving values,
    or None. The local model wrote ":actor s1a" there several times a run, and
    was told only "Variable 's1a' is not defined"."""
    bare = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
    for rel, value in re.findall(r'(:[^\s()"]+)\s+([^\s()]+)', bare):
        if not is_variable(value):
            continue
        if edge_only(rel, concept or ''):
            return (f'{rel} {value} is a role, which joins two nodes, and set_attributes sets only a node\'s '
                    'attributes (:aspect, :modal-strength, :polarity and the like).')
        return f'{rel} {value} points at the node {value}, and an attribute takes a plain value.'
    return None


def t_set_attribute_for_concept(ws: Workspace, document: str = None, concept: str = None,
                                rel: str = None, value: str = None, regex: bool = False,
                                whole: bool = False, case_sensitive: bool = False,
                                overwrite: bool = False) -> str:
    """One attribute over every node in a document whose concept matches.

    A node that already has the attribute is left alone unless ``overwrite``
    (ruling umr-assist-where-missing), and an overwrite names on the card what
    it replaces ("replacing process on 5"), so neither the model nor the
    approver can replace a value without seeing it."""
    doc = ws.doc(document)
    concept = (concept or '').strip()
    if not concept:
        raise ToolError('Give concept: which nodes to change, e.g. "say-01".', kind='invalid-argument')
    rel = (rel or '').strip()
    if not rel.startswith(':'):
        raise ToolError('Give rel: an attribute, which starts with a colon (:aspect, '
                        ':refer-number, :polarity).', kind='invalid-argument')
    value = (value or '').strip()
    op: Dict[str, Any] = {
        'kind': 'attrs_scope', 'document_id': doc.id, 'concept': concept, 'rel': rel,
        'value': value, 'regex': bool(regex), 'whole': bool(whole),
        'case_sensitive': bool(case_sensitive), 'overwrite': bool(overwrite)}
    # The count and the examples come from the same reader the resolver uses,
    # so the card counts what approval will stage. It is read again at
    # approval, against the document as it is then.
    targets = list(attrs_scope_targets(doc, op))
    what = f'{rel} {value}' if value else f'{rel} removed'
    # The nodes left alone because they already have the attribute, said to
    # the model so a request that meant to change them can be planned again.
    kept = [] if (overwrite or not value) else attrs_scope_held(doc, op)
    kept_note = ''
    if kept:
        kept_note = (f'{len(kept)} node(s) with that concept already have {rel} and are left as '
                     f'they are (' + ', '.join(f's{s.number}.{n.var} {" ".join(holds(n, rel))}'
                                               for s, n in kept[:SAMPLE_LINES])
                     + (', …' if len(kept) > SAMPLE_LINES else '')
                     + '). Pass overwrite=true only if the user asked to replace existing values.')
    if not targets:
        return (f'Nothing to change: no node in {plain_quote(doc.name)} with a concept matching "{concept}" '
                f'would end up different ({what}).' + (f' {kept_note}' if kept_note else ''))
    replacing = replacing_phrase(targets, rel) if value else ''
    op['count'] = len(targets)
    op['label'] = (f'{what} on {len(targets)} node(s) with concept {qv(concept)} in {qv(doc.name)}'
                   + (f', replacing {replacing}' if replacing else ''))
    _as_rule(ws, doc, op, targets)
    ws.add_ops(_staged([op]))
    out = [f'Planned {what} on {len(targets)} node(s) in {plain_quote(doc.name)}'
           + (f', replacing {replacing}' if replacing else '') + ', read again when you approve it:']
    for s, node, _placed in targets[:SAMPLE_LINES]:
        was = ' '.join(holds(node, rel))
        out.append(f'  s{s.number}.{node.var}  ({node.concept}' + (f', was {was}' if was else '') + ')')
    if len(targets) > SAMPLE_LINES:
        out.append(f'  … and {len(targets) - SAMPLE_LINES} more')
    if kept_note:
        out.append(kept_note)
    return '\n'.join(out)


def _as_rule(ws: Workspace, doc: UmrDoc, op: Dict[str, Any], targets) -> None:
    """Make a concept-wide attribute change a rule (core/rules.py): what it
    matched (``matched``, the digest approval compares, by the resolver
    approval runs), the change in words, and its card row: the total, the
    document, every distinct change of the attribute and a sample, each
    placed at its node."""
    from ..core import rules, work
    from ..core.plan import Resolution
    from .changes import describe_change
    from .plan import matched
    found = list(opkind.resolver(KIND, op)(Resolution(ws.client, ws.project, lambda _c, _p, _d: doc), op))
    rel, value = op['rel'], op.get('value') or ''
    op['matched'] = matched(found)
    # How many of its changes take a value from a person's node, counted now
    # as the card says it: it is found again only when it is approved.
    op[work.COUNTED] = sum(int(o.get(work.FLAG) or 0) for o in found)
    op['change'] = f'{rel} {value or "removed"} on concept {qv(op["concept"])} in {qv(doc.name)}'
    op['unit'] = ['node', 'nodes']
    card = rules.card({'tool': 'set_attribute_for_concept',
                       'args': {k: op.get(k) for k in ('document_id', 'concept', 'rel', 'value', 'regex', 'whole',
                                                       'case_sensitive', 'overwrite')},
                       'counts': {'set_attrs': len(found)}},
                      found, lambda o: o.get('document_id'), lambda _d: doc.name,
                      lambda o: describe_change(ws, o), lambda o: int(o.get(work.FLAG) or 0))
    card['mode'] = rules.match_mode(op['concept'], op['regex'], op['whole'], op['case_sensitive'])
    rows, more = rules.transitions(targets, lambda t: (' '.join(holds(t[1], rel)), value))
    card[rules.TRANSITIONS], card[rules.TRANSITIONS_MORE] = rows, more
    card[rules.UNIT] = ['node', 'nodes']
    op['card'] = card


def _end(ws: Workspace, doc: UmrDoc, name: str, side: str) -> Dict[str, Any]:
    """One end of a document-level triple: a node named by its variable, or one
    of the constants the format allows. A constant with no node yet is made."""
    name = (name or '').strip()
    if not name:
        raise ToolError(f'Name the {side} of the triple: a node variable, or one of the '
                        f'constants ' + ', '.join(DOC_CONSTANTS) + '.', kind='invalid-argument')
    node = doc.node_named(name)
    constant = name in DOC_CONSTANTS
    if node is not None:
        # A constant stays a constant once some triple has made its node: it
        # still belongs to no sentence, so a triple between two of them still
        # has to say whose block writes it.
        return {'var': name, 'span_id': node.id, 'node': node, 'constant': constant}
    if constant:
        return {'var': name, 'span_id': None, 'node': None, 'constant': True}
    raise ToolError(f'No node "{name}" in {plain_quote(doc.name)}, and it is not one of the constants '
                    + ', '.join(DOC_CONSTANTS) + '.', kind='not-found')


def _later_end(a: Optional[GNode], b: Optional[GNode]) -> Optional[GNode]:
    """The end of a triple in the LATER sentence, which is where the app writes
    a cross-sentence triple (in that sentence's block), so the card files it
    there too. A constant (no sentence) loses to any node."""
    ends = [n for n in (a, b) if n is not None]
    return max(ends, key=lambda n: n.sentence or 0) if ends else None


# The constants a sentence node may stand above. have-condition-91 is
# conceived by an event in real data, (s61e :unspecified have-condition-91).
_PARENT_ONLY = tuple(c for c in DOC_CONSTANTS if c != 'have-condition-91')


def _reversed_triple_problem(ws: Workspace, doc: UmrDoc, source: Dict[str, Any], target: Dict[str, Any],
                             rel: str, group: str) -> Optional[str]:
    """Why (a rel b) has its ends the wrong way round, or None.

    A document-level triple puts the reference (the parent) first. Models
    write the English order instead, (s6r :before document-creation-time) for
    "s6r happened before the document was made", which UMR writes
    (document-creation-time :before s6r). Two cases are certain: a constant
    such as the document creation time or the author under a sentence node,
    and a node that already stands above the other in this group (so the new
    triple would close a loop). Anything else is the model's call."""
    if group not in ('temporal', 'modal'):
        return None
    a, b = source['var'], target['var']
    right = f'({b} {rel} {a})'
    if target.get('constant') and b in _PARENT_ONLY and not source.get('constant'):
        return (f'({a} {rel} {b}) is the wrong way round: {b} is a reference and comes first. '
                f'Write {right}, which says {a} stands in {rel} to {b}.')
    # The group's parent-to-child links as variables: the document's own,
    # less the plan's removals, plus the plan's additions.
    var_of = {nid: n.var for nid, n in doc.nodes_by_id.items()}
    var_of.update({c.id: c.var for c in doc.constants})
    gone = {op.get('relation_id') for op in ws.ops
            if op.get('kind') == 'delete_triple' and op.get('document_id') == doc.id}
    down: Dict[str, set] = {}
    for n in list(doc.nodes_by_id.values()) + list(doc.constants):
        for t in n.doc_out:
            if t.group == group and t.id not in gone and t.source in var_of and t.target in var_of:
                down.setdefault(var_of[t.source], set()).add(var_of[t.target])
    for op in ws.ops:
        if (op.get('kind') == 'create_triple' and op.get('document_id') == doc.id
                and op.get('group') == group):
            down.setdefault(op['source_var'], set()).add(op['target_var'])
    seen, todo = set(), [b]
    while todo:
        x = todo.pop()
        if x == a:
            return (f'({a} {rel} {b}) is the wrong way round: {b} already stands above {a} in the '
                    f'{group} graph, and the reference comes first. Write {right}, which says {a} '
                    f'stands in {rel} to {b}.')
        if x not in seen:
            seen.add(x)
            todo.extend(down.get(x, ()))
    return None


def t_add_triple(ws: Workspace, document: str = None, a: str = None, rel: str = None,
                 b: str = None, group: str = None, sentence=None) -> str:
    doc = ws.doc(document)
    rel = (rel or '').strip()
    if not rel.startswith(':'):
        raise ToolError('Give rel: a document-level relation, which starts with a colon '
                        '(:same-entity, :before, :full-affirmative).', kind='invalid-argument')
    group = (group or '').strip()
    if group and group not in GROUPS:
        raise ToolError(f'group must be one of {", ".join(GROUPS)}.', kind='invalid-argument')
    # Refused before either end is looked at, and with the group as the
    # model gave it: a relation in no group is not a "modal" one just because
    # group_of files the unknown there.
    why = unknown_doc_relation_problem(group or None, rel)
    if why:
        raise ToolError(why, kind='invalid-argument')
    group = group or group_of(rel)
    source = _end(ws, doc, a, 'source')
    target = _end(ws, doc, b, 'target')
    if source['var'] == target['var']:
        raise ToolError('A triple joins two different nodes.', kind='invalid-argument')
    why = _reversed_triple_problem(ws, doc, source, target, rel, group)
    if why:
        raise ToolError(why, kind='invalid-argument')
    existing = source['node']
    if existing is not None and target['node'] is not None:
        for t in existing.doc_out:
            if t.target == target['node'].id and t.rel == rel:
                return (f'Nothing to change: ({source["var"]} {rel} {target["var"]}) is already '
                        f'in the document graph.')

    staged: List[Dict[str, Any]] = []
    for end in (source, target):
        if end.get('constant') and not end['span_id']:
            staged.append({
                'kind': 'create_node', 'document_id': doc.id, 'var': end['var'],
                'concept': end['var'], 'attrs': [], 'constant': True,
                'node_layer_id': ws.project.node_layer_id,
                'concept_layer_id': ws.project.concept_layer_id,
                # A constant belongs to no sentence, so its anchor is a point
                # at the text's start, which is where the editor puts one.
                'text_id': doc.text_id, 'begin': 0, 'end': 0,
                'label': f'add the constant {end["var"]}'})
    op: Dict[str, Any] = {
        'kind': 'create_triple', 'document_id': doc.id,
        'document_graph_layer_id': ws.project.document_graph_layer_id,
        'source_var': source['var'], 'target_var': target['var'], 'rel': rel, 'group': group,
        'label': f'({source["var"]} {rel} {target["var"]})'}
    if source['span_id']:
        op['source_span_id'] = source['span_id']
    if target['span_id']:
        op['target_span_id'] = target['span_id']
    # A triple between two constants belongs to no sentence by itself, so the
    # one whose block writes it is named, and its record lists it, in the
    # batch that makes it (plan.py). A sentence with no record gets one over
    # the sentence.
    if source.get('constant') and target.get('constant'):
        if not doc.sentences:
            raise ToolError(f'{plain_quote(doc.name)} has no sentences to write the triple in.', kind='not-found')
        s = _sentence(ws, doc, sentence) if sentence is not None else doc.sentences[0]
        op['record_id'] = s.record_token
        op['record_triples'] = list(s.record_triples)
        if not s.record_token:
            op['node_layer_id'] = ws.project.node_layer_id
            op['text_id'] = doc.text_id
            op['begin'], op['end'] = s.begin, s.end
        op['sentence'] = s.index
        op['sentence_id'] = s.id
        op['ref'] = f's{s.number}'
    else:
        anchor = _later_end(source['node'], target['node'])
        if anchor is not None and anchor.sentence:
            op['sentence'] = anchor.sentence
            op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
            op['ref'] = f's{doc.number_of(anchor.sentence)}.{anchor.var}'
    staged.append(op)
    ws.add_ops(_staged(staged))
    # Said in words, so a triple written in the English order reads back
    # wrong to the model that wrote it.
    reading = ''
    if group == 'temporal' and rel in (':before', ':after'):
        reading = (f' It says {target["var"]} happened {rel[1:]} {source["var"]}. If the user meant '
                   f'the opposite, write ({target["var"]} {rel} {source["var"]}) instead.')
    return (f'Planned the document-level relation ({source["var"]} {rel} {target["var"]}) '
            f'[{group}] in {plain_quote(doc.name)}.' + reading)


def t_delete_triple(ws: Workspace, document: str = None, a: str = None, rel: str = None,
                    b: str = None) -> str:
    doc = ws.doc(document)
    rel = (rel or '').strip()
    source = _end(ws, doc, a, 'source')
    target = _end(ws, doc, b, 'target')
    if source['node'] is None or target['node'] is None:
        raise ToolError('Both ends of the triple have to exist. document_graph lists what is there.', kind='not-found')
    found = next((t for t in source['node'].doc_out
                  if t.target == target['node'].id and (not rel or t.rel == rel)), None)
    if found is None:
        raise ToolError(f'No triple ({source["var"]} {rel or "…"} {target["var"]}) in '
                        f'{plain_quote(doc.name)}. document_graph lists what is there.', kind='not-found')
    op: Dict[str, Any] = {
        'kind': 'delete_triple', 'document_id': doc.id, 'relation_id': found.id,
        # Its ends, for the sentences it is pinned to (Workspace.op_sentences).
        'source_span_id': source['node'].id, 'target_span_id': target['node'].id,
        'label': f'remove ({source["var"]} {found.rel} {target["var"]})'}
    anchor = _later_end(source['node'], target['node'])
    if anchor is not None and anchor.sentence:
        op['sentence'] = anchor.sentence
        op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
        op['ref'] = f's{anchor.sentence}.{anchor.var}'
    ws.add_ops(_staged([op]))
    return (f'Planned removing ({source["var"]} {found.rel} {target["var"]}) from {plain_quote(doc.name)}.'
           )


__all__ = ['PLAN_NOTE', 'Workspace',
           't_add_triple', 't_apply_penman', 't_delete_triple', 't_document_graph',
           't_project_overview', 't_set_attribute_for_concept',
           't_set_attributes']
