import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { TagsetField } from '@/components/shared/TagsetField.jsx';
import { useMetadataOperations } from './useMetadataOperations.js';

// What this project records about a document, on the shared Details page
// (`@ui/components/shared/DocumentDetailsPage`, its `metadata` slot). Always
// editable, with its own Save, as every section of that page is. Nothing is
// drawn when the project declares no fields.
export function DocumentMetadata({ doc, readOnly }) {
  const ops = useMetadataOperations(doc);
  if (!ops.metadataFields.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Metadata</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ops.metadataFields.map((field) => (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label htmlFor={`document-field-${field.name}`}>{field.name}</Label>
            <TagsetField
              id={`document-field-${field.name}`}
              field={field}
              value={ops.values[field.name]}
              tagset={ops.tagsetFor(field)}
              onChange={(v) => ops.updateValue(field.name, v)}
              disabled={readOnly || ops.saving}
            />
          </div>
        ))}
        {!readOnly && (
          <Button
            className="self-start"
            onClick={ops.handleSave}
            disabled={!ops.dirty || ops.saving || !ops.metadataValid}
            title={ops.metadataValid ? undefined : 'A field holds a value its tagset refuses'}
          >
            {ops.saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
