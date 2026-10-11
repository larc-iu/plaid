import { useMemo } from 'react';
import { showsTartan, tartanWeave } from '../domain/projectTartan.js';

/**
 * What a project's tab list wears so its active tab's underline is woven in
 * the project's sett: `{ className, style }` to spread on the TabsList, or
 * nothing for a project that does not show its plaid (or has not loaded), so
 * the teal underline stays.
 */
export const useTartanWeave = (project) => {
  const id = showsTartan(project) ? project.id : null;
  return useMemo(() => {
    if (!id) return { className: undefined, style: undefined };
    const { image, period } = tartanWeave(id);
    return {
      className: 'plaid-woven',
      style: { '--plaid-weave': image, '--plaid-weave-period': `${period}px` },
    };
  }, [id]);
};
