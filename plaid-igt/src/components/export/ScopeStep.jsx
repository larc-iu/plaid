import { Label } from '@ui/components/ui/label';

// Step 3: what to export. Scope is a run-time choice, never part of the
// preset; includeVocabularies IS preset state, so this step SAYS what the
// preset does rather than offering it again. It used to be a second switch
// here, identical to the preset editor's and with nothing to say which won,
// and a per-run override of a preset setting is the ad-hoc configuring that
// presets exist to replace.
// historicalOnly locks the scope to the current document: time-travel export
// fetches the document as-of, but the documents-list endpoint has no as-of.
// zipNote (the dataset-level formats) replaces the vocabularies line with that
// note: those archives zip at every scope and decide for themselves what to do
// with the project's vocabularies.
export const ScopeStep = ({
  scope,
  onScopeChange,
  documents,
  defaultDocument,
  historicalOnly = false,
  selectedDocIds,
  onSelectedDocIdsChange,
  includeVocabularies,
  hasVocabularies,
  zipNote = null,
}) => {
  const radio = (value, label, extra = null) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name="export-scope"
        checked={scope === value}
        onChange={() => onScopeChange(value)}
      />
      <span>{label}</span>
      {extra}
    </label>
  );

  const toggleDoc = (id, on) => {
    const next = new Set(selectedDocIds);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedDocIdsChange(next);
  };

  // Anything but document scope produces a zip (see runExport.js), so the
  // vocabularies setting only shows where there is an archive to put them in.
  const zipExpected = scope !== 'document';

  if (historicalOnly) {
    return (
      <div className="flex flex-col gap-2">
        <Label>Scope</Label>
        {radio('document', `This document: ${defaultDocument?.name}`)}
        <p className="text-xs text-muted-foreground">
          You are viewing a historical state, so the export covers this document as of that moment.
          Project-wide export is available outside of history view.
        </p>
        {zipNote && <p className="text-xs text-muted-foreground">{zipNote}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Scope</Label>
        {defaultDocument && radio('document', `This document: ${defaultDocument.name}`)}
        {radio(
          'project',
          `Whole project (${documents?.length ?? 0} document${documents?.length === 1 ? '' : 's'})`,
        )}
        {radio('documents', 'Selected documents')}
      </div>

      {scope === 'documents' && (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
          {(documents || []).map((d) => (
            <label
              key={d.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={selectedDocIds.has(d.id)}
                onChange={(e) => toggleDoc(d.id, e.target.checked)}
              />
              <span className="flex-1 truncate">{d.name}</span>
            </label>
          ))}
          {!documents?.length && (
            <p className="px-1 py-2 text-sm text-muted-foreground">No documents found.</p>
          )}
        </div>
      )}

      {zipNote ? (
        <p className="border-t pt-3 text-xs text-muted-foreground">{zipNote}</p>
      ) : (
        zipExpected &&
        hasVocabularies &&
        !!includeVocabularies && (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            The .zip includes this project&rsquo;s vocabularies as TSV files.
          </p>
        )
      )}
    </div>
  );
};
