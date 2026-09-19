import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ServiceDefaultsSettings } from '@ui/components/shared/ServiceDefaultsSettings.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UMR_SPOTS } from '../../utils/serviceDefaults.js';

// Project-level Services settings. The registry, the spot cards and the saving
// are shared with plaid-igt and plaid-ud; what is this app's is the spot list
// in `utils/serviceDefaults.js`.
export const ProjectServicesSettings = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();
  const [project, setProject] = useState(null);

  return (
    <ServiceDefaultsSettings
      projectId={projectId}
      client={getClient()}
      spots={UMR_SPOTS}
      canManage={canManageProject(project, user)}
      onProjectLoaded={setProject}
    />
  );
};
