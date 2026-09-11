import { ChevronRight } from 'lucide-react';

// The three reference panels above the query box. Native <details> rather than
// a disclosure primitive: the browser owns the open state, the summary is
// focusable and keyboard-operable for free, and Find-in-page reaches the closed
// panels. The only thing worth styling is the marker, which we replace with a
// chevron that turns.
const Panel = ({ title, children }) => (
  <details className="group rounded-md border bg-card">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      {title}
    </summary>
    <div className="border-t px-4 py-3">{children}</div>
  </details>
);

// Inline code, the one thing this screen uses on nearly every line.
const C = ({ children }) => (
  <code className="whitespace-pre-wrap rounded bg-muted px-1 py-0.5 font-mono text-xs">
    {children}
  </code>
);

const A = ({ href, children }) => (
  <a
    className="text-primary underline underline-offset-4"
    href={href}
    target="_blank"
    rel="noreferrer"
  >
    {children}
  </a>
);

const Bullets = ({ children }) => <ul className="ml-5 list-disc space-y-1 text-sm">{children}</ul>;

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
  <div className="flex flex-col gap-1.5">
    {items.map(([label, q]) => (
      <div key={q} className="flex items-baseline gap-3">
        <button
          type="button"
          className="shrink-0 text-sm text-primary underline-offset-4 hover:underline"
          onClick={() => onPick(q)}
        >
          {label}
        </button>
        <C>{q}</C>
      </div>
    ))}
  </div>
);

export const GrewHelp = ({ onPick }) => (
  <div className="flex flex-col gap-2">
    <Panel title="Search examples">
      <ExampleList items={EXAMPLES} onPick={onPick} />
    </Panel>

    <Panel title="Rewrite examples">
      <div className="flex flex-col gap-3">
        <ExampleList items={REWRITE_EXAMPLES} onPick={onPick} />
        <p className="text-sm">
          A pattern with a{' '}
          <C>
            commands {'{'} … {'}'}
          </C>{' '}
          block is a <A href="https://grew.fr/doc/commands/">Grew rewriting rule</A>. Each sentence
          is rewritten until no rule matches, one match at a time, and the result is previewed
          before anything is applied.
        </p>
        <Bullets>
          <li>
            <C>X.upos = VERB</C>, <C>X.Number = D.Number</C>, <C>X.lemma = Y.lemma + "s"</C>,{' '}
            <C>X.f = Y.f[1:]</C>, <C>del_feat X.Number</C>
          </li>
          <li>
            <C>e.label = "obj"</C>, <C>e.2 = pass</C>, <C>del_feat e.2</C> — on an edge named{' '}
            <C>e: X -[…]-&gt; Y</C>
          </li>
          <li>
            <C>add_edge X -[obj]-&gt; Y</C>, <C>add_edge e: X -&gt; Y</C> (the label of e),{' '}
            <C>del_edge e</C>, <C>del_edge X -[obj]-&gt; Y</C>
          </li>
          <li>
            <C>shift X ==&gt; Y</C>, <C>shift_in X =[nsubj|obj]=&gt; Y</C>,{' '}
            <C>shift_out X =[^det]=&gt; Y</C> — move X's edges to Y; the root moves with its
            incoming edges
          </li>
          <li>
            <C>del_node X</C> — delete the word and its edges;{' '}
            <C>append_feats "/" X =[re"Number|Gender"]=&gt; Y</C> — copy X's features (never
            form/lemma/upos/xpos)
          </li>
          <li>
            <C>X [lemma=lex.noun]</C> … <C>X.Gender = lex.Gender</C> — a lexicon declared in the
            rule between <C>#BEGIN lex</C> and <C>#END</C>: tab-separated, first line the field
            names
          </li>
          <li>
            The root is an edge from an anchor node with <C>form="__0__"</C>, as in Grew:{' '}
            <C>X []</C> matches it, <C>X [upos]</C> does not
          </li>
          <li>
            <C>
              rule name {'{'} pattern {'{'} … {'}'} commands {'{'} … {'}'} {'}'}
            </C>{' '}
            and{' '}
            <C>
              strat main {'{'} Seq(Onf(a), Onf(b)) {'}'}
            </C>{' '}
            — several rules; without a strategy they run as <C>Onf(Alt(…))</C>
          </li>
        </Bullets>
        <p className="text-sm text-muted-foreground">
          Not supported: <C>add_node</C>, <C>unorder</C>, <C>insert</C>, lexicon files. A rule that
          matches but changes nothing stops with an error.
        </p>
      </div>
    </Panel>

    <Panel title="Grew syntax reference">
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          Queries use <A href="https://grew.fr/doc/request/">Grew request syntax</A>. A node is a
          syntactic word; a sentence matches when the whole pattern fits inside it.
        </p>
        <Bullets>
          <li>
            <C>X [upos=VERB, Number=Sing]</C> — node with features (<C>|</C> for "or", <C>!Feat</C>{' '}
            undefined, <C>Feat&lt;&gt;Val</C> not-equal, <C>re"…"</C> / <C>/…/i</C> regex)
          </li>
          <li>
            <C>X -[nsubj]-&gt; Y</C> — dependency edge (<C>-[a|b]-&gt;</C>, <C>-[^a|b]-&gt;</C>,{' '}
            <C>-[re"…"]-&gt;</C>, <C>X -&gt; Y</C> any)
          </li>
          <li>
            <C>X &lt; Y</C> / <C>X &lt;&lt; Y</C> — immediate / any precedence (<C>&gt;</C> /{' '}
            <C>&gt;&gt;</C> reversed); <C>X -&gt;&gt; Y</C> — dominates
          </li>
          <li>
            <C>X.lemma = Y.lemma</C> — same value across nodes; <C>delta(X,Y)=2</C> — linear
            distance
          </li>
          <li>
            <C>
              without {'{'} … {'}'}
            </C>{' '}
            — must NOT match;{' '}
            <C>
              global {'{'} is_projective {'}'}
            </C>{' '}
            — whole-sentence constraint
          </li>
        </Bullets>
        <p className="text-sm text-muted-foreground">
          Not supported (these report a clear error): grew lexicons and cluster-by, enhanced
          dependencies, and very large linear distances. <C>is_tree</C> / <C>is_cyclic</C> assume
          well-formed UD trees.
        </p>
      </div>
    </Panel>
  </div>
);
