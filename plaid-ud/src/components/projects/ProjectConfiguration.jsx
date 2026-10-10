import { ProjectSetupPage } from '@ui/components/shared/ProjectSetupPage.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { SETUP } from './setup.jsx';

// The standalone /configuration page: the app's layers in a project, and the
// one button that adds what is missing.
export const ProjectConfiguration = () => (
  <ProjectSetupPage layerInfo={getUdLayerInfo} setup={SETUP} />
);
