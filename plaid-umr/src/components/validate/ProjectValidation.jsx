import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table.jsx';
import { textIncludes } from '@ui/domain/collation.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { notifyError, humanizeError } from '../../utils/feedback.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { validateProject } from '../../domain/validationQueries.js';

// What this project's UMR annotation does not satisfy: one row per problem,
// each naming the document and the sentence it is in.
//
// The checks are the umrtools validator's, run here rather than on the server,
// so nothing is refused at write time: an import, a service or the API can
// store whatever it has, and this is where a maintainer finds out what that
// was.

// A problem's level decides how loud its row is. Anything unrecognized reads
// as a warning rather than as nothing.
const levelBadge = (level) =>
  level === 'error' ? (
    <Badge variant="destructive">error</Badge>
  ) : (
    <Badge variant="secondary">{level || 'warning'}</Badge>
  );

export const ProjectValidation = () => {
  const { project, projectId, loading, canConfigure } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();

  useDocumentTitle('Validation', project?.name);

  const layerInfo = useMemo(() => (project ? getUmrLayerInfo(project) : null), [project]);
  const [problems, setProblems] = useState(null);
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    if (!client || !layerInfo?.isConfigured) return;
    setBusy(true);
    try {
      // The concept and word layers, so the scan asks the server which
      // documents hold a graph or any words before it reads any of them.
      const found = await validateProject(client, projectId, {
        conceptLayerId: layerInfo.conceptLayer?.id,
        wordLayerId: layerInfo.wordTokenLayer?.id,
      });
      // The position in the report is the row's identity: two identical
      // problems in one sentence are two rows, and nothing else tells them
      // apart.
      setProblems((found || []).map((p, i) => ({ ...p, key: `${i}` })));
    } catch (err) {
      console.error('Validation scan failed:', err);
      notifyError(humanizeError(err, 'Could not read the project.'), 'Scan failed');
    } finally {
      setBusy(false);
    }
  }, [client, layerInfo, projectId]);

  useEffect(() => {
    scan();
  }, [scan]);

  const columns = useMemo(
    () => [
      {
        key: 'document',
        label: 'Document',
        sort: (p) => p.documentName?.toLowerCase() ?? '',
        // A real anchor: middle-click and cmd-click open the document in a new
        // browser tab.
        render: (p) => (
          <Link
            to={`/projects/${projectId}/documents/${p.documentId}/annotate`}
            className="font-medium hover:underline"
            dir="auto"
          >
            {p.documentName || '(untitled)'}
          </Link>
        ),
      },
      {
        key: 'sentence',
        label: 'Sentence',
        align: 'right',
        sort: (p) => p.sentenceIndex ?? null,
        // The sentence's number, counting from one, as the editor shows it. A
        // problem about the document as a whole has none.
        render: (p) => p.sentenceIndex ?? '',
      },
      {
        key: 'level',
        label: 'Level',
        sort: (p) => p.level ?? '',
        render: (p) => levelBadge(p.level),
      },
      {
        key: 'message',
        label: 'Problem',
        sort: (p) => p.message?.toLowerCase() ?? '',
        render: (p) => (
          <div className="min-w-0">
            <p>{p.message}</p>
            {p.code && <code className="text-xs text-muted-foreground">{p.code}</code>}
          </div>
        ),
      },
    ],
    [projectId],
  );

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project || !canConfigure) return null;

  const configured = layerInfo?.isConfigured;

  return (
    <div className="w-full">
      <ProjectTabs projectId={projectId} project={project} />
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Validation</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Problems in this project&apos;s UMR annotation, one row each. An import, a service or
              the API can store annotation the checks refuse, which is why it arrives here rather
              than being blocked.
            </p>
          </div>
          <Button variant="outline" onClick={scan} disabled={busy || !configured}>
            {busy ? 'Checking…' : 'Check again'}
          </Button>
        </div>

        {!configured && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Set up the project&apos;s UMR layers first.
          </p>
        )}

        {configured && problems?.length === 0 && !busy && (
          <p className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            <Check className="h-4 w-4 text-green-600" />
            Every check passed.
          </p>
        )}

        {configured && !!problems?.length && (
          <DataTable
            id="umr-validation"
            scope={projectId}
            rows={problems}
            columns={columns}
            rowKey={(p) => p.key}
            defaultSort={{ key: 'document', dir: 'asc' }}
            noun="problem"
            loading={busy}
            empty="Every check passed."
            search={{
              placeholder: 'Search problems…',
              match: (p, q) =>
                textIncludes(p.documentName || '', q) ||
                textIncludes(p.message || '', q) ||
                textIncludes(p.code || '', q),
            }}
          />
        )}
      </div>
    </div>
  );
};
