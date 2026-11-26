import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import { t, tx, msg } from '@ui/lib/i18n.js';

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

// Grew code in a row, comma-separated. Code is never translated.
const Codes = ({ items }) =>
  items.map((q, i) => (
    <Fragment key={q}>
      {i > 0 && ', '}
      <C>{q}</C>
    </Fragment>
  ));

// One piece of Grew code, as a value in a message.
const code = (q) => <C>{q}</C>;

const grewLink = (href) => (c) => <A href={href}>{c}</A>;

// Click an example to drop it into the query box. Each label is a message.
const EXAMPLES = [
  [msg('Subject of a verb'), 'pattern { V [upos=VERB]; S [upos=NOUN|PROPN]; V -[nsubj]-> S }'],
  [msg('Verb with no object'), 'pattern { V [upos=VERB] } without { V -[obj]-> * }'],
  [msg('Singular or plural noun'), 'pattern { N [upos=NOUN, Number=Sing|Plur] }'],
  [msg('Object before its verb'), 'pattern { V[]; O[]; V -[obj]-> O; O << V }'],
  [
    msg('Verb governing subject and object'),
    'pattern { V [upos=VERB]; V -[nsubj]-> Su; V -[obj]-> Ob }',
  ],
  [msg('Adjacent determiner + noun'), 'pattern { D [upos=DET]; N [upos=NOUN]; D < N }'],
  [msg('Lemma "be" anywhere in its subtree'), 'pattern { V [lemma="be"]; V ->> X }'],
  [msg('Non-projective sentences'), 'pattern { X [] } global { is_not_projective }'],
];

// Rewriting rules: a pattern plus commands. Each example stops matching once
// applied, so it runs once per sentence position.
const REWRITE_EXAMPLES = [
  [msg('Retag a word'), 'pattern { X [lemma="that", upos=SCONJ] } commands { X.upos = PRON }'],
  [
    msg('Subtype the subject of a passive'),
    'pattern { e: V -[nsubj]-> S; V [Voice=Pass] } commands { e.label = "nsubj:pass" }',
  ],
  [
    msg('Copy number from a determiner'),
    'pattern { N [upos=NOUN, !Number]; D [upos=DET, Number]; N -[det]-> D } commands { N.Number = D.Number }',
  ],
  [
    msg('Reattach a modifier to the head'),
    'pattern { H -[obj]-> N; e: N -[nmod]-> M; M [Case=Ins] } commands { del_edge e; add_edge H -[obl]-> M }',
  ],
  [
    msg('Share a subject in the enhanced graph'),
    'pattern { V1 -[conj]-> V2; V1 -[nsubj]-> S } without { V2 -[E:nsubj]-> S } commands { add_edge V2 -[E:nsubj]-> S }',
  ],
  [
    msg('Gender from a lexicon'),
    'pattern { X [upos=NOUN, lemma=lex.noun, !Gender] } commands { X.Gender = lex.Gender }\n#BEGIN lex\nnoun\tGender\ndog\tMasc\ncat\tFem\n#END',
  ],
  [
    msg('Two rules in order'),
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
          {t(label)}
        </button>
        <C>{q}</C>
      </div>
    ))}
  </div>
);

