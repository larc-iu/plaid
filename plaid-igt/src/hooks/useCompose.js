import * as React from 'react';
import { setComposeProject } from '@/lib/composeInput.js';

// The hook that wired a single field to the composer moved into plaid-ui as
// `useComposeRef`, since the fields that opt in are that package's Input and
// Textarea. What stays here is the project binding: the codes are the open
// project's, which is a fact only this app has.

/**
 * Point the composer at the open project's own codes, for as long as this
 * screen is up. Called from the two places that hold a project (the project
 * page and the document page), so a code bound in Settings works everywhere in
 * the app without every field having to know about the project.
 */
export function useComposeProject(project) {
  React.useEffect(() => {
    setComposeProject(project ?? null);
    return () => setComposeProject(null);
  }, [project]);
}
