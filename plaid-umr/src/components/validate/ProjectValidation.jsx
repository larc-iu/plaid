import { cn } from '@ui/lib/utils';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Badge } from '@ui/components/ui/badge';
import { DataTable } from '@ui/components/shared/data-table.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { ValidationHeader } from '@ui/components/shared/ValidationHeader.jsx';
import { textIncludes } from '@ui/domain/collation.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { notifyError } from '../../utils/feedback.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { validateProject } from '../../domain/validationQueries.js';
import { APP_ROUTES } from '../../appRoutes.js';

// What this project's UMR annotation does not satisfy: one row per problem,
// each naming the document and the sentence it is in.
//
// The checks are the umrtools validator's, run here rather than on the server,
// so nothing is refused at write time: an import, a service or the API can
// store whatever it has, and this is where a maintainer finds out what that
// was.

// Where a row leads: the sentence it is about, at the node it names, or the
// document when it is about the document as a whole.
const problemHref = (projectId, p) => {
  if (p.sentenceIndex == null) return APP_ROUTES.document(projectId, p.documentId);
  const at = APP_ROUTES.sentence(projectId, p.documentId, p.sentenceIndex);
  return p.var ? `${at}&var=${encodeURIComponent(p.var)}` : at;
};

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
        project,
      });
      // The position in the report is the row's identity: two identical
      // problems in one sentence are two rows, and nothing else tells them
      // apart. Zero-padded, since the table breaks a tie on the key as text
      // and the report's order (by sentence) is the one wanted.
      setProblems((found || []).map((p, i) => ({ ...p, key: String(i).padStart(8, '0') })));
    } catch (err) {
      console.error('Validation scan failed:', err);
      notifyError(err, 'Failed to read the project');
    } finally {
      setBusy(false);
    }
  }, [client, layerInfo, projectId, project]);

  useEffect(() => {
    scan();
  }, [scan]);

  const columns = useMemo(
    () => [
      {
        key: 'document',
        label: 'Document',
        sort: (p) => p.documentName?.toLowerCase() ?? '',
        // A real anchor, to the sentence: middle-click and cmd-click open it
        // in a new browser tab.
        render: (p) => (
          <Link to={problemHref(projectId, p)} className="font-medium hover:underline" dir="auto">
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
        render: (p) =>
          p.sentenceIndex == null ? (
            ''
          ) : (
            <Link to={problemHref(projectId, p)} className="hover:underline">
              {p.sentenceIndex}
            </Link>
          ),
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

  if (loading) return <Loading />;
  if (!project || !canConfigure) return null;

  const configured = layerInfo?.isConfigured;

  return (
    <div className="w-full">
      <ProjectTabs projectId={projectId} project={project} />
      {/* The same width in every app: a form's, from the page's left edge. */}
      <div className={cn('w-full', FORM_PAGE_WIDTH)}>
        <ValidationHeader
          description="Problems in this project's UMR annotation, one row each."
          busy={busy}
          disabled={!configured}
          onCheck={scan}
        />

        {!configured && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Set the project up for UMR first.
          </p>
        )}

        {configured && problems?.length === 0 && !busy && (
          <p className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            <Check className="h-4 w-4 text-success" />
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
            // In the URL, so Back from the sentence a row links to returns to
            // the page the row was on.
            pageParam="page"
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
