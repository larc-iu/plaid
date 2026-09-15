import { AUTO, LTR, RTL } from '../../domain/textDirection.js';
import { Label } from '../ui/label.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select.jsx';

// Which way this document's data is laid out. One control, both apps, on the
// screen where a document's other facts live.
//
// It is out of the way on purpose. Direction is read from the document's own
// text (see domain/textDirection.js), so nearly nobody needs this: it is here
// for the corpus the text cannot speak for, a transliterated Arabic one whose
// forms are all Latin, or a language-of-wider-communication translation stored
// as the baseline.
//
// `doc` is a DocumentModel. The setting and the resolved value are both its
// own, so there is no state here and nothing for a caller to hold.
export function TextDirectionField({ doc, disabled = false, id = 'text-direction' }) {
  const setting = doc.textDirectionSetting;
  const resolved = doc.textDirection;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Text direction</Label>
      <Select
        value={setting}
        onValueChange={(v) => doc.setTextDirection(v)}
        disabled={disabled || doc.isSaving}
      >
        <SelectTrigger id={id} className="w-[220px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* What automatic came out as, because the whole reason to open this
              control is that you are not sure. */}
          <SelectItem value={AUTO}>
            Automatic ({resolved === RTL ? 'right to left' : 'left to right'})
          </SelectItem>
          <SelectItem value={LTR}>Left to right</SelectItem>
          <SelectItem value={RTL}>Right to left</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
