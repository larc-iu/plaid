import { Badge } from '../ui/badge';
import { INVITE_STATUS_CLASS, INVITE_STATUS_TITLE } from '../../domain/invites.js';
import { t } from '../../lib/i18n.js';

/** An invite's status, wherever one is listed. */
export const InviteStatusBadge = ({ status }) => (
  <Badge
    variant="outline"
    className={INVITE_STATUS_CLASS[status] || INVITE_STATUS_CLASS.used}
    title={INVITE_STATUS_TITLE[status] && t(INVITE_STATUS_TITLE[status])}
  >
    {t(
      '{status, select, active {active} used {used} expired {expired} revoked {revoked} inactive {inactive} other {{status}}}',
      { status },
    )}
  </Badge>
);
