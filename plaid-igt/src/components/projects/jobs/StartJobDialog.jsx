import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, MoreHorizontal, Play } from 'lucide-react';
import { notifyError } from '@/utils/feedback';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ui/components/ui/dropdown-menu';
import { SearchInput } from '@ui/components/shared/list-search';
import { JOB_SETUP } from '@ui/components/assistant/purposes.js';
import { useStartConversation } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { IGT_ASSISTANT } from '../assistant/adapter.js';
import { STARTER_TEXTS, activeJobOf, instructionsLength, jobPath, startJob } from './jobText.js';
import { InstructionsCount, JobActiveLine, NoWorkerLine } from './jobLines.jsx';

const byName = (a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);

// Where the full Assistant tab opens on a new job setup conversation, whose
// turns are asked from the document when one is named (AssistantTab).
const setUpHref = (projectId, documentId) =>
  `/projects/${projectId}?tab=assistant&purpose=${JOB_SETUP}` +
  (documentId ? `&document=${encodeURIComponent(documentId)}` : '');

/**
 * Set up job: a job is set up in a new assistant conversation, which drafts
 * the job card the job is started from (BRIEF-SU). From the project's
 * Documents and Jobs tabs and from a document's header, where the
 * conversation's turns are asked from that document. The docked panel opens
 * on it, or the full Assistant tab where the window has no room for the
 * panel, and from a document's header it names the document to the tab, so
 * the turns are asked from it there too. With no assistant online for the
 * project the button opens the Start job form instead. Pressed before the app knows whether one is (discovery
 * not answered yet, on a cold load), it waits for the answer, pending as a
 * service's run button is, and then does what the answer says.
 *
 * `documents` is the project's listing when the caller already has it (the
 * Documents tab), else the form reads it on open. `documentId` opens the form
 * with that one document chosen. `small` draws the button at the size of a
 * document header's buttons.
 */
