import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { MetadataFields } from '../common/MetadataFields.jsx';
import { metadataRows } from '../../utils/udMetadata.js';
import { readMetadataFields } from '../../domain/udConfig.js';

// What this project records about a document, on the document's Details tab.
// Nothing is drawn when the project declares no fields and the document carries
// none: an empty card would be a heading over nothing.
export const DocumentMetadataCard = ({ doc, project, readOnly }) => {
  // The project's declared fields, plus anything already stored that it no
  // longer declares (an import's field, or one somebody removed).
  const values = doc.metadata;
  const rows = metadataRows(readMetadataFields(project?.config, 'document'), values, 'document');
  if (!rows.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Fields are set under Settings → UD settings.
        </p>
        <MetadataFields
          rows={rows}
          values={values}
          readOnly={readOnly}
          onCommit={(key, value) => doc.setDocumentMetadata(key, value)}
        />
      </CardContent>
    </Card>
  );
};
