import { Link } from 'react-router-dom';
import { projectTarget } from './projectTarget';

/**
 * A link to a target as `projectTarget` gives it. Another app is a full page
 * load, so a plain anchor, not a router Link.
 */
const TargetLink = ({ target, children, ...rest }) =>
  typeof target === 'string' ? (
    <Link to={target} {...rest}>
      {children}
    </Link>
  ) : (
    <a href={target.href} {...rest}>
      {children}
    </a>
  );

/** The project's name as a link to wherever it leads. */
export const ProjectLink = ({ project, children, ...rest }) => (
  <TargetLink target={projectTarget(project)} {...rest}>
    {children ?? project.name}
  </TargetLink>
);
