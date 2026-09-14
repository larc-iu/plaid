import { useEffect, useMemo, useState } from 'react';

// A project's members, with the names to show for them.
//
// The Activity panel's roster is the project's OWN members, so "no changes in
// this window" names the people who were given access and have not used it,
// which is the question an instructor asks. That means the list comes from the
// project's three permission arrays rather than from who happens to appear in
// the audit log.
//
// One directory read rather than a lookup per member. Every screen that shows
// this is maintainer-only, which is exactly who the directory is open to, and a
// failure leaves the ids standing in for the names rather than emptying the
// list.
export const useProjectRoster = (client, project) => {
  const [people, setPeople] = useState({});

  const memberIds = useMemo(
    () =>
      [
        ...new Set([
          ...(project?.readers || []),
          ...(project?.writers || []),
          ...(project?.maintainers || []),
        ]),
      ].sort(),
    [project],
  );

  useEffect(() => {
    if (!client || memberIds.length === 0) return undefined;
    let alive = true;
    client.users
      .list()
      .then((all) => {
        if (!alive) return;
        setPeople(Object.fromEntries((all || []).map((u) => [u.id, u])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, memberIds.length]);

  // `avatarHash` defaults to null, not undefined: null is what tells the
  // avatar there is no picture and spares it a request that can only 404.
  // Before the directory read lands that is a guess, and the right one —
  // most people have no picture, and the ones who do get theirs a moment
  // later when this recomputes.
  return useMemo(
    () =>
      memberIds.map((id) => ({
        id,
        displayName: people[id]?.displayName || id,
        avatarHash: people[id]?.avatarHash ?? null,
      })),
    [memberIds, people],
  );
};
