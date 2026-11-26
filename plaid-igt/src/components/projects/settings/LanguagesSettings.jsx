import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { notifyError } from '@/utils/feedback';
import {
  CHANGED_ELSEWHERE,
  expectStored,
  isConfigConflict,
  sameConfig,
} from '@ui/domain/configCells.js';
import { readLanguages, IGT_NAMESPACE } from '@/domain/igtConfig';
import { isLangTag } from '@/domain/fieldNames';
import { TYPE } from '@ui/lib/typeScale.js';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { t } from '@ui/lib/i18n.js';

// Advisory only: a wrong-looking code still saves, since a project may be
// documenting something Glottolog has no entry for.
const GLOTTOCODE_RE = /^[a-z0-9]{4}[0-9]{4}$/;
const ISO_RE = /^[a-z]{3}$/;

// A coordinate is empty, or a number from -limit to limit. As typed it is
// text, stored it is a number.
const coordinateOk = (v, limit) => {
  if (v === null || v === undefined || String(v).trim() === '') return true;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit;
};
const coordinate = (v) =>
  v === null || v === undefined || String(v).trim() === '' ? null : Number(v);
const LIMITS = { latitude: 90, longitude: 180 };
const coordinatesOk = (lang) =>
  Object.entries(LIMITS).every(([k, limit]) => coordinateOk(lang[k], limit));
// The draft as it is stored: coordinates in range as numbers, any other text
// left as typed, so it never reads as saved.
const asStored = (draft) => {
  const one = (lang) => ({
    ...lang,
    ...Object.fromEntries(
      Object.entries(LIMITS).map(([k, limit]) => [
        k,
        coordinateOk(lang[k], limit) ? coordinate(lang[k]) : lang[k],
      ]),
    ),
  });
  return { object: one(draft.object), meta: one(draft.meta) };
};

// The form read again (`now`) with this page's own edits on it. A field the
// page did not change shows what is stored now. A field it changed keeps what
// was typed, and `elsewhere` holds what is stored now when someone else
// changed it too. `before` is what the edits were made on.
const rebase = (draft, before, now) => {
  const mine = asStored(draft);
  const next = {
    object: { ...now.object },
    meta: { ...now.meta },
    elsewhere: { object: {}, meta: {} },
  };
  for (const g of ['object', 'meta']) {
    for (const k of Object.keys(now[g])) {
      if (sameConfig(mine[g][k], before[g][k])) continue;
      next[g][k] = draft[g][k];
      if (sameConfig(now[g][k], mine[g][k])) continue;
      if (!sameConfig(now[g][k], before[g][k])) next.elsewhere[g][k] = now[g][k];
      // A field not changed again since the last read keeps its mark.
      else if (Object.hasOwn(draft.elsewhere?.[g] ?? {}, k)) {
        next.elsewhere[g][k] = draft.elsewhere[g][k];
      }
    }
  }
  return next;
};

const Field = ({ id, label, value, onChange, placeholder, hint, invalid, elsewhere }) => (
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
    {elsewhere !== undefined && (
      <p className="text-xs text-muted-foreground">
        {elsewhere === null || elsewhere === ''
          ? t('Cleared elsewhere.')
          : t('Changed elsewhere to {value}.', { value: String(elsewhere) })}
      </p>
    )}
  </div>
);

