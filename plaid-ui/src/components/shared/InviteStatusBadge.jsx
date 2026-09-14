import { Badge } from '../ui/badge';
import { INVITE_STATUS_CLASS } from '../../domain/invites.js';

/** An invite's status, wherever one is listed. */
export const InviteStatusBadge = ({ status }) => (
  <Badge variant="outline" className={INVITE_STATUS_CLASS[status] || INVITE_STATUS_CLASS.used}>
    {status}
  </Badge>
);
