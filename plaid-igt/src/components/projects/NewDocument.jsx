import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AudioLines, ChevronRight, PenLine, Plus } from 'lucide-react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import { findBaselineTextLayer } from '@/domain/igtConfig';
import { nameTakenMessage } from '@ui/lib/documentNames.js';
import { createOnce } from '@ui/lib/createOnce.js';
import { isEnter } from '@ui/lib/chords.js';
import { t } from '@ui/lib/i18n.js';

// A name of only invisible characters is no name, as one of only spaces is
// not. The set is core's (plaid.sql.common/visible?): White_Space, Cc, Cf and
// the other default-ignorable code points, less the prepended concatenation
// marks, which are drawn. Core refuses such a name too.
const NO_NAME =
  /^[[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]--[\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u{110BD}\u{110CD}]]*$/v;
const named = (s) => !NO_NAME.test(s);

// The Documents tab's way to a new document, beside its heading, for a writer.
export const NewDocument = ({ projectId, client, canManage }) => {
  const [open, setOpen] = useState(false);
  // A maintainer picks how to add a document first, the way New Project does:
  // an import is a way of making one, not a separate button in the header. A
  // writer who cannot import goes straight to the name.
  const [choosing, setChoosing] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  // Core's refusal of a name another document holds, said under the field.
  const [nameTaken, setNameTaken] = useState(null);
  // The id the create names, kept across presses of Create (createOnce.js)
  // for one name in one opening of the dialog.
  const mint = useRef(null);
  useEffect(() => {
    if (!open) {
      mint.current = null;
      setNameTaken(null);
    }
  }, [open]);
  const navigate = useNavigate();

  const handleCreateDocument = async () => {
    if (!named(documentName)) {
      notifyError(t('Name the document.'), t('Failed to create the document'));
      return;
    }
    setIsCreating(true);
    const name = documentName.trim();
    try {
      if (!client) throw new Error(t('Authentication required'));
      const newDocument = await createOnce(mint, (id) =>
        client.documents.create(projectId, name, undefined, undefined, { id }),
      );
      // The document is made. Its empty text is made in a request of its
      // own, so a tab opened on it before its first write plans that write
      // on a text. A failure from here on opens it all the same, textless,
      // and its first write makes the text: a second press of Create would
      // make a second document.
      try {
        const projectData = await client.projects.get(projectId);
        const primaryTextLayer = findBaselineTextLayer(projectData?.textLayers);
        if (primaryTextLayer) {
          await client.texts.create(primaryTextLayer.id, newDocument.id, '', {});
        }
      } catch (error) {
        console.error('Failed to give the new document its text:', error);
      }
      notifySuccess(t('Document “{name}” created', { name }));
      setDocumentName('');
      setOpen(false);
      // A new document is empty, so the next thing to do is type its text.
      navigate(`/projects/${projectId}/documents/${newDocument.id}?tab=baseline`);
    } catch (error) {
      const taken = nameTakenMessage(error);
      if (taken) {
        setNameTaken(taken);
        return;
      }
      console.error('Failed to create document:', error);
      notifyError(error, t('Failed to create the document'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => {
          setChoosing(canManage);
          setOpen(true);
        }}
      >
        <Plus className="h-4 w-4" /> {t('New document')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-md"
          {...(choosing ? { 'aria-describedby': undefined } : {})}
        >
          <DialogHeader>
            <DialogTitle>{t('New document')}</DialogTitle>
            {!choosing && (
              <DialogDescription>
                {t('Name the document. Its text goes on the Baseline tab.')}
              </DialogDescription>
            )}
          </DialogHeader>
          {choosing ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setChoosing(false)}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <PenLine className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">{t('Blank document')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('Name it now and add its text on the Baseline tab.')}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              <Link
                to={`/projects/${projectId}/import-elan`}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <AudioLines className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">
                    {t('Import from ELAN or Praat')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(
                      'One document per .eaf or .TextGrid file, with its tiers, speakers and time alignment.',
                    )}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="doc-name">{t('Document name')}</Label>
                <Input
                  id="doc-name"
                  placeholder={t('Enter document name')}
                  value={documentName}
                  onChange={(e) => {
                    mint.current = null;
                    setNameTaken(null);
                    setDocumentName(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (isEnter(e) && named(documentName) && !isCreating) handleCreateDocument();
                  }}
                  aria-invalid={nameTaken ? true : undefined}
                  aria-describedby={nameTaken ? 'doc-name-taken' : undefined}
                  autoFocus
                />
                {nameTaken && (
                  <p id="doc-name-taken" role="alert" className="text-sm text-destructive">
                    {nameTaken}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
                  {t('Cancel')}
                </Button>
                <Button
                  onClick={handleCreateDocument}
                  disabled={!named(documentName) || isCreating}
                >
                  {isCreating ? t('Creating…') : t('Create')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