const LanguageGroup = ({ prefix, title, description, lang, onChange, coordinates, elsewhere }) => {
  const set = (patch) => onChange({ ...lang, ...patch });
  const theirs = (k) => (Object.hasOwn(elsewhere, k) ? elsewhere[k] : undefined);
  return (
    <div
      role="group"
      aria-labelledby={`${prefix}-title`}
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <div>
        <p id={`${prefix}-title`} className="text-sm font-medium">
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Field
        id={`${prefix}-name`}
        elsewhere={theirs('name')}
        label={t('Name')}
        value={lang.name}
        placeholder={t('e.g. Lezgian')}
        onChange={(v) => set({ name: v })}
      />
      <div className="grid grid-cols-3 gap-3">
        <Field
          id={`${prefix}-tag`}
          elsewhere={theirs('tag')}
          label={t('Writing system tag')}
          value={lang.tag}
          placeholder={t('e.g. {address}', { address: 'lez' })}
          hint={t('A tag is letters and hyphens, like lez or qaa-x-lezgi.')}
          invalid={lang.tag !== '' && !isLangTag(lang.tag)}
          onChange={(v) => set({ tag: v.trim() })}
        />
        <Field
          id={`${prefix}-glottocode`}
          elsewhere={theirs('glottocode')}
          label="Glottocode" // i18n-ignore: a proper name
          value={lang.glottocode}
          placeholder={t('e.g. {address}', { address: 'lezg1247' })}
          hint={t('Glottocodes look like lezg1247 (four letters, four digits).')}
          invalid={lang.glottocode !== '' && !GLOTTOCODE_RE.test(lang.glottocode)}
          onChange={(v) => set({ glottocode: v.trim() })}
        />
        <Field
          id={`${prefix}-iso`}
          elsewhere={theirs('iso639P3')}
          label="ISO 639-3" // i18n-ignore: a standard's name
          value={lang.iso639P3}
          placeholder={t('e.g. {address}', { address: 'lez' })}
          hint={t('ISO 639-3 codes are three letters.')}
          invalid={lang.iso639P3 !== '' && !ISO_RE.test(lang.iso639P3)}
          onChange={(v) => set({ iso639P3: v.trim() })}
        />
      </div>
      {coordinates && (
        <div className="grid grid-cols-2 gap-3">
          <Field
            id={`${prefix}-lat`}
            elsewhere={theirs('latitude')}
            label={t('Latitude')}
            value={lang.latitude ?? ''}
            placeholder={t('e.g. {address}', { address: '41.5' })}
            hint={t('Latitude is a number from -90 to 90.')}
            invalid={!coordinateOk(lang.latitude, LIMITS.latitude)}
            onChange={(v) => set({ latitude: v })}
          />
          <Field
            id={`${prefix}-lon`}
            elsewhere={theirs('longitude')}
            label={t('Longitude')}
            value={lang.longitude ?? ''}
            placeholder={t('e.g. {address}', { address: '48.0' })}
            hint={t('Longitude is a number from -180 to 180.')}
            invalid={!coordinateOk(lang.longitude, LIMITS.longitude)}
            onChange={(v) => set({ longitude: v })}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Settings → General → Languages. Which language this project documents, and which one
 * it glosses in. Plaid's layers are offset spaces with no language attached,
 * so this is the only place the fact is recorded, and exports that need it
 * (CLDF's LanguageTable, .flextext writing-system tags) read it from here.
 */
export const LanguagesSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const saved = useMemo(() => readLanguages(project?.config), [project?.config]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  // Re-sync when the project reloads, so the form shows what the server has.
  // Edits not saved yet stay, on what is stored now.
  const prevSaved = useRef(saved);
  useEffect(() => {
    const before = prevSaved.current;
    prevSaved.current = saved;
    setDraft((d) => (sameConfig(asStored(d), before) ? saved : rebase(d, before, saved)));
  }, [saved]);

  const stored = asStored(draft);
  const dirty = JSON.stringify(stored) !== JSON.stringify(saved);
  const valid = coordinatesOk(draft.object) && coordinatesOk(draft.meta);
  // Leaving the section, or the page, with an edit not saved asks first.
  useUnsavedDraft(dirty ? t('What you have typed here') : null);

  const save = async () => {
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      if (!client) throw new Error('Not authenticated'); // i18n-ignore: an invariant, nobody signed out reaches this page
      await client.projects.setConfig(
        projectId,
        IGT_NAMESPACE,
        'languages',
        stored,
        undefined,
        expectStored(project, IGT_NAMESPACE, 'languages'),
      );
      // What the edits made after this save are made on. Its marks are
      // answered by it.
      prevSaved.current = stored;
      setDraft(({ elsewhere: _answered, ...d }) => d);
      // Save stays held until the project is read again, so a next save
      // expects what this one stored. The save has landed by now, so a read
      // that fails is not a failed save.
      await Promise.resolve(onProjectUpdate?.()).catch((err) =>
        console.error('Failed to reload the project:', err),
      );
    } catch (err) {
      console.error('Failed to save project languages:', err);
      // Someone else saved since: show what is stored now, the edits on it.
      notifyError(
        isConfigConflict(err) ? t(CHANGED_ELSEWHERE) : err,
        t('Failed to save the languages'),
      );
      if (isConfigConflict(err)) onProjectUpdate?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className={TYPE.card}>{t('Languages')}</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        {t(
          'Which language this project documents, and which one it is glossed in. Exports use this to identify the data: a CLDF dataset without a Glottocode cannot be linked to any other dataset, and a FLEx or ELAN file labels its text with the writing system tag.',
        )}{' '}
        <a
          href="https://glottolog.org/glottolog"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          {t('Look up a Glottocode')} <ExternalLink className="h-3 w-3" />
        </a>
      </p>

      <div className="flex max-w-3xl flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <LanguageGroup
            prefix="obj-lang"
            title={t('Object language')}
            description={t('The language of the baseline text.')}
            lang={draft.object}
            elsewhere={draft.elsewhere?.object ?? {}}
            coordinates
            onChange={(object) => setDraft((d) => ({ ...d, object }))}
          />
          <LanguageGroup
            prefix="meta-lang"
            title={t('Meta language')}
            description={t('The language glosses and translations are written in.')}
            lang={draft.meta}
            elsewhere={draft.elsewhere?.meta ?? {}}
            onChange={(meta) => setDraft((d) => ({ ...d, meta }))}
          />
        </div>
        <Button className="self-start" onClick={save} disabled={!dirty || !valid || saving}>
          {saving ? t('Saving…') : t('Save')}
        </Button>
      </div>
    </div>
  );
};
