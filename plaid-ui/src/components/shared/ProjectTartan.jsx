import { useId } from 'react';
import { TARTAN_CUT, tartanRects } from '../../domain/projectTartan.js';

/**
 * A project's tartan (domain/projectTartan.js), beside its name. Decorative:
 * the name next to it is what a screen reader reads. `size` is the rendered
 * size in px, which decides how much of the sett is drawn.
 */
export const ProjectTartan = ({ projectId, size = 14, className }) => {
  const clip = useId();
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      data-testid="project-tartan"
    >
      <defs>
        <clipPath id={clip}>
          <path d={TARTAN_CUT} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {tartanRects(projectId, size).map((r, i) => (
          <rect
            key={i}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            fill={r.color}
            opacity={r.opacity}
          />
        ))}
      </g>
    </svg>
  );
};
