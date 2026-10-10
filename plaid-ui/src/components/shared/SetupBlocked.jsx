import { Info } from 'lucide-react';
import { Notice } from './Notice.jsx';

// What a maintainer sees in place of an app's Set up button when the project
// lacks something the app cannot make: `blocked`, as an app's
// `setup.blocked(info, projectId, project)` gives it, `{ title, body, action }`.
export const SetupBlocked = ({ blocked, className }) => (
  <Notice tone="warning" icon={Info} className={className}>
    <div className="flex flex-col items-start gap-3">
      <p className="font-medium">{blocked.title}</p>
      <p className="text-muted-foreground">{blocked.body}</p>
      {blocked.action}
    </div>
  </Notice>
);
