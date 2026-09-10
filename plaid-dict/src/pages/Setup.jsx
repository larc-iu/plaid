import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCatalog } from '@/contexts/CatalogContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { canManage, takenSlugs } from '@/domain/dictionaries';
import {
  dictCollator,
  EMPTY_LANGUAGE,
  readDictRecord,
  saveDictRecord,
  slugify,
  validateSetup,
} from '@/domain/dictConfig';
import { publicationCounts, publishAll, statusKeyOfConfig } from '@/domain/publication';
import { discoverExampleLayers } from '@/domain/exampleLayers';
import {
  formatAlphabet,
  outsideAlphabet,
  parseAlphabet,
  suggestAlphabet,
} from '@/domain/collation';
import { parentOf } from '@igt/domain/vocabDictionary.js';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import { notifyError, notifySuccess } from '@/utils/feedback';

// Advisory only: a wrong-looking code still saves, since a dictionary may
// document something Glottolog has no entry for.
const GLOTTOCODE_RE = /^[a-z0-9]{4}[0-9]{4}$/;
const ISO_RE = /^[a-z]{3}$/;

const emptyDraft = () => ({
  title: '',
  slug: '',
  languages: { object: { ...EMPTY_LANGUAGE }, meta: { ...EMPTY_LANGUAGE } },
  credits: '',
  citation: '',
  about: '',
  exampleLayers: null,
  alphabet: [],
});

const Field = ({ id, label, hint, error, children }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
      {label}
    </Label>
    {children}
    {error ? (
      <p className="text-xs text-destructive">{error}</p>
    ) : (
      hint && <p className="text-xs text-muted-foreground">{hint}</p>
    )}
  </div>
);

