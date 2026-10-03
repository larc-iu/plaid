import { Link } from 'react-router-dom';
import { canManageProject } from '@ui/domain/permissions.js';

// What every document tab says in a project UD has not adopted: the fact, and
// for a maintainer the way to the set-up page.
export const NotSetUpForUd = ({ project, user }) =>
  canManageProject(project, user) ? (
    <>
      This project is not set up for UD.{' '}
      <Link
        className="font-medium underline underline-offset-2"
        to={`/projects/${project.id}/configuration`}
      >
        Set it up
      </Link>
      .
    </>
  ) : (
    'This project is not set up for UD. A project maintainer can set it up.'
  );
