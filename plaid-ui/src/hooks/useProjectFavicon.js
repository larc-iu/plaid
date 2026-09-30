import { useEffect } from 'react';
import { TARTAN_CUT, tartanRects } from '../domain/projectTartan.js';

// Inside a project, the browser tab wears the project's tartan in place of
// Plaid's mark, so tabs open on different projects tell apart at a glance.
// Every app routes a project as /projects/<id>/..., and a document lives
// under its project, so the id is read off the path. Anywhere else the tab
// has the mark the page was served with.

const PROJECT_IN_PATH =
  /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

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

export const useProjectFavicon = (pathname) => {
  const projectId = PROJECT_IN_PATH.exec(pathname)?.[1] ?? null;
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (!link || !projectId) return undefined;
    const served = link.getAttribute('href');
    link.setAttribute('href', iconOf(projectId));
    return () => link.setAttribute('href', served);
  }, [projectId]);
};
