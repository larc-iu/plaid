import { Link } from 'react-router-dom';
import { Notice } from './Notice.jsx';

// What a screen says in a project the app has no layers in yet: the fact,
// and for a maintainer the way to the app's setup page (`setupHref`). `app`
// is the app's short name. `title`: whether the notice leads with "Not set up
// for X".
export const NotSetUpNotice = ({ app, canManage, setupHref, title = true, className }) => (
  <Notice tone="warning" className={className}>
    {title && <p className="font-medium">Not set up for {app}</p>}
    <p className={title ? 'mt-1' : undefined}>
      This project is not set up for {app}.{' '}
      {canManage ? (
        <>
          <Link className="font-medium underline underline-offset-2" to={setupHref}>
            Set it up
          </Link>
          .
        </>
      ) : (
        'A project maintainer can set it up.'
      )}
    </p>
  </Notice>
);
