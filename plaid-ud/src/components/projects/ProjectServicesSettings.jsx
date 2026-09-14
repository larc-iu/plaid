import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { TASKS } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ServiceDefaultsSettings } from '@ui/components/shared/ServiceDefaultsSettings.jsx';
import { canManageProject } from '@ui/domain/permissions.js';
import { BUILTIN_TOKENIZE_SEGMENTER } from '../../utils/serviceDefaults.js';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras.
const SPOTS = [
  {
    key: TASKS.PARSE,
    label: 'Parse',
    description:
      'Fills in lemmas, POS tags, features and dependencies for a document. ' +
      'The Parse button in the text and annotation editors.',
    builtins: [],
  },
  {
    key: TASKS.TOKENIZE,
    label: 'Tokenize',
    description:
      'Splits a document into sentences, tokens and words. ' +
      'The Tokenize button in the text editor.',
    builtins: [
      {
        name: BUILTIN_TOKENIZE_SEGMENTER,
        label: 'Unicode segmentation (this browser)',
      },
    ],
  },
];

// Project-level Services settings. The registry, the spot cards and the saving
// are shared with plaid-igt; what is this app's is the list of spots above.
export const ProjectServicesSettings = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();
  const [project, setProject] = useState(null);

  return (
    <ServiceDefaultsSettings
      projectId={projectId}
      client={getClient()}
      spots={SPOTS}
      canManage={canManageProject(project, user)}
      onProjectLoaded={setProject}
    />
  );
};
