// The cloth's dyes as a categorical palette, for any surface that colours
// things by kind: ud's dependency arcs, umr's node groups and chains. Taken
// from the project plaids (projectTartan.js) and deepened where text sits on
// white. None is violet or amber, which mark machine and contributor work,
// and none is a red, which reads as destructive.
//
// The dyes by name are the one home of these values. CSS reads them as
// `--plaid-dye-<name>` (plaid-ui's index.css) and Tailwind as `dye-<name>`
// (tailwind.preset.js). plaid-ui's dyes.test.js holds the CSS copy to this one
// and fails on the hex values anywhere else.
export const DYES = Object.freeze({
  indigo: '#43678a',
  madder: '#9a4b2c',
  teal: '#2a5c57',
  olive: '#6b6d34',
  navy: '#22364f',
  green: '#4f7a55',
  walnut: '#8a6a45',
  stone: '#6f6a63',
});

export const CATEGORICAL = [
  DYES.indigo,
  DYES.madder,
  DYES.teal,
  DYES.olive,
  DYES.navy,
  DYES.green,
  DYES.walnut,
  DYES.stone,
];
