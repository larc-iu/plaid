import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { readLanguages, IGT_NAMESPACE } from '@/domain/igtConfig';

// Advisory only: a wrong-looking code still saves, since a project may be
// documenting something Glottolog has no entry for.
const GLOTTOCODE_RE = /^[a-z0-9]{4}[0-9]{4}$/;
const ISO_RE = /^[a-z]{3}$/;

const Field = ({ id, label, value, onChange, placeholder, hint, invalid }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
      {label}
    </Label>
    <Input
      id={id}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8"
      aria-invalid={invalid || undefined}
    />
    {invalid && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

const LanguageGroup = ({ prefix, title, description, lang, onChange, coordinates }) => {
  const set = (patch) => onChange({ ...lang, ...patch });
  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Field
        id={`${prefix}-name`}
        label="Name"
        value={lang.name}
        placeholder="e.g. Lezgian"
        onChange={(v) => set({ name: v })}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          id={`${prefix}-glottocode`}
          label="Glottocode"
          value={lang.glottocode}
          placeholder="lezg1247"
          hint="Glottocodes look like lezg1247 (four letters, four digits)."
          invalid={lang.glottocode !== '' && !GLOTTOCODE_RE.test(lang.glottocode)}
          onChange={(v) => set({ glottocode: v.trim() })}
        />
        <Field
          id={`${prefix}-iso`}
          label="ISO 639-3"
          value={lang.iso639P3}
          placeholder="lez"
          hint="ISO 639-3 codes are three letters."
          invalid={lang.iso639P3 !== '' && !ISO_RE.test(lang.iso639P3)}
          onChange={(v) => set({ iso639P3: v.trim() })}
        />
      </div>
      {coordinates && (
        <div className="grid grid-cols-2 gap-3">
          <Field
            id={`${prefix}-lat`}
            label="Latitude"
            value={lang.latitude ?? ''}
            placeholder="41.5"
            onChange={(v) => set({ latitude: v })}
          />
          <Field
            id={`${prefix}-lon`}
            label="Longitude"
            value={lang.longitude ?? ''}
            placeholder="48.0"
            onChange={(v) => set({ longitude: v })}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Settings → Languages. Which language this project documents, and which one
 * it glosses in. Plaid's layers are offset spaces with no language attached,
 * so this is the only place the fact is recorded, and exports that need it
 * (CLDF's LanguageTable, .flextext writing-system tags) read it from here.
 */
export const LanguagesSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const saved = useMemo(() => readLanguages(project?.config), [project?.config]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  // Re-sync when the project reloads, so the form shows what the server has.
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      if (!client) throw new Error('Not authenticated');
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'languages', draft);
      notifySuccess('Project languages have been updated.', 'Settings saved');
      onProjectUpdate?.();
    } catch (err) {
      console.error('Failed to save project languages:', err);
      notifyError('Saving the languages failed. Please try again.', 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tw">
      <h2 className="text-lg font-semibold">Languages</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Which language this project documents, and which one it is glossed in. Exports use this to
        identify the data: a CLDF dataset without a Glottocode cannot be linked to any other
        dataset.{' '}
        <a
          href="https://glottolog.org/glottolog"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          Look up a Glottocode <ExternalLink className="h-3 w-3" />
        </a>
      </p>

      <div className="flex max-w-3xl flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <LanguageGroup
            prefix="obj-lang"
            title="Object language"
            description="The language of the baseline text."
            lang={draft.object}
            coordinates
            onChange={(object) => setDraft((d) => ({ ...d, object }))}
          />
          <LanguageGroup
            prefix="meta-lang"
            title="Meta language"
            description="The language glosses and translations are written in."
            lang={draft.meta}
            onChange={(meta) => setDraft((d) => ({ ...d, meta }))}
          />
        </div>
        <Button className="self-start" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save languages'}
        </Button>
      </div>
    </div>
  );
};
