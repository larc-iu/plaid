import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.jsx';
import { Combobox } from '../shared/combobox.jsx';
import { Loading } from '../shared/Loading.jsx';
import { humanizeError } from '../../lib/errors.js';
import { notifyError } from '../../lib/notify.js';
import { atProjectCap, projectCandidates } from './projectReach.js';

// The other projects a conversation reads (see projectReach.js): one chip each
// in the composer, and the button beside the paperclip that adds one.

// One project the conversation reads besides its own, removable. `label` is
// its remove button's accessible name, numbered where two chips share a name
// (`chipRemoveLabels`).
export const ProjectChip = ({ project, onRemove, label = `Remove ${project.name}` }) => (
  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 py-1 pl-2.5 pr-1 text-xs">
    <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
    <span dir="auto" className="truncate font-medium">
      {project.name}
    </span>
    <button
      type="button"
      onClick={() => onRemove(project.id)}
      title="Remove"
      aria-label={label}
      className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X className="h-3 w-3" />
    </button>
  </span>
);

// The button, and the list of projects it opens. `onPick({id, name})` checks
// the project and answers `true` when it joined, or the line that says why it
// did not. The list closes only on a join. A refusal is written in the list,
// above the field, and the list stays open for another pick. `max` counts the
// home project, as the assistant advertises it. `opens(project)` says whether
// the assistant can read a project (the adapter's `opensProject`), and only
// those are offered.
export const AddProject = ({
  client,
  homeId,
  joined,
  max,
  opens = null,
  disabled = false,
  onPick,
}) => {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState('');
  // Whether the list is still open when a check comes back: one closed in the
  // meantime has nowhere to show the refusal, which is then a toast.
  const openRef = useRef(false);
  openRef.current = open;
  const full = atProjectCap(joined, max);

  // Read each time the list opens: a project created or shared since the last
  // look belongs in it.
  useEffect(() => {
    if (!open || !client) return undefined;
    let alive = true;
    setError('');
    client.projects
      .list()
      .then((all) => alive && setProjects(all || []))
      .catch((e) => {
        if (!alive) return;
        setError(humanizeError(e, 'Failed to load your projects.'));
        setProjects([]);
      });
    return () => {
      alive = false;
    };
  }, [open, client]);

  const options = projectCandidates(projects, homeId, joined, opens).map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const pick = async (id, option) => {
    if (checking) return;
    setChecking(true);
    setRefused('');
    try {
      const answer = await onPick({ id, name: option.label });
      if (answer === true) {
        setOpen(false);
        setQuery('');
      } else if (typeof answer === 'string' && answer) {
        if (openRef.current) setRefused(answer);
        else notifyError(answer);
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          setRefused('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || full}
          title={full ? `At most ${max} projects` : 'Add project'}
          aria-label="Add project"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-2">
        {projects === null ? (
          <Loading className="px-1 py-1 text-xs" />
        ) : error ? (
          <p className="px-1 py-1 text-xs text-destructive">{error}</p>
        ) : options.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            {projectCandidates(projects, homeId, joined).length
              ? 'No other projects this assistant can read.'
              : 'No other projects.'}
          </p>
        ) : (
          <>
            {/* Above the field, and kept until the next pick. The option
                list, opened again for that pick, may lie over it, and never
                the other way round. Always in the page, so a screen reader
                hears each refusal as it is written. */}
            <p
              role="status"
              className={refused ? 'px-1 pb-1.5 text-xs text-destructive' : 'sr-only'}
            >
              {refused}
            </p>
            <div className="flex items-center gap-2">
              <Combobox
                value={query}
                onChange={setQuery}
                options={options}
                onSubmit={pick}
                autoHighlight
                autoFocus
                placeholder="Project"
                aria-label="Project"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                listClassName="max-w-[18rem]"
                optionClassName="truncate"
              />
              {checking && (
                <span className="shrink-0 text-xs text-muted-foreground">Checking…</span>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};
