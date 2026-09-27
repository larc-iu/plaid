import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo, readProjectLanguage } from '../../utils/udLayerUtils.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { ProjectGeneralPage } from '@ui/components/shared/ProjectGeneralPage.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// "General": the shared page (name, language, delete) with UD's one section of
// its own, the tokenizer locale the segmenter uses.
//
// `onProjectUpdate` refreshes the parent's copy of the project. The name shows
// in the breadcrumb above this screen and in the project list, so a rename that
// only refreshed this tab would leave both stale until a reload.
export const ProjectGeneral = ({ onProjectUpdate }) => {
  const { project, loading, fetchProject, canConfigure } = useManagedProject();
  const { getClient } = useAuth();

  // Only the first load shows the line: a refetch after a save keeps the page
  // up, so a field being typed in is not taken away under the reader.
  if (!project) return loading ? <Loading /> : null;
  if (!canConfigure) return null;

  const refresh = async () => {
    await fetchProject();
    onProjectUpdate?.();
  };

  // The tag is on the PROJECT, in this app's half of its config.
  const saveLanguage = async (tag) => {
    const client = getClient();
    if (tag) await client.projects.setConfig(project.id, UD_NAMESPACE, 'language', tag);
    else await client.projects.deleteConfig(project.id, UD_NAMESPACE, 'language');
  };

  return (
    <ProjectGeneralPage
      project={project}
      onSaved={refresh}
      language={{
        saved: readProjectLanguage(project),
        save: saveLanguage,
        description: (
          <>
            The language this project annotates, as a BCP-47 tag (<code>en</code>, <code>de</code>,{' '}
            <code>zh-Hans</code>). The parser starts on it, and tokenization uses it unless the
            locale below is set.
          </>
        ),
      }}
    >
      <TokenizerLocaleCard project={project} onSaved={fetchProject} />
    </ProjectGeneralPage>
  );
};

// The locale lives on the text layer's UD config, since it is the segmenter's
// setting and not a fact about the project.
const TokenizerLocaleCard = ({ project, onSaved }) => {
  const { getClient } = useAuth();
  const info = getUdLayerInfo(project);
  const saved = info.textLayer?.config?.[UD_NAMESPACE]?.tokenizerLocale || '';
  const language = project.config?.[UD_NAMESPACE]?.language || '';

  const [locale, setLocale] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setLocale(saved), [saved]);

  const changed = locale.trim() !== saved;

  const handleSave = async (event) => {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      if (!info.textLayer) throw new Error(NOT_SET_UP);
      const loc = locale.trim();
      if (loc)
        await client.textLayers.setConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale', loc);
      else await client.textLayers.deleteConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale');
      await onSaved();
      notifySuccess('Tokenizer locale saved');
    } catch (err) {
      console.error('Failed to save tokenizer locale:', err);
      notifyError(err, 'Failed to save the tokenizer locale');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Tokenizer locale</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Language tag for splitting text into tokens. It matters most for <code>ja</code>,{' '}
          <code>zh</code> and <code>th</code>, which are split by dictionary lookup. Leave empty to
          use the project language.
        </p>
        {info.textLayer ? (
          <form className="flex items-end gap-2" onSubmit={handleSave}>
            <Input
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              placeholder={language.trim() || 'und'}
              className="w-56"
              spellCheck={false}
              aria-label="Tokenizer locale"
              dir="ltr"
            />
            <Button type="submit" disabled={!changed || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </form>
        ) : (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Set the project up for UD first.
          </p>
        )}
      </CardContent>
    </Card>
  );
};
