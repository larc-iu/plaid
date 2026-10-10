import { Link } from 'react-router-dom';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { SETUP } from '../projects/setup.jsx';
import { buttonVariants } from '@ui/components/ui/button';
import { ProjectDocumentsPage } from '@ui/components/shared/ProjectDocumentsPage.jsx';

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
