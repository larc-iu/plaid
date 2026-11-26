import { ROLES, findByRole } from '@larc-iu/plaid-client';
import { adoptSubstrate, setupUnfinished } from '../../domain/udProjectSetup.js';
import { missingUdLayerLabels } from '../../utils/udLayerUtils.js';
import { t, tx } from '@ui/lib/i18n.js';

// UD's setup, for the Documents tab and the setup page (plaid-ui's
// ProjectDocumentsPage and ProjectSetupPage). UD's layers are the same in
// every project, so setting one up is one button (see `adoptSubstrate`). The
// text layer UD builds on is the one carrying the baseline role, which every
// Plaid app makes.

// The layer names in bold are the names the layers are stored under.
const span = (c) => <span className="font-medium">{c}</span>;

// The sentences are read when the page is drawn: getters, so each message is
// looked up in the language of the page, not at module load.
export const SETUP = {
  app: 'UD', // i18n-ignore: the app's name
  get note() {
    return t('Adds UD annotation. The text and tokens do not change.');
  },
  adopt: (client, project) => adoptSubstrate(client, project),
  // A set-up that stopped after the layers, with words still to make.
  unfinished: setupUnfinished,
  // Two text layers with no baseline role between them is not a project any
  // Plaid app makes, and UD cannot tell which one it is meant to annotate.
  blocked: (info, projectId, project) => {
    const textLayers = project?.textLayers || [];
    return !findByRole(textLayers, ROLES.BASELINE) && textLayers.length > 1
      ? {
          title: t('More than one text layer'),
          body: t(
            'UD annotates one text layer, and this project has {n}. A project made in Plaid IGT, Plaid UD or Plaid UMR has one.',
            { n: textLayers.length },
          ),
        }
      : null;
  },
  missingLabels: (info) => missingUdLayerLabels(info.missingLayers),
  get allSet() {
    return t('Every Universal Dependencies layer is set up.');
  },
  get card() {
    return {
      title: t('Token hierarchy and annotations'),
      body: t(
        'The three-layer token hierarchy and the annotation layers below it are created, or completed. Layers that already exist are reused, including ones another app set up, and the text and the tokens in them are left as they are.',
      ),
      layers: (
        <>
          <li>{tx('<span>Sentences</span> token layer (partitioning)', { span })}</li>
          <li>
            {tx(
              '<span>Tokens</span> token layer (non-overlapping, nested in sentences): orthographic tokens',
              { span },
            )}
          </li>
          <li>
            {tx(
              '<span>Words</span> token layer (overlap allowed, nested in tokens): where annotations live. A token splits into one or more words (multi-word tokens)',
              { span },
            )}
          </li>
          <li>{t('Span layers on words: Form, Lemma, UPOS, XPOS, Features')}</li>
          <li>{t('Dependency and enhanced dependency relation layers on the Lemma layer')}</li>
        </>
      ),
    };
  },
};

// The setup page every "set it up" link points at.
export const setupHref = (projectId) => `/projects/${projectId}/configuration`;
