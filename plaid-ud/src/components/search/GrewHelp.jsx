import { Accordion, Stack, Text, Code, Anchor, List, Group } from '@mantine/core';

// Click an example to drop it into the query box.
const EXAMPLES = [
  ['Subject of a verb', 'pattern { V [upos=VERB]; S [upos=NOUN|PROPN]; V -[nsubj]-> S }'],
  ['Verb with no object', 'pattern { V [upos=VERB] } without { V -[obj]-> * }'],
  ['Singular or plural noun', 'pattern { N [upos=NOUN, Number=Sing|Plur] }'],
  ['Object before its verb', 'pattern { V[]; O[]; V -[obj]-> O; O << V }'],
  ['Verb governing subject and object', 'pattern { V [upos=VERB]; V -[nsubj]-> Su; V -[obj]-> Ob }'],
  ['Adjacent determiner + noun', 'pattern { D [upos=DET]; N [upos=NOUN]; D < N }'],
  ['Lemma "be" anywhere in its subtree', 'pattern { V [lemma="be"]; V ->> X }'],
  ['Non-projective sentences', 'pattern { X [] } global { is_not_projective }'],
];

export const GrewHelp = ({ onPick }) => (
  <Accordion variant="separated" defaultValue={null}>
    <Accordion.Item value="examples">
      <Accordion.Control>Examples</Accordion.Control>
      <Accordion.Panel>
        <Stack gap={6}>
          {EXAMPLES.map(([label, q]) => (
            <Group key={q} gap="sm" wrap="nowrap" align="baseline">
              <Anchor component="button" type="button" size="sm" onClick={() => onPick(q)} style={{ flexShrink: 0 }}>
                {label}
              </Anchor>
              <Code style={{ fontSize: 12 }}>{q}</Code>
            </Group>
          ))}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>

    <Accordion.Item value="syntax">
      <Accordion.Control>Grew syntax reference</Accordion.Control>
      <Accordion.Panel>
        <Stack gap="xs">
          <Text size="sm">
            Queries use{' '}
            <Anchor href="https://grew.fr/doc/request/" target="_blank" rel="noreferrer">Grew request syntax</Anchor>.
            A node is a syntactic word; a sentence matches when the whole pattern fits inside it.
          </Text>
          <List size="sm" spacing={2}>
            <List.Item><Code>X [upos=VERB, Number=Sing]</Code> — node with features (<Code>|</Code> for "or", <Code>!Feat</Code> undefined, <Code>Feat&lt;&gt;Val</Code> not-equal, <Code>re"…"</Code> / <Code>/…/i</Code> regex)</List.Item>
            <List.Item><Code>X -[nsubj]-&gt; Y</Code> — dependency edge (<Code>-[a|b]-&gt;</Code>, <Code>-[^a|b]-&gt;</Code>, <Code>-[re"…"]-&gt;</Code>, <Code>X -&gt; Y</Code> any)</List.Item>
            <List.Item><Code>X &lt; Y</Code> / <Code>X &lt;&lt; Y</Code> — immediate / any precedence; <Code>X -&gt;&gt; Y</Code> — dominates</List.Item>
            <List.Item><Code>X.lemma = Y.lemma</Code> — same value across nodes; <Code>delta(X,Y)=2</Code> — linear distance</List.Item>
            <List.Item><Code>without {'{'} … {'}'}</Code> — must NOT match; <Code>global {'{'} is_projective {'}'}</Code> — whole-sentence constraint</List.Item>
          </List>
          <Text size="sm" c="dimmed">
            Not supported (these report a clear error): grew lexicons & cluster-by, enhanced
            dependencies, <Code>sent_id</Code> (dropped on import), and very large linear
            distances. <Code>is_tree</Code>/<Code>is_cyclic</Code> assume well-formed UD trees.
          </Text>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  </Accordion>
);
