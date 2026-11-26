import { Link } from 'react-router-dom';
import { t, tx } from '../../lib/i18n.js';
import { Notice } from './Notice.jsx';

// What a screen says in a project the app has no layers in yet: the fact,
// and for a maintainer the way to the app's setup page (`setupHref`). `app`
// is the app's short name. `title`: whether the notice leads with "Not set up
// for X". Plain information: nothing is broken, and the warm tones are for
// what is.
export const NotSetUpNotice = ({ app, canManage, setupHref, title = true, className }) => (
  <Notice tone="info" className={className}>
    {title && <p className="font-medium">{t('Not set up for {app}', { app })}</p>}
    <p className={title ? 'mt-1' : undefined}>
      {canManage
        ? tx('This project is not set up for {app}. <a>Set it up</a>.', {
            app,
            a: (c) => (
              <Link className="font-medium underline underline-offset-2" to={setupHref}>
                {c}
              </Link>
            ),
          })
        : t('This project is not set up for {app}. A project maintainer can set it up.', { app })}
    </p>
  </Notice>
);
