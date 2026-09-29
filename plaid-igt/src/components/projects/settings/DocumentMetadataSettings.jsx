import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import { notifyError } from '@/utils/feedback';
import { isConfigConflict, storedConfig } from '@ui/domain/configCells.js';
import { useConfigCell } from '@ui/hooks/useConfigCell.js';
import { PREDEFINED_FIELDS, readDocumentMetadata, IGT_NAMESPACE } from '@/domain/igtConfig';

// What DocumentMetadataManager shows, read off a project's config. Null means
// "use the defaults".
const extractMetadata = (project) => {
  const current = readDocumentMetadata(project?.config);
  if (!current || !Array.isArray(current)) return null;
  const enabled = current.map((field) => ({
    name: field.name,
    tagset: field.tagset ?? null,
    enabled: true, // only enabled fields are stored
    isCustom: !(field.name in PREDEFINED_FIELDS),
  }));
  // A predefined field absent from the config is switched off, not gone: keep
  // it in the table so it can be switched back on. (Only enabled fields are
  // stored, so these used to vanish from the table on reload.)
  const have = new Set(enabled.map((f) => f.name));
  const disabled = Object.keys(PREDEFINED_FIELDS)
    .filter((name) => !have.has(name))
    .map((name) => ({ name, tagset: null, enabled: false, isCustom: false }));
  return { enabledFields: [...enabled, ...disabled] };
};

// `project` and `tagsetNames` come from AnnotationSettings, which holds the
// live project, so a tagset created in the section above is pickable here
// immediately.
export const DocumentMetadataSettings = ({
  project,
  projectId,
  client,
  tagsetNames = [],
  violations = {},
  onProjectUpdate,
}) => {
  const [hasError, setHasError] = useState(false);

  // Read off the LIVE project rather than fetched once on mount, so the table
  // re-syncs whenever the project changes under it — in particular after the
  // Tagsets section renames a tagset and repoints the fields that used it. A
  // table still holding the old name would write it back on its next save.
  const initialData = useMemo(() => extractMetadata(project), [project]);
  // Each write expects the fields this page last read or wrote, so a page
  // opened before another maintainer's save is refused rather than writing
  // over it.
  const metadataCell = useConfigCell(storedConfig(project, IGT_NAMESPACE, 'documentMetadata'));

  // Save changes to the API
  const handleSaveChanges = async (data) => {
    try {
      setHasError(false);

      if (!client) {
        throw new Error('Not authenticated');
      }

      // Convert to API format (only store enabled fields with just name)
      const enabledFields = data.enabledFields.filter((field) => field.enabled);
      const apiConfig = enabledFields.map((field) => ({
        name: field.name,
        // Only stored when set, so a field with no tagset stays a bare {name}.
        ...(field.tagset ? { tagset: field.tagset } : {}),
      }));

      await metadataCell.write(async (expected) => {
        await client.projects.setConfig(
          projectId,
          IGT_NAMESPACE,
          'documentMetadata',
          apiConfig,
          undefined,
          { expected },
        );
        return apiConfig;
      });
      // The Tagsets section reads which fields point at which tagset off the
      // project: its "used by" line and seed button for a tagset used only by
      // a metadata field stayed stale until a reload without this.
      await onProjectUpdate?.();
    } catch (error) {
      console.error('Failed to save document metadata configuration:', error);
      // Someone else saved since: show what is stored now.
      if (isConfigConflict(error)) {
        Promise.resolve(onProjectUpdate?.()).catch((err) =>
          console.error('Failed to reload the project:', err),
        );
      } else {
        setHasError(true);
      }
      throw error;
    }
  };

  // Handle errors
  const handleError = (error) => {
    if (!isConfigConflict(error)) setHasError(true);
    notifyError(error, 'Failed to save the metadata fields');
  };

  if (hasError) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">
              Failed to load or save the metadata fields
            </p>
            <p className="text-sm text-muted-foreground">Refresh the page and try again.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">Document metadata</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Configure which metadata fields are available when creating or editing documents in this
        project.
      </p>

      <DocumentMetadataManager
        initialData={initialData}
        onSaveChanges={handleSaveChanges}
        onError={handleError}
        tagsetNames={tagsetNames}
        violations={violations}
        projectId={projectId}
        showTitle={false}
      />
    </div>
  );
};