export const GrewHelp = ({ onPick }) => (
  <div className="flex flex-col gap-2">
    <Panel title={t('Search examples')}>
      <ExampleList items={EXAMPLES} onPick={onPick} />
    </Panel>

    <Panel title={t('Rewrite examples')}>
      <div className="flex flex-col gap-3">
        <ExampleList items={REWRITE_EXAMPLES} onPick={onPick} />
        <p className="text-sm">
          {tx(
            'A pattern with a {commands} block is a <a>Grew rewriting rule</a>. Each sentence is rewritten until no rule matches, one match at a time, and the result is previewed before anything is applied.',
            {
              commands: code('commands { … }'),
              a: grewLink('https://grew.fr/doc/commands/'),
            },
          )}
        </p>
        <Bullets>
          <li>
            <Codes
              items={[
                'X.upos = VERB',
                'X.Number = D.Number',
                'X.lemma = Y.lemma + "s"',
                'X.f = Y.f[1:]',
                'del_feat X.Number',
              ]}
            />
          </li>
          <li>
            {tx('{commands}, on an edge named {edge}', {
              commands: <Codes items={['e.label = "obj"', 'e.2 = pass', 'del_feat e.2']} />,
              edge: code('e: X -[…]-> Y'),
            })}
          </li>
          <li>
            {tx('{add}, {copy} (the label of e), {remove}', {
              add: code('add_edge X -[obj]-> Y'),
              copy: code('add_edge e: X -> Y'),
              remove: <Codes items={['del_edge e', 'del_edge X -[obj]-> Y']} />,
            })}
          </li>
          <li>
            {tx('{add} adds to the enhanced graph, and {move} moves an edge there', {
              add: code('add_edge X -[E:nsubj]-> Y'),
              move: code('e.enhanced = yes'),
            })}
          </li>
          <li>
            {tx("{commands}: move X's edges to Y, and the root moves with its incoming edges", {
              commands: (
                <Codes
                  items={[
                    'shift X ==> Y',
                    'shift_in X =[nsubj|obj]=> Y',
                    'shift_out X =[^det]=> Y',
                  ]}
                />
              ),
            })}
          </li>
          <li>{tx('{command}: delete the word and its edges', { command: code('del_node X') })}</li>
          <li>
            {tx("{command}: copy X's features (never form/lemma/upos/xpos)", {
              command: code('append_feats "/" X =[re"Number|Gender"]=> Y'),
            })}
          </li>
          <li>
            {tx(
              '{pattern} … {command}, a lexicon declared in the rule between {begin} and {end}: tab-separated, first line the field names',
              {
                pattern: code('X [lemma=lex.noun]'),
                command: code('X.Gender = lex.Gender'),
                begin: code('#BEGIN lex'),
                end: code('#END'),
              },
            )}
          </li>
          <li>
            {tx(
              'The root is an edge from an anchor node with {form}, as in Grew: {bare} matches it, {upos} does not',
              {
                form: code('form="__0__"'),
                bare: code('X []'),
                upos: code('X [upos]'),
              },
            )}
          </li>
          <li>
            {tx('{rule} and {strat}, several rules. Without a strategy they run as {fallback}', {
              rule: code('rule name { pattern { … } commands { … } }'),
              strat: code('strat main { Seq(Onf(a), Onf(b)) }'),
              fallback: code('Onf(Alt(…))'),
            })}
          </li>
        </Bullets>
        <p className="text-sm text-muted-foreground">
          {tx(
            'Not supported: {commands}, lexicon files. A rule that matches but changes nothing stops with an error.',
            { commands: <Codes items={['add_node', 'unorder', 'insert']} /> },
          )}
        </p>
      </div>
    </Panel>

    <Panel title={t('Grew syntax reference')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {tx(
            'Queries use <a>Grew request syntax</a>. A node is a syntactic word. A sentence matches when the whole pattern fits inside it.',
            { a: grewLink('https://grew.fr/doc/request/') },
          )}
        </p>
        <Bullets>
          <li>
            {tx(
              '{node}: node with features ({or} for "or", {unset} undefined, {neq} not-equal, {re} / {flags} regex)',
              {
                node: code('X [upos=VERB, Number=Sing]'),
                or: code('|'),
                unset: code('!Feat'),
                neq: code('Feat<>Val'),
                re: code('re"…"'),
                flags: code('/…/i'),
              },
            )}
          </li>
          <li>
            {tx('{edge}: dependency edge ({labels}, {anyLabel} any)', {
              edge: code('X -[nsubj]-> Y'),
              labels: <Codes items={['-[a|b]->', '-[^a|b]->', '-[re"…"]->']} />,
              anyLabel: code('X -> Y'),
            })}
          </li>
          <li>
            {tx(
              '{edge}: an edge the enhanced graph adds to the tree. A plain label reads the tree, and {anyLabel} and {numbered} read both',
              {
                edge: code('X -[E:nsubj]-> Y'),
                anyLabel: code('X -> Y'),
                numbered: code('-[1=nsubj]->'),
              },
            )}
          </li>
          <li>
            {tx('{next} / {before}: immediate / any precedence ({after} / {later} reversed)', {
              next: code('X < Y'),
              before: code('X << Y'),
              after: code('>'),
              later: code('>>'),
            })}
          </li>
          <li>{tx('{clause}: dominates', { clause: code('X ->> Y') })}</li>
          <li>{tx('{clause}: same value across nodes', { clause: code('X.lemma = Y.lemma') })}</li>
          <li>{tx('{clause}: linear distance', { clause: code('delta(X,Y)=2') })}</li>
          <li>{tx('{clause}: must NOT match', { clause: code('without { … }') })}</li>
          <li>
            {tx('{clause}: whole-sentence constraint', {
              clause: code('global { is_projective }'),
            })}
          </li>
        </Bullets>
        <p className="text-sm text-muted-foreground">
          {tx(
            'Not supported: grew lexicons and cluster-by, {tree} / {notTree}, and very large linear distances. {forest} / {cyclic} assume well-formed UD trees.',
            {
              tree: code('is_tree'),
              notTree: code('is_not_tree'),
              forest: code('is_forest'),
              cyclic: code('is_cyclic'),
            },
          )}
        </p>
      </div>
    </Panel>
  </div>
);
