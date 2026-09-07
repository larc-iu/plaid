import { Accordion, Stack, Text, Code, Anchor, List, Group } from '@mantine/core';

// Click an example to drop it into the query box.
const EXAMPLES = [
  ['Subject of a verb', 'pattern { V [upos=VERB]; S [upos=NOUN|PROPN]; V -[nsubj]-> S }'],
  ['Verb with no object', 'pattern { V [upos=VERB] } without { V -[obj]-> * }'],
  ['Singular or plural noun', 'pattern { N [upos=NOUN, Number=Sing|Plur] }'],
  ['Object before its verb', 'pattern { V[]; O[]; V -[obj]-> O; O << V }'],
  [
    'Verb governing subject and object',
    'pattern { V [upos=VERB]; V -[nsubj]-> Su; V -[obj]-> Ob }',
  ],
  ['Adjacent determiner + noun', 'pattern { D [upos=DET]; N [upos=NOUN]; D < N }'],
  ['Lemma "be" anywhere in its subtree', 'pattern { V [lemma="be"]; V ->> X }'],
  ['Non-projective sentences', 'pattern { X [] } global { is_not_projective }'],
];

// Rewriting rules: a pattern plus commands. Each example stops matching once
// applied, so it runs once per sentence position.
const REWRITE_EXAMPLES = [
  ['Retag a word', 'pattern { X [lemma="that", upos=SCONJ] } commands { X.upos = PRON }'],
  [
    'Subtype the subject of a passive',
    'pattern { e: V -[nsubj]-> S; V [Voice=Pass] } commands { e.label = "nsubj:pass" }',
  ],
  [
    'Copy number from a determiner',
    'pattern { N [upos=NOUN, !Number]; D [upos=DET, Number]; N -[det]-> D } commands { N.Number = D.Number }',
  ],
  [
    'Reattach a modifier to the head',
    'pattern { H -[obj]-> N; e: N -[nmod]-> M; M [Case=Ins] } commands { del_edge e; add_edge H -[obl]-> M }',
  ],
  [
    'Gender from a lexicon',
    'pattern { X [upos=NOUN, lemma=lex.noun, !Gender] } commands { X.Gender = lex.Gender }\n#BEGIN lex\nnoun\tGender\ndog\tMasc\ncat\tFem\n#END',
  ],
  [
    'Two rules in order',
    'rule det { pattern { X [upos=DET, !Done] } commands { X.Done = Yes } }\nrule drop { pattern { X [Done=Yes] } commands { del_feat X.Done } }\nstrat main { Seq(Onf(det), Onf(drop)) }',
  ],
];

const ExampleList = ({ items, onPick }) => (
  <Stack gap={6}>
    {items.map(([label, q]) => (
      <Group key={q} gap="sm" wrap="nowrap" align="baseline">
        <Anchor
          component="button"
          type="button"
          size="sm"
          onClick={() => onPick(q)}
          style={{ flexShrink: 0 }}
        >
          {label}
        </Anchor>
        <Code style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{q}</Code>
      </Group>
    ))}
  </Stack>
);