const LanguageGroup = ({ prefix, title, description, lang, onChange, coordinates, examples }) => {
  const set = (patch) => onChange({ ...lang, ...patch });
  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Field id={`${prefix}-name`} label="Name">
        <Input
          id={`${prefix}-name`}
          className="h-8"
          value={lang.name}
          placeholder={examples.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          id={`${prefix}-glottocode`}
          label="Glottocode"
          hint={
            lang.glottocode && !GLOTTOCODE_RE.test(lang.glottocode)
              ? 'Four letters, four digits.'
              : null
          }
        >
          <Input
            id={`${prefix}-glottocode`}
            className="h-8"
            value={lang.glottocode}
            placeholder={examples.glottocode}
            onChange={(e) => set({ glottocode: e.target.value.trim() })}
          />
        </Field>
        <Field
          id={`${prefix}-iso`}
          label="ISO 639-3"
          hint={lang.iso639P3 && !ISO_RE.test(lang.iso639P3) ? 'Three letters.' : null}
        >
          <Input
            id={`${prefix}-iso`}
            className="h-8"
            value={lang.iso639P3}
            placeholder={examples.iso}
            onChange={(e) => set({ iso639P3: e.target.value.trim() })}
          />
        </Field>
      </div>
      {coordinates && (
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${prefix}-lat`} label="Latitude">
            <Input
              id={`${prefix}-lat`}
              className="h-8"
              value={lang.latitude ?? ''}
              placeholder="-17.8"
              onChange={(e) => set({ latitude: e.target.value })}
            />
          </Field>
          <Field id={`${prefix}-lon`} label="Longitude">
            <Input
              id={`${prefix}-lon`}
              className="h-8"
              value={lang.longitude ?? ''}
              placeholder="35.0"
              onChange={(e) => set({ longitude: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
};

export const Setup = () => {
  const { vocabularyId } = useParams();
  const navigate = useNavigate();
  const { client, user } = useAuth();
  const { vocabularies, loading: catalogLoading, reload } = useCatalog();

  const vocab = useMemo(
    () => vocabularies.find((v) => v.id === vocabularyId) || null,
    [vocabularies, vocabularyId],
  );
  const saved = useMemo(() => readDictRecord(vocab?.config), [vocab?.config]);
  const taken = useMemo(() => takenSlugs(vocabularies, vocabularyId), [vocabularies, vocabularyId]);

  useDocumentTitle(vocab?.name, 'Setup');

  const [draft, setDraft] = useState(emptyDraft);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState(null);
  const [publishing, setPublishing] = useState(null); // {done, total} while running
  // The sentence layers this vocabulary's examples could show. Null while the
  // lookup is out; empty when no example points into a document.
  const [layerChoices, setLayerChoices] = useState(null);
  // The alphabet is edited as text so a trailing space survives typing; the
  // draft holds the parsed units.
  const [alphabetText, setAlphabetText] = useState('');

  // Seed once from what the server has, or from the vocabulary's name for a
  // dictionary being set up for the first time.
  useEffect(() => {
    if (seeded || !vocab) return;
    const seed = saved ?? { ...emptyDraft(), title: vocab.name, slug: slugify(vocab.name) };
    setDraft(seed);
    setAlphabetText(formatAlphabet(seed.alphabet));
    setSeeded(true);
  }, [vocab, saved, seeded]);

  useEffect(() => {
    if (!client || !vocabularyId) return undefined;
    let alive = true;
    (async () => {
      try {
        const { items: fetched = [] } = await client.vocabLayers.get(vocabularyId, true);
        if (alive) setItems(fetched);
      } catch (err) {
        console.error('Failed to load entries:', err);
        if (alive) setItems([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, vocabularyId]);

  // Discovered from the examples themselves, so only layers this dictionary
  // could actually show are offered.
  useEffect(() => {
    if (!client || !items) return undefined;
    let alive = true;
    discoverExampleLayers(client, items).then((names) => {
      if (alive) setLayerChoices(names);
    });
    return () => {
      alive = false;
    };
  }, [client, items]);

  // Only a headword gets a place in the index, so only headwords are measured
  // against the alphabet.
  const headwordForms = useMemo(
    () => (items || []).filter((it) => !parentOf(it)).map((it) => it.form ?? ''),
    [items],
  );
  const stray = useMemo(
    () => outsideAlphabet(headwordForms, draft.alphabet),
    [headwordForms, draft.alphabet],
  );

  const counts = useMemo(
    () => (items ? publicationCounts(items, statusKeyOfConfig(vocab?.config)) : null),
    [items, vocab],
  );
  const errors = useMemo(() => validateSetup(draft, taken), [draft, taken]);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  if (catalogLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  if (!vocab || !canManage(vocab, user)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm">This vocabulary cannot be set up as a dictionary.</p>
        <Button asChild variant="link" className="px-0">
          <Link to="/">Back to dictionaries</Link>
        </Button>
      </div>
    );
  }

  const save = async () => {
    if (Object.keys(errors).length || saving) return;
    setSaving(true);
    try {
      const record = await saveDictRecord(client, vocabularyId, draft, {
        label: saved ? `Update dictionary "${draft.title}"` : `Set up dictionary "${draft.title}"`,
      });
      await reload();
      notifySuccess(saved ? 'Saved.' : 'Dictionary set up.');
      navigate(`/${record.slug}`);
    } catch (err) {
      console.error('Failed to save the dictionary record:', err);
      notifyError(err?.message || 'Saving failed.');
    } finally {
      setSaving(false);
    }
  };

  const runPublishAll = async () => {
    if (!items || publishing) return;
    setPublishing({ done: 0, total: counts.total - counts.published });
    try {
      const n = await publishAll(client, items, {
        vocabularyId,
        name: draft.title || vocab.name,
        onProgress: setPublishing,
      });
      const { items: refreshed = [] } = await client.vocabLayers.get(vocabularyId, true);
      setItems(refreshed);
      notifySuccess(`${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'} published.`);
    } catch (err) {
      console.error('Publishing every entry failed:', err);
      notifyError(err?.message || 'Publishing failed.');
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Dictionaries
        </Link>
      </Button>

      <h1 className="font-serif text-2xl font-semibold">{vocab.name}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        Only published entries appear in the dictionary.
      </p>

      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <Field id="title" label="Title" error={errors.title}>
            <Input
              id="title"
              value={draft.title}
              placeholder="Sena Dictionary"
              onChange={(e) => set({ title: e.target.value })}
            />
          </Field>
          <Field
            id="slug"
            label="Address"
            error={errors.slug}
            hint={draft.slug ? `/dict/#/${draft.slug}` : null}
          >
            <Input
              id="slug"
              value={draft.slug}
              placeholder="sena"
              onChange={(e) => set({ slug: e.target.value.trim().toLowerCase() })}
            />
          </Field>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <LanguageGroup
            prefix="obj-lang"
            title="Object language"
            description="The language of the headwords."
            lang={draft.languages.object}
            examples={{ name: 'e.g. Sena', glottocode: 'sena1266', iso: 'seh' }}
            coordinates
            onChange={(object) => set({ languages: { ...draft.languages, object } })}
          />
          <LanguageGroup
            prefix="meta-lang"
            title="Meta language"
            description="The language of the definitions."
            lang={draft.languages.meta}
            examples={{ name: 'e.g. Portuguese', glottocode: 'port1283', iso: 'por' }}
            onChange={(meta) => set({ languages: { ...draft.languages, meta } })}
          />
        </section>

        <section className="flex flex-col gap-3">
          <Field id="credits" label="Credits">
            <Textarea
              id="credits"
              rows={2}
              value={draft.credits}
              placeholder="Compiled by …"
              onChange={(e) => set({ credits: e.target.value })}
            />
          </Field>
          <Field id="citation" label="Citation">
            <Textarea
              id="citation"
              rows={2}
              value={draft.citation}
              placeholder="Cite as …"
              onChange={(e) => set({ citation: e.target.value })}
            />
          </Field>
          <Field id="about" label="About" hint="Shown on the front page.">
            <Textarea
              id="about"
              rows={6}
              value={draft.about}
              onChange={(e) => set({ about: e.target.value })}
            />
          </Field>
        </section>

        <section className="rounded-md border p-4">
          <p className="text-sm font-medium">Alphabet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Letters in order, separated by spaces. A letter may be more than one character.
          </p>
          <Input
            id="alphabet"
            className="mt-3 font-serif"
            value={alphabetText}
            placeholder="a b bv c ch d e …"
            spellCheck={false}
            onChange={(e) => {
              setAlphabetText(e.target.value);
              set({ alphabet: parseAlphabet(e.target.value) });
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!headwordForms.length}
              onClick={() => {
                const units = suggestAlphabet(
                  headwordForms,
                  dictCollator({ ...draft, alphabet: [] }),
                );
                setAlphabetText(formatAlphabet(units));
                set({ alphabet: units });
              }}
            >
              Fill from entries
            </Button>
            {draft.alphabet.length > 0 && stray.length > 0 && (
              <span className="text-sm text-muted-foreground">
                {stray.length.toLocaleString()}{' '}
                {stray.length === 1 ? 'headword starts' : 'headwords start'} outside it.
              </span>
            )}
          </div>
        </section>

        {layerChoices?.length > 0 && (
          <section className="rounded-md border p-4">
            <p className="text-sm font-medium">Example sentences</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Shown under an example, in this order.
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {layerChoices.map((name) => {
                const chosen = draft.exampleLayers === null || draft.exampleLayers.includes(name);
                return (
                  <li key={name}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-primary"
                        checked={chosen}
                        onChange={(e) =>
                          set({
                            exampleLayers: e.target.checked
                              ? layerChoices.filter(
                                  (n) =>
                                    n === name ||
                                    draft.exampleLayers === null ||
                                    draft.exampleLayers.includes(n),
                                )
                              : layerChoices.filter(
                                  (n) =>
                                    n !== name &&
                                    (draft.exampleLayers === null ||
                                      draft.exampleLayers.includes(n)),
                                ),
                          })
                        }
                      />
                      {name}
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="rounded-md border p-4">
          <p className="text-sm font-medium">Published entries</p>
          {counts === null ? (
            <p className="mt-1 text-sm text-muted-foreground">…</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {counts.published.toLocaleString()} of {counts.total.toLocaleString()}.
              </p>
              {counts.published < counts.total && (
                <Button
                  className="mt-3"
                  variant="secondary"
                  size="sm"
                  disabled={!!publishing}
                  onClick={runPublishAll}
                >
                  {publishing
                    ? `Publishing ${publishing.done.toLocaleString()} of ${publishing.total.toLocaleString()}…`
                    : 'Publish all'}
                </Button>
              )}
            </>
          )}
        </section>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || Object.keys(errors).length > 0}>
            {saving ? 'Saving…' : saved ? 'Save' : 'Set up'}
          </Button>
          {saved && (
            <Button asChild variant="link" className="px-0">
              <Link to={`/${saved.slug}`}>
                Open <ExternalLink className="ml-1 h-3 w-3" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
