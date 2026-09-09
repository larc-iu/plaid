import { useEffect, useState } from 'react';
import { ActivityPanel } from './ActivityPanel';

// The instance-wide half of the activity view. The roster it passes is the
// account directory, so "no changes in this window" names people who exist
// and have not worked, which the tally alone cannot say.
export const AdminActivity = ({ client }) => {
  const [roster, setRoster] = useState([]);

  useEffect(() => {
    let alive = true;
    client.users
      .list()
      .then((all) => {
        if (alive) setRoster((all || []).filter((u) => !u.deactivatedAt));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client]);

  return <ActivityPanel client={client} roster={roster} />;
};
