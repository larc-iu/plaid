import { useEffect } from 'react';
import { TARTAN_CUT, showsTartan, tartanRects } from '../domain/projectTartan.js';

// Inside a project, the browser tab wears the project's tartan in place of
// Plaid's mark, so tabs open on different projects tell apart at a glance.
// Called by the tab strips over a project's and a document's pages, which
// hold the project. Anywhere else, or with tartans off in the project's
// settings, the tab keeps the mark the page was served with.

const iconOf = (projectId) => {
  const rects = tartanRects(projectId, 16)
    .map(
      (r) =>
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.color}" opacity="${r.opacity}"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><clipPath id="c"><path d="${TARTAN_CUT}"/></clipPath><g clip-path="url(#c)">${rects}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

export const useProjectFavicon = (project) => {
  const projectId = showsTartan(project) ? project.id : null;
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (!link || !projectId) return undefined;
    const served = link.getAttribute('href');
    link.setAttribute('href', iconOf(projectId));
    return () => link.setAttribute('href', served);
  }, [projectId]);
};
