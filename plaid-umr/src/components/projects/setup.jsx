import { t, tx } from '@ui/lib/i18n.js';
import { igtProjectUrl } from '@ui/domain/siblingApps.js';
import { buttonVariants } from '@ui/components/ui/button';
import { adoptSubstrate } from '../../domain/umrProjectSetup.js';
import { missingUmrLayerLabels } from '../../utils/umrLayerUtils.js';

const bold = (c) => <span className="font-medium">{c}</span>;

// UMR's setup, for the Documents tab and the setup page (plaid-ui's
// ProjectDocumentsPage and ProjectSetupPage). UMR's layers are the same in
// every project, so setting one up is one button. A substrate is a text layer
// with sentences and words in it. Text and tokens are made in IGT, never
// here, so without one there is nothing for this app to add, and a maintainer
// is sent where it can be made.
//
// The words a person reads are getters, read when the page draws, once the
// language is known. The layer names in the card are the names the layers are
// stored under, so they stay as they are.
export const SETUP = {
  app: 'UMR',
  get note() {
    return t('Adds UMR annotation.');
  },
  adopt: (client, project) => adoptSubstrate(client, project),
  blocked: (info, projectId) =>
    info.textLayer && info.sentenceTokenLayer && info.wordTokenLayer
      ? null
      : {
          title: t('No text to annotate'),
          body: t(
            'This project has no sentences or words. Text and tokens are made in Plaid IGT, and read here. A project made with New UMR project here comes with them.',
          ),
          action: (
            <a
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={igtProjectUrl(projectId)}
            >
              {t('Open in Plaid IGT')}
            </a>
          ),
        },
  missingLabels: (info) => missingUmrLayerLabels(info.missingLayers).map((label) => t(label)),
  get allSet() {
    return t('Every UMR layer is set up.');
  },
  card: {
    get title() {
      return t('UMR layers');
    },
    get body() {
      return t(
        "This project has a text layer with sentences and words. UMR's own layers are added beside them. Layers that already exist are reused, and the text, the sentences and the words are left as they are.",
      );
    },
    get layers() {
      return (
        <>
          <li>
            {tx('<span>{name}</span> token layer, one token per anchor', {
              name: 'UMR nodes', // i18n-ignore: the name the layer is stored under
              span: bold,
            })}
          </li>
          <li>
            {tx('<span>{name}</span> span layer, one span per node', {
              name: 'UMR concepts', // i18n-ignore: the name the layer is stored under
              span: bold,
            })}
          </li>
          <li>
            {tx('<span>{name}</span> relation layer, sentence-level edges', {
              name: 'UMR relations', // i18n-ignore: the name the layer is stored under
              span: bold,
            })}
          </li>
          <li>
            {tx('<span>{name}</span> relation layer, temporal, modal and coreference triples', {
              name: 'UMR document graph', // i18n-ignore: the name the layer is stored under
              span: bold,
            })}
          </li>
        </>
      );
    },
  },
};

// The setup page every "set it up" link points at.
export const setupHref = (projectId) => `/projects/${projectId}/configuration`;
