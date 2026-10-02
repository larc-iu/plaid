import { Badge } from '../ui/badge';
import { INVITE_STATUS_CLASS, INVITE_STATUS_TITLE } from '../../domain/invites.js';

/** An invite's status, wherever one is listed. */
export const InviteStatusBadge = ({ status }) => (
  <Badge
    variant="outline"
    className={INVITE_STATUS_CLASS[status] || INVITE_STATUS_CLASS.used}
    title={INVITE_STATUS_TITLE[status]}
  >
    {status}
  </Badge>
);