export const GrewHelp = ({ onPick }) => (
  <Accordion variant="separated" defaultValue={null}>
    <Accordion.Item value="examples">
      <Accordion.Control>Search examples</Accordion.Control>
      <Accordion.Panel>
        <ExampleList items={EXAMPLES} onPick={onPick} />
      </Accordion.Panel>
    </Accordion.Item>

    <Accordion.Item value="rewrite">
      <Accordion.Control>Rewrite examples</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="xs">
          <ExampleList items={REWRITE_EXAMPLES} onPick={onPick} />
          <Text size="sm">
            A pattern with a{' '}
            <Code>
              commands {'{'} … {'}'}
            </Code>{' '}
            block is a{' '}
            <Anchor href="https://grew.fr/doc/commands/" target="_blank" rel="noreferrer">
              Grew rewriting rule
            </Anchor>
            . Each sentence is rewritten until no rule matches, one match at a time, and the result
            is previewed before anything is applied.
          </Text>
          <List size="sm" spacing={2}>
            <List.Item>
              <Code>X.upos = VERB</Code>, <Code>X.Number = D.Number</Code>,{' '}
              <Code>X.lemma = Y.lemma + "s"</Code>, <Code>X.f = Y.f[1:]</Code>,{' '}
              <Code>del_feat X.Number</Code>
            </List.Item>
            <List.Item>
              <Code>e.label = "obj"</Code>, <Code>e.2 = pass</Code>, <Code>del_feat e.2</Code> — on
              an edge named <Code>e: X -[…]-&gt; Y</Code>
            </List.Item>
            <List.Item>
              <Code>add_edge X -[obj]-&gt; Y</Code>, <Code>add_edge e: X -&gt; Y</Code> (the label
              of e), <Code>del_edge e</Code>, <Code>del_edge X -[obj]-&gt; Y</Code>
            </List.Item>
            <List.Item>
              <Code>shift X ==&gt; Y</Code>, <Code>shift_in X =[nsubj|obj]=&gt; Y</Code>,{' '}
              <Code>shift_out X =[^det]=&gt; Y</Code> — move X's edges to Y; the root moves with its
              incoming edges
            </List.Item>
            <List.Item>
              <Code>del_node X</Code> — delete the word and its edges;{' '}
              <Code>append_feats "/" X =[re"Number|Gender"]=&gt; Y</Code> — copy X's features (never
              form/lemma/upos/xpos)
            </List.Item>
            <List.Item>
              <Code>X [lemma=lex.noun]</Code> … <Code>X.Gender = lex.Gender</Code> — a lexicon
              declared in the rule between <Code>#BEGIN lex</Code> and <Code>#END</Code>:
              tab-separated, first line the field names
            </List.Item>
            <List.Item>
              The root is an edge from an anchor node with <Code>form="__0__"</Code>, as in Grew:{' '}
              <Code>X []</Code> matches it, <Code>X [upos]</Code> does not
            </List.Item>
            <List.Item>
              <Code>
                rule name {'{'} pattern {'{'} … {'}'} commands {'{'} … {'}'} {'}'}
              </Code>{' '}
              and{' '}
              <Code>
                strat main {'{'} Seq(Onf(a), Onf(b)) {'}'}
              </Code>{' '}
              — several rules; without a strategy they run as <Code>Onf(Alt(…))</Code>
            </List.Item>
          </List>
          <Text size="sm" c="dimmed">
            Not supported: <Code>add_node</Code>, <Code>unorder</Code>, <Code>insert</Code>, lexicon
            files. A rule that matches but changes nothing stops with an error.
          </Text>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>

    <Accordion.Item value="syntax">
      <Accordion.Control>Grew syntax reference</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="xs">
          <Text size="sm">
            Queries use{' '}
            <Anchor href="https://grew.fr/doc/request/" target="_blank" rel="noreferrer">
              Grew request syntax
            </Anchor>
            . A node is a syntactic word; a sentence matches when the whole pattern fits inside it.
          </Text>
          <List size="sm" spacing={2}>
            <List.Item>
              <Code>X [upos=VERB, Number=Sing]</Code> — node with features (<Code>|</Code> for "or",{' '}
              <Code>!Feat</Code> undefined, <Code>Feat&lt;&gt;Val</Code> not-equal,{' '}
              <Code>re"…"</Code> / <Code>/…/i</Code> regex)
            </List.Item>
            <List.Item>
              <Code>X -[nsubj]-&gt; Y</Code> — dependency edge (<Code>-[a|b]-&gt;</Code>,{' '}
              <Code>-[^a|b]-&gt;</Code>, <Code>-[re"…"]-&gt;</Code>, <Code>X -&gt; Y</Code> any)
            </List.Item>
            <List.Item>
              <Code>X &lt; Y</Code> / <Code>X &lt;&lt; Y</Code> — immediate / any precedence (
              <Code>&gt;</Code> / <Code>&gt;&gt;</Code> reversed); <Code>X -&gt;&gt; Y</Code> —
              dominates
            </List.Item>
            <List.Item>
              <Code>X.lemma = Y.lemma</Code> — same value across nodes; <Code>delta(X,Y)=2</Code> —
              linear distance
            </List.Item>
            <List.Item>
              <Code>
                without {'{'} … {'}'}
              </Code>{' '}
              — must NOT match;{' '}
              <Code>
                global {'{'} is_projective {'}'}
              </Code>{' '}
              — whole-sentence constraint
            </List.Item>
          </List>
          <Text size="sm" c="dimmed">
            Not supported (these report a clear error): grew lexicons & cluster-by, enhanced
            dependencies, and very large linear distances. <Code>is_tree</Code>/
            <Code>is_cyclic</Code> assume well-formed UD trees.
          </Text>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  </Accordion>
);
