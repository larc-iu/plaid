import { t } from '@ui/lib/i18n.js';
import { ProjectListPage } from '@ui/components/shared/ProjectListPage.jsx';
import { ProjectForm } from './ProjectForm';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';

// "Words" = the word token layer of the shared substrate, which is what this
// app annotates over.
const wordLayerId = (project) => getUmrLayerInfo(project).wordTokenLayer?.id;

export const ProjectList = () => (
  <ProjectListPage wordLayerId={wordLayerId} newProject={t('New UMR project')} form={ProjectForm} />
);
