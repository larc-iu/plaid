import { isDefaultModality } from '../../../domain/sentenceGraph.js';

// A document-level line is coloured as its tags are: a hue per family, and
// grey for the modality nearly every event carries. An arrowhead takes no
// colour from the line it ends, so each family has a marker of its own.
export const LINE_FAMILIES = {
  modal: 'var(--umr-doc)',
  temporal: 'var(--umr-doc-temporal)',
  coref: 'var(--umr-doc-coref)',
  default: 'hsl(var(--muted-foreground))',
};

export const lineFamily = (triple, nodesById) =>
  isDefaultModality(triple, nodesById)
    ? 'default'
    : LINE_FAMILIES[triple.group]
      ? triple.group
      : 'modal';
