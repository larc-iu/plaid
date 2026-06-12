import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Step 3: what to export. Scope is a run-time choice, never part of the
// preset; includeVocabularies IS preset state (it shapes the archive).
// historicalOnly locks the scope to the current document: time-travel export
// fetches the document as-of, but the documents-list endpoint has no as-of.
export const ScopeStep = ({
  scope, onScopeChange, documents, defaultDocument, historicalOnly = false,
  selectedDocIds, onSelectedDocIdsChange,
  includeVocabularies, onIncludeVocabulariesChange, hasVocabularies,
}) => {
  const radio = (value, label, extra = null) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio" name="export-scope"
        checked={scope === value}
        onChange={() => onScopeChange(value)}
      />
      <span>{label}</span>
      {extra}
    </label>
  );

  const toggleDoc = (id, on) => {
    const next = new Set(selectedDocIds);
    if (on) next.add(id); else next.delete(id);
    onSelectedDocIdsChange(next);
  };

  // Anything but document scope produces a zip (see runExport.js), so the
  // vocabularies toggle matters whenever the scope is project/documents.
  const zipExpected = scope !== 'document';

  if (historicalOnly) {
    return (
      <div className="flex flex-col gap-2">
        <Label>Scope</Label>
        {radio('document', `This document — ${defaultDocument?.name}`)}
        <p className="text-xs text-muted-foreground">
          You are viewing a historical state, so the export covers this
          document as of that moment. Project-wide export is available outside
          of history view.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Scope</Label>
        {defaultDocument && radio('document', `This document — ${defaultDocument.name}`)}
        {radio('project', `Whole project (${documents?.length ?? 0} documents)`)}
        {radio('documents', 'Selected documents')}
      </div>

      {scope === 'documents' && (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
          {(documents || []).map((d) => (
            <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50">
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

      {zipExpected && hasVocabularies && (
        <label className="flex cursor-pointer items-center justify-between gap-2 border-t pt-3 text-sm">
          <span>Include vocabularies as TSV files</span>
          <Switch checked={!!includeVocabularies} onCheckedChange={onIncludeVocabulariesChange} />
        </label>
      )}
    </div>
  );
};
