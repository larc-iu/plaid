import { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import { morphTypeLabel, morphTypeOptions } from '@/domain/affixMarkers';
import { fieldLabel, FIELD_TYPES } from '@/domain/vocabFields';
import { TagsetField } from '@/components/shared/TagsetField.jsx';
import { ItemRefField, EntryPlace, HomographNumber } from './DictionaryPanels';
import { FormLabel } from './FormLabel';

// A titled band of the entry form. The grid is three across when the pane is
// wide, so a lexicon's dozen fields fit on one screen. Module-level, so a
// keystroke in a field does not remount the band it sits in.
const FormGroup = ({ title, children }) => (
  <div className="flex flex-col gap-2">
    {title && (
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
    )}
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  </div>
);

// The entry card: the form and its bands, its place among the entries, and
// the save, cancel, and delete controls. `draft` and `dispatch` are the
// screen's reducer; the writes are the callbacks.
export const EntryEditor = ({
  fields,
  items,
  numbers,
  tree,
  selectedId,
  selectedItem,
  isNew,
  liveNewParent,
  draft,
  dispatch,
  dirty,
  saveAllowed,
  canManage,
  tagsetFor,
  statusKey,
  formGroups,
  homographs,
  usageCounts,
  usageKinds,
  itemTo,
  newSenseTo,
  onSave,
  onCancel,
  onDelete,
  onMoveUnder,
  onRaiseHeadword,
  onSenseDrop,
  onOpenHomographs,
}) => {
  // Prefix for the input ids, so every label addresses its own field
  // (clicking the label focuses it) even with another copy on the page.
  const uid = useId();
  const setFields = (fieldsNext) => dispatch({ type: 'draft/fields', fields: fieldsNext });

  // One field input for the entry form. morphType is a controlled vocab, a
  // reference field a picker, a tagset field its own control, the rest text.
  const renderField = (field, values, onChange, disabled) => {
    // Index, not the field name: a name is free text and may not be a legal
    // id fragment.
    const fieldId = `${uid}-field-${fields.indexOf(field)}`;
    const label = fieldLabel(field);
    return (
      <div key={field.name} className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
        {field.type === FIELD_TYPES.ITEM ? (
          <ItemRefField
            id={fieldId}
            field={field}
            values={values}
            onChange={onChange}
            items={items}
            numbers={numbers}
            itemTo={itemTo}
            selfId={isNew ? null : selectedId}
            disabled={disabled}
          />
        ) : field.name === 'morphType' ? (
          <select
            id={fieldId}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            value={values.morphType || ''}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, morphType: event.target.value || undefined })
            }
          >
            <option value="">—</option>
            {morphTypeOptions(values.morphType).map((t) => (
              <option key={t} value={t}>
                {morphTypeLabel(t)}
              </option>
            ))}
          </select>
        ) : tagsetFor(field.name) ? (
          <TagsetField
            id={fieldId}
            field={field}
            value={values[field.name] || ''}
            tagset={tagsetFor(field.name)}
            placeholder={label}
            className="h-8"
            spellCheck={false}
            disabled={disabled}
            onChange={(v) => onChange({ ...values, [field.name]: v })}
          />
        ) : (
          <Input
            compose
            id={fieldId}
            className="h-8"
            placeholder={label}
            spellCheck={false}
            value={values[field.name] || ''}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
          />
        )}
      </div>
    );
  };

  const uses = usageCounts?.[selectedItem?.id] ?? 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">
          {isNew ? (
            'New entry'
          ) : homographs.length > 1 && !tree.parentOf.get(selectedId) ? (
            <>
              {selectedItem?.form ?? ''}
              <HomographNumber
                number={numbers.get(selectedItem?.id)}
                onOpen={onOpenHomographs}
                className="ml-1 text-[0.85em] font-normal"
              />
            </>
          ) : (
            <FormLabel form={selectedItem?.form ?? ''} index={numbers.get(selectedItem?.id)} />
          )}
        </h3>
        {formGroups.status && (
          <div className="ml-auto mr-3 flex items-center gap-2">
            <Label htmlFor={`${uid}-status`} className="text-xs font-medium text-muted-foreground">
              Status
            </Label>
            <TagsetField
              id={`${uid}-status`}
              field={formGroups.status}
              value={draft.fields[statusKey] || ''}
              tagset={tagsetFor(statusKey)}
              className="h-7 w-32 text-xs"
              disabled={!canManage}
              onChange={(v) => setFields({ ...draft.fields, [statusKey]: v })}
            />
          </div>
        )}
        {!isNew && selectedItem && (
          <div className="text-right text-xs text-muted-foreground">
            <span>
              {uses.toLocaleString()} use{uses === 1 ? '' : 's'}
            </span>
            {usageKinds?.[selectedItem.id] && (
              <span className="ml-1.5" title="Linked from this many words and morphemes">
                ·{' '}
                {['word', 'morpheme']
                  .filter((k) => usageKinds[selectedItem.id][k])
                  .map((k) => {
                    const n = usageKinds[selectedItem.id][k];
                    return `${n.toLocaleString()} ${k}${n === 1 ? '' : 's'}`;
                  })
                  .join(', ')}
              </span>
            )}
          </div>
        )}
      </div>

      {!isNew && selectedItem && (
        <div className="mb-3">
          <EntryPlace
            item={selectedItem}
            tree={tree}
            items={items}
            numbers={numbers}
            itemTo={itemTo}
            canManage={canManage}
            onMoveUnder={onMoveUnder}
            onRaiseHeadword={onRaiseHeadword}
            onDrop={onSenseDrop}
            onReorderHomographs={homographs.length > 1 ? onOpenHomographs : null}
            newSenseTo={newSenseTo}
          />
        </div>
      )}
      {isNew && liveNewParent && (
        <p className="mb-3 text-xs text-muted-foreground">
          A new sense of <strong>{tree.byId.get(liveNewParent).form}</strong>
        </p>
      )}

      <div className="flex flex-col gap-4 [&>*+*]:border-t [&>*+*]:pt-3">
        <FormGroup>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${uid}-form`} className="text-xs font-medium text-muted-foreground">
              Form <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${uid}-form`}
              compose
              className="h-8"
              value={draft.form}
              autoFocus={isNew}
              placeholder="Form"
              spellCheck={false}
              disabled={!canManage}
              onChange={(e) => dispatch({ type: 'draft/form', form: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (dirty) onSave();
                }
              }}
            />
          </div>
          {formGroups.builtIn.map((f) => renderField(f, draft.fields, setFields, !canManage))}
        </FormGroup>
        {formGroups.custom.length > 0 && (
          <FormGroup title="Fields">
            {formGroups.custom.map((f) => renderField(f, draft.fields, setFields, !canManage))}
          </FormGroup>
        )}
        {formGroups.refs.length > 0 && (
          <FormGroup title="References">
            {formGroups.refs.map((f) => renderField(f, draft.fields, setFields, !canManage))}
          </FormGroup>
        )}
      </div>
      {canManage && (
        <div className="mt-4 flex items-center justify-between">
          <div>
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={!dirty}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={!dirty || !draft.form.trim() || !saveAllowed}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
