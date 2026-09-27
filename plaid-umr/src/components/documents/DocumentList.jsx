import { Link } from 'react-router-dom';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { adoptSubstrate } from '../../domain/umrProjectSetup.js';
import { udProjectUrl } from '@ui/domain/siblingApps.js';
import { buttonVariants } from '@ui/components/ui/button';
import { ProjectDocumentsPage } from '@ui/components/shared/ProjectDocumentsPage.jsx';

// UMR's layers are the same in every project, so setting one up is one
// button. A substrate is a text layer with sentences and words in it. Text and
// tokens are made in IGT or UD, never here, so without one there is nothing
// for this app to add, and a maintainer is sent where it can be made.
const SETUP = {
  app: 'UMR',
  note: 'Adds UMR annotation. The text, sentences and words do not change.',
  adopt: (client, project, info) => adoptSubstrate(client, info),
  blocked: (info, projectId) =>
    info.textLayer && info.sentenceTokenLayer && info.wordTokenLayer
      ? null
      : {
          title: 'No text to annotate',
          body: 'This project has no sentences or words. Text and tokens are made in Plaid IGT or Plaid UD, and read here. A project made with New UMR project here comes with them.',
          action: (
            <a
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={udProjectUrl(projectId)}
            >
              Open in Plaid UD
            </a>
          ),
        },
};

const tableLayers = (info) => ({ wordLayerId: info.wordTokenLayer?.id });

const rowHref = (projectId, documentId) =>
  `/projects/${projectId}/documents/${documentId}/annotate`;

// Documents arrive through .umr import. Text is edited in IGT or UD, so there
// is no New document button here.
const ImportUmr = ({ projectId }) => (
  <Link to={`/projects/${projectId}/import-export`} className={buttonVariants()}>
    Import .umr
  </Link>
);

export const DocumentList = () => (
  <ProjectDocumentsPage
    tabs={ProjectTabs}
    layerInfo={getUmrLayerInfo}
    setup={SETUP}
    tableLayers={tableLayers}
    rowHref={rowHref}
    newDocument={ImportUmr}
  />
);
