import { Link } from 'react-router-dom';
import { historyHref } from '@ui/hooks/useHistoryParam.js';
import { t } from '@ui/lib/i18n.js';
import { APP_ROUTES } from '@/appRoutes.js';
import { changesGroup } from './jobText.js';

/**
 * Links to what a job changed in one document: its History entry for the
 * job's work there (`glossGroup`, where it wrote something) and for making
 * analyses consistent (`harmonizeGroup`), each where the job has one. Nothing
 * for a document the job did not write in, or one that is gone. While the job
 * runs (`running`), its entry is still being added to: "Changes so far".
 */
export const JobHistoryLinks = ({ projectId, document: d, running = false }) => {
  if (d.name === null || d.name === undefined) return null;
  const path = APP_ROUTES.document(projectId, d.documentId);
  const links = [
    [changesGroup(d), running ? t('Changes so far') : t('Changes')],
    [d.harmonizeGroup, t('Analyses made consistent')],
  ].filter(([group]) => group);
  return (
    <span className="flex flex-wrap gap-x-3">
      {links.map(([group, label]) => (
        <Link key={group} className="underline" to={historyHref(path, group)}>
          {label}
        </Link>
      ))}
    </span>
  );
};
