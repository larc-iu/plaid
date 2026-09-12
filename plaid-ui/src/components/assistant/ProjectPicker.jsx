import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { humanizeError } from '../../lib/errors.js';
import { AssistantMark } from './PlaidMarks.jsx';

// What the dock shows before any project has been in scope: the reader has just
// signed in and is looking at a list of projects, so the panel has nothing to be
// about yet.
//
// It offers the choice rather than sitting empty or refusing to open. The
// assistant is per project all the way down (discovery, the conversation
// records, the agent's workspace), so a project is the one thing it cannot do
// without, and asking for it is a better answer than a chat with 2 of its 64
// tools.
export const ProjectPicker = ({ client, onPick }) => {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    client.projects
      .list()
      .then((all) => {
        if (alive) setProjects(all || []);
      })
      .catch((e) => {
        if (!alive) return;
        setError(humanizeError(e, 'Your projects could not be loaded.'));
        setProjects([]);
      });
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <AssistantMark className="h-4 w-4 shrink-0" />
        <span className="text-muted-foreground">Choose a project</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {projects === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="px-1 py-2 text-xs text-destructive">{error}</p>
        ) : projects.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            The assistant works on one project. Create a project to use it.
          </p>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              title={p.name}
            >
              {p.name}
            </button>
          ))
        )}
      </div>
      <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        The assistant reads one project at a time. Opening a project chooses it.
      </p>
    </div>
  );
};
