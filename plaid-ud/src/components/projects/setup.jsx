import { ROLES, findByRole } from '@larc-iu/plaid-client';
import { adoptSubstrate, setupUnfinished } from '../../domain/udProjectSetup.js';
import { missingUdLayerLabels } from '../../utils/udLayerUtils.js';

// UD's setup, for the Documents tab and the setup page (plaid-ui's
// ProjectDocumentsPage and ProjectSetupPage). UD's layers are the same in
// every project, so setting one up is one button (see `adoptSubstrate`). The
// text layer UD builds on is the one carrying the baseline role, which every
// Plaid app makes.
export const SETUP = {
  app: 'UD',
  note: 'Adds UD annotation. The text and tokens do not change.',
  adopt: (client, project) => adoptSubstrate(client, project),
  // A set-up that stopped after the layers, with words still to make.
  unfinished: setupUnfinished,
  // Two text layers with no baseline role between them is not a project any
  // Plaid app makes, and UD cannot tell which one it is meant to annotate.
  blocked: (info, projectId, project) => {
    const textLayers = project?.textLayers || [];
    return !findByRole(textLayers, ROLES.BASELINE) && textLayers.length > 1
      ? {
          title: 'More than one text layer',
          body: `UD annotates one text layer, and this project has ${textLayers.length}. A project made in Plaid IGT, Plaid UD or Plaid UMR has one.`,
        }
      : null;
  },
  missingLabels: (info) => missingUdLayerLabels(info.missingLayers),
  allSet: 'Every Universal Dependencies layer is set up.',
  card: {
    title: 'Token hierarchy and annotations',
    body: 'The three-layer token hierarchy and the annotation layers below it are created, or completed. Layers that already exist are reused, including ones another app set up, and the text and the tokens in them are left as they are.',
    layers: (
      <>
        <li>
          <span className="font-medium">Sentences</span> token layer (partitioning)
        </li>
        <li>
          <span className="font-medium">Tokens</span> token layer (non-overlapping, nested in
          sentences): orthographic tokens
        </li>
        <li>
          <span className="font-medium">Words</span> token layer (overlap allowed, nested in
          tokens): where annotations live. A token splits into one or more words (multi-word tokens)
        </li>
        <li>Span layers on words: Form, Lemma, UPOS, XPOS, Features</li>
        <li>Dependency and enhanced dependency relation layers on the Lemma layer</li>
      </>
    ),
  },
};

// The setup page every "set it up" link points at.
export const setupHref = (projectId) => `/projects/${projectId}/configuration`;