export const SetUpJob = ({
  projectId,
  client,
  documents: given = null,
  documentId = null,
  small = false,
}) => {
  const [open, setOpen] = useState(false);
  // Pressed while it is not yet known whether an assistant is online.
  const [waiting, setWaiting] = useState(false);
  const available = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const wide = useWideEnoughToDock();
  const startConversation = useStartConversation();
  const navigate = useNavigate();
  const act = () => {
    if (available !== true) setOpen(true);
    else if (wide) startConversation({ purpose: JOB_SETUP });
    else navigate(setUpHref(projectId, documentId));
  };
  const setUp = () => (available === null ? setWaiting(true) : act());
  const Icon = waiting ? Loader2 : Play;
  useEffect(() => {
    if (!waiting || available === null) return;
    setWaiting(false);
    act();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, available]);
  return (
    <>
      <Button
        variant="outline"
        size={small ? 'sm' : 'default'}
        className="gap-1.5"
        onClick={setUp}
        disabled={waiting}
        aria-busy={waiting || undefined}
      >
        <Icon className={waiting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Set up job
      </Button>
      {open && (
        <StartJobDialog
          projectId={projectId}
          client={client}
          documents={given}
          documentId={documentId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

/**
 * The Jobs tab's way to the Start job form with no assistant: a "⋯" menu with
 * Start without the assistant, for every writer.
 */
export const StartWithoutAssistant = ({ projectId, client, documents = null }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More job actions" title="More">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            Start without the assistant
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && (
        <StartJobDialog
          projectId={projectId}
          client={client}
          documents={documents}
          documentId={null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

// The dialog itself, mounted per opening: everything chosen in it, and the id
// its job is made under, start fresh each time it opens.
const StartJobDialog = ({ projectId, client, documents: given, documentId, onClose }) => {
  const navigate = useNavigate();
  const [listed, setListed] = useState(given);
  const [worker, setWorker] = useState(null);
  const [all, setAll] = useState(!documentId);
  const [chosen, setChosen] = useState(() => new Set(documentId ? [documentId] : []));
  const [query, setQuery] = useState('');
  const [instructions, setInstructions] = useState('');
  const [starting, setStarting] = useState(false);
  // The project's job already under way, when Start was refused for it.
  const [activeJob, setActiveJob] = useState(null);
  // The id the job is made under, once per opening (createOnce.js).
  const mint = useRef(null);

  useEffect(() => {
    let live = true;
    client.jobs
      .worker()
      .then((w) => live && setWorker(w))
      .catch(() => {});
    if (!given) {
      client.projects
        .listDocuments(projectId)
        .then((docs) => live && setListed(docs))
        .catch((err) => live && notifyError(err, 'Failed to list the documents'));
    }
    return () => {
      live = false;
    };
  }, [client, projectId, given]);

  const documents = useMemo(() => [...(listed || [])].sort(byName), [listed]);
  const instructionsMax = worker?.instructionsMaxChars ?? null;
  const instructionsOver =
    instructionsMax !== null && instructionsLength(instructions) > instructionsMax;
  // The most documents a job takes, core's (jobs.worker()). A project of more
  // cannot name them all, so All documents is not offered there.
  const documentsMax = worker?.documentsMax ?? null;
  const tooMany = documentsMax !== null && documents.length > documentsMax;
  const allChosen = all && !tooMany;
  const picked = allChosen ? documents.length : documents.filter((d) => chosen.has(d.id)).length;
  const pickedOver = documentsMax !== null && picked > documentsMax;
  const q = query.trim().toLowerCase();
  const shown = q ? documents.filter((d) => (d.name || '').toLowerCase().includes(q)) : documents;

  const toggleDocument = (id, on) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const selectShown = () => setChosen((prev) => new Set([...prev, ...shown.map((d) => d.id)]));

  const canStart =
    !starting &&
    instructions.trim() !== '' &&
    picked > 0 &&
    !pickedOver &&
    !instructionsOver &&
    listed !== null;

  const start = async () => {
    setStarting(true);
    setActiveJob(null);
    try {
      const job = await startJob(client, projectId, mint, {
        documents: allChosen ? null : documents.filter((d) => chosen.has(d.id)).map((d) => d.id),
        instructions,
      });
      onClose();
      navigate(jobPath(projectId, job.id));
    } catch (err) {
      const active = activeJobOf(err);
      if (active) setActiveJob(active);
      else notifyError(err, 'Failed to start the job');
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start job</DialogTitle>
          <DialogDescription>
            The assistant works through the chosen documents by the instructions. It writes every
            change it decides on, deletions included. Its report lists the rest: project setup,
            changes outside the documents in hand, confirmations, document restores, corpus-wide
            changes, and entry renames, merges and deletions unless started by a maintainer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Documents</legend>
            <label
              className={`flex items-center gap-2 text-sm ${tooMany ? 'text-muted-foreground' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name="job-documents"
                checked={allChosen}
                disabled={tooMany}
                onChange={() => setAll(true)}
              />
              <span>All documents ({documents.length.toLocaleString()})</span>
            </label>
            {tooMany && (
              <p className="ml-6 text-xs text-muted-foreground">
                A job takes at most {documentsMax.toLocaleString()} documents.
              </p>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="job-documents"
                checked={!allChosen}
                onChange={() => setAll(false)}
              />
              <span>Selected documents</span>
            </label>
            {!allChosen && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput
                    className="min-w-40 flex-1"
                    placeholder="Search documents…"
                    value={query}
                    onChange={setQuery}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectShown}
                    disabled={!shown.length}
                  >
                    Select shown
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setChosen(new Set())}
                    disabled={!picked}
                  >
                    Clear
                  </Button>
                  <span
                    className={`whitespace-nowrap text-xs ${pickedOver ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {picked.toLocaleString()} selected
                  </span>
                </div>
                <div
                  className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2"
                  aria-label="Documents"
                  role="group"
                >
                  {shown.map((d) => (
                    <label
                      key={d.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={chosen.has(d.id)}
                        onChange={(e) => toggleDocument(d.id, e.target.checked)}
                      />
                      <span className="flex-1 truncate">{d.name}</span>
                    </label>
                  ))}
                  {listed !== null && !shown.length && (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      {documents.length ? 'No documents match.' : 'No documents.'}
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-instructions">Instructions</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Start from">
              {STARTER_TEXTS.map((s) => (
                <Button
                  key={s.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInstructions(s.text)}
                >
                  {s.label}
                </Button>
              ))}
            </div>
            <Textarea
              id="job-instructions"
              compose
              rows={5}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              aria-invalid={instructionsOver ? true : undefined}
            />
            <InstructionsCount text={instructions} max={instructionsMax} />
          </div>

          <NoWorkerLine worker={worker} />

          {activeJob && <JobActiveLine projectId={projectId} jobId={activeJob} onOpen={onClose} />}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button onClick={start} disabled={!canStart}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
