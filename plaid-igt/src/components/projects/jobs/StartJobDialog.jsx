import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
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
import { SearchInput } from '@ui/components/shared/list-search';
import { jobTaskText } from '@ui/domain/jobs.js';
import { JOB_TASKS, activeJobOf, jobPath, noteLength, startJob } from './jobText.js';
import { JobActiveLine, NoWorkerLine, NoteCount } from './jobLines.jsx';

const byName = (a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);

/**
 * Start job: the button and its dialog, from the project's Documents tab and
 * from a document's header. `project` is the project as read, whose linked
 * lexicons say whether Link to lexicon can be done. `documents` is the
 * project's listing when the caller already has it (the Documents tab), else
 * it is read on open.
 * `documentId` opens the dialog with that one document chosen. `small` draws
 * the button at the size of a document header's buttons.
 */
export const StartJob = ({
  projectId,
  project,
  client,
  documents: given = null,
  documentId = null,
  small = false,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size={small ? 'sm' : 'default'}
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Play className="h-4 w-4" /> Start job
      </Button>
      {open && (
        <StartJobDialog
          projectId={projectId}
          linksLexicon={(project?.vocabs || []).length > 0}
          client={client}
          documents={given}
          documentId={documentId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

// The dialog itself, mounted per opening: everything chosen in it, and the id
// its job is made under, start fresh each time it opens.
const StartJobDialog = ({
  projectId,
  linksLexicon,
  client,
  documents: given,
  documentId,
  onClose,
}) => {
  const navigate = useNavigate();
  const [listed, setListed] = useState(given);
  const [worker, setWorker] = useState(null);
  const [all, setAll] = useState(!documentId);
  const [chosen, setChosen] = useState(() => new Set(documentId ? [documentId] : []));
  const [query, setQuery] = useState('');
  // Linking needs a lexicon the project links: without one a job could only
  // fail its checks (no-lexicon), so it is not offered.
  const [tasks, setTasks] = useState(
    () => new Set(JOB_TASKS.filter((t) => t !== 'link' || linksLexicon)),
  );
  const [note, setNote] = useState('');
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
  const noteMax = worker?.noteMaxChars ?? null;
  const noteOver = noteMax !== null && noteLength(note) > noteMax;
  // The most documents a job takes, core's (jobs.worker()). A project of more
  // cannot name them all, so All documents is not offered there.
  const documentsMax = worker?.documentsMax ?? null;
  const tooMany = documentsMax !== null && documents.length > documentsMax;
  const allChosen = all && !tooMany;
  const picked = allChosen ? documents.length : documents.filter((d) => chosen.has(d.id)).length;
  const pickedOver = documentsMax !== null && picked > documentsMax;
  const q = query.trim().toLowerCase();
  const shown = q ? documents.filter((d) => (d.name || '').toLowerCase().includes(q)) : documents;

  const toggleTask = (value, on) =>
    setTasks((prev) => {
      const next = new Set(prev);
      if (on) next.add(value);
      else next.delete(value);
      // Linking writes the analysis it links, so it goes with Segment and gloss.
      if (value === 'gloss' && !on) next.delete('link');
      return next;
    });

  const toggleDocument = (id, on) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const selectShown = () => setChosen((prev) => new Set([...prev, ...shown.map((d) => d.id)]));

  const canStart =
    !starting && tasks.size > 0 && picked > 0 && !pickedOver && !noteOver && listed !== null;

  const start = async () => {
    setStarting(true);
    setActiveJob(null);
    try {
      const job = await startJob(client, projectId, mint, {
        tasks: [...tasks],
        documents: allChosen ? null : documents.filter((d) => chosen.has(d.id)).map((d) => d.id),
        note,
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
            An AI model fills blank analyses and translations in the chosen documents.
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

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Tasks</legend>
            {JOB_TASKS.map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={tasks.has(t)}
                  disabled={t === 'link' && (!tasks.has('gloss') || !linksLexicon)}
                  onChange={(e) => toggleTask(t, e.target.checked)}
                />
                <span>{jobTaskText(t)}</span>
                {t === 'link' && !linksLexicon && (
                  <span className="text-xs text-muted-foreground">The project has no lexicon.</span>
                )}
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-note">Instructions</Label>
            <Textarea
              id="job-note"
              compose
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={noteOver ? true : undefined}
            />
            <NoteCount note={note} max={noteMax} />
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
