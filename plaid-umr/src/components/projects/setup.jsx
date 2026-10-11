import { igtProjectUrl } from '@ui/domain/siblingApps.js';
import { buttonVariants } from '@ui/components/ui/button';
import { adoptSubstrate } from '../../domain/umrProjectSetup.js';
import { missingUmrLayerLabels } from '../../utils/umrLayerUtils.js';

// UMR's setup, for the Documents tab and the setup page (plaid-ui's
// ProjectDocumentsPage and ProjectSetupPage). UMR's layers are the same in
// every project, so setting one up is one button. A substrate is a text layer
// with sentences and words in it. Text and tokens are made in IGT, never
// here, so without one there is nothing for this app to add, and a maintainer
// is sent where it can be made.
export const SETUP = {
  app: 'UMR',
  note: 'Adds UMR annotation. The text, sentences and words do not change.',
  adopt: (client, project, info) => adoptSubstrate(client, info),
  blocked: (info, projectId) =>
    info.textLayer && info.sentenceTokenLayer && info.wordTokenLayer
      ? null
      : {
          title: 'No text to annotate',
          body: 'This project has no sentences or words. Text and tokens are made in Plaid IGT, and read here. A project made with New UMR project here comes with them.',
          action: (
            <a
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={igtProjectUrl(projectId)}
            >
              Open in Plaid IGT
            </a>
          ),
        },
  missingLabels: (info) => missingUmrLayerLabels(info.missingLayers),
  allSet: 'Every UMR layer is set up.',
  card: {
    title: 'UMR layers',
    body: "This project has a text layer with sentences and words. UMR's own layers are added beside them. Layers that already exist are reused, and the text, the sentences and the words are left as they are.",
    layers: (
      <>
        <li>
          <span className="font-medium">UMR nodes</span> token layer, one token per anchor
        </li>
        <li>
          <span className="font-medium">UMR concepts</span> span layer, one span per node
        </li>
        <li>
          <span className="font-medium">UMR relations</span> relation layer, sentence-level edges
        </li>
        <li>
          <span className="font-medium">UMR document graph</span> relation layer, temporal, modal
          and coreference triples
        </li>
      </>
    ),
  },
};

// The setup page every "set it up" link points at.
export const setupHref = (projectId) => `/projects/${projectId}/configuration`;
