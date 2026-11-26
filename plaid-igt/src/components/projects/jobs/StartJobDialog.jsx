import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
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
import { compareNames } from '@ui/domain/collation.js';
import { t } from '@ui/lib/i18n.js';
import { STARTER_TEXTS, activeJobOf, instructionsLength, jobPath, startJob } from './jobText.js';
import { InstructionsCount, JobActiveLine, NoWorkerLine } from './jobLines.jsx';

// Number order, so "Text 2" comes before "Text 10" (RP-9), the order of
// every document list (compareNames).
const byName = (a, b) => compareNames(a.name, b.name) || a.id.localeCompare(b.id);

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
          <Button
            variant="outline"
            size="icon"
            aria-label={t('More job actions')}
            title={t('More')}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            {t('Start without the assistant')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && (
        <StartJobDialog
          projectId={projectId}
          client={client}
          documents={documents}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};

// The dialog itself, mounted per opening: everything chosen in it, and the id
// its job is made under, start fresh each time it opens.
const StartJobDialog = ({ projectId, client, documents: given, onClose }) => {
  const navigate = useNavigate();
  const [listed, setListed] = useState(given);
  const [worker, setWorker] = useState(null);
  // Nothing is chosen until the person chooses (RP-9: every document was, and
  // a Start pressed unread ran the job on the whole project).
  const [all, setAll] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
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
        .catch((err) => live && notifyError(err, t('Failed to list the documents')));
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
      else notifyError(err, t('Failed to start the job'));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Start job')}</DialogTitle>
          <DialogDescription>
            {t(
              'The assistant works through the chosen documents and writes its changes as it goes.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('Documents')}</legend>
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
              <span>{t('All documents ({n, number})', { n: documents.length })}</span>
            </label>
            {tooMany && (
              <p className="ml-6 text-xs text-muted-foreground">
                {t('A job takes at most {n, number} documents.', { n: documentsMax })}
              </p>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="job-documents"
                checked={!allChosen}
                onChange={() => setAll(false)}
              />
              <span>{t('Selected documents')}</span>
            </label>
            {!allChosen && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput
                    className="min-w-40 flex-1"
                    placeholder={t('Search documents…')}
                    value={query}
                    onChange={setQuery}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectShown}
                    disabled={!shown.length}
                  >
                    {t('Select shown')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setChosen(new Set())}
                    disabled={!picked}
                  >
                    {t('Clear')}
                  </Button>
                  <span
                    className={`whitespace-nowrap text-xs ${pickedOver ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {t('{n, number} selected', { n: picked })}
                  </span>
                </div>
                <div
                  className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2"
                  aria-label={t('Documents')}
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
                      {documents.length ? t('No documents match.') : t('No documents.')}
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-instructions">{t('Instructions')}</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('Start from')}>
              {STARTER_TEXTS.map((s) => (
                <Button
                  key={s.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setInstructions(s.text)}
                >
                  {t(s.label)}
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
            <p className="text-sm text-muted-foreground">
              {t(
                'The job decides from the instructions what to fill. Its plan shows on the job’s page.',
              )}
            </p>
          </div>

          <NoWorkerLine worker={worker} />

          {activeJob && (
            <JobActiveLine
              projectId={projectId}
              jobId={activeJob}
              onOpen={onClose}
              client={client}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            {t('Cancel')}
          </Button>
          <Button onClick={start} disabled={!canStart}>
            {starting ? t('Starting…') : t('Start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
