import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/useAuth.js';
import { humanizeError } from '../../lib/errors.js';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { DeleteProjectCard } from './DeleteProjectCard.jsx';

/**
 * A project's General settings, the same page in every app: its name, the
 * language it annotates when the app keeps one, the app's own sections, and
 * the delete card at the foot. Every Save is the default button, disabled
 * until its own section differs from what is stored.
 *
 * Props:
 * - `project`: the loaded project. The caller guards loading and permission.
 * - `onSaved()`: refreshes the caller's copy after any save here. The name
 *   shows in the breadcrumb and the project list, so a rename has to reach
 *   the screens above this one.
 * - `language`: when given, a Language card for one BCP-47 tag on the
 *   project. `saved` is the stored tag ('' for none), and `save(tag)` writes
 *   one, '' meaning remove it: the app keeps the tag in its own half of the
 *   project's config, so the app writes it. `description` is the line under the
 *   heading, and `note(savedTag)` an optional line under the field about what
 *   the SAVED tag does.
 * - `children`: the app's own sections, drawn between Language and Delete.
 * - `research`: when true, a Research card with the project's telemetry
 *   switch (`config.plaid.research.telemetry`, the core manual's "Research
 *   telemetry"), drawn after the app's sections. Only the apps that record
 *   events pass it.
 */
export const ProjectGeneralPage = ({
  project,
  onSaved,
  language = null,
  research = false,
  children,
}) => {
  const { getClient } = useAuth();

  const [name, setName] = useState(project.name ?? '');
  const [savingName, setSavingName] = useState(false);
  // Follow the stored name whenever it changes (our own rename included), so
  // the field shows what the server has rather than a stale edit.
  useEffect(() => setName(project.name ?? ''), [project.name]);

  const trimmedName = name.trim();
  // Against the stored name trimmed too: an imported name with a trailing space
  // is not a change waiting to be saved.
  const nameChanged = trimmedName !== (project.name ?? '').trim();
  const nameValid = trimmedName.length > 0;

  const handleRename = async (event) => {
    event.preventDefault();
    if (!nameChanged || !nameValid || savingName) return;
    setSavingName(true);
    try {
      await getClient().projects.update(project.id, trimmedName);
      await onSaved?.();
      notifySuccess('Project renamed');
    } catch (err) {
      console.error('Error renaming project:', err);
      notifyError(humanizeError(err, 'Failed to rename the project.'));
      setName(project.name ?? '');
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Name</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex max-w-md items-start gap-2" onSubmit={handleRename}>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="project-name" className="sr-only">
                Project name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={savingName}
              />
              {nameChanged && !nameValid && (
                <p className="text-xs text-destructive">Project name cannot be empty</p>
              )}
            </div>
            <Button type="submit" disabled={!nameChanged || !nameValid || savingName}>
              {savingName ? 'Saving…' : 'Save'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {language && <LanguageCard onSaved={onSaved} {...language} />}

      {children}

      {research && <ResearchCard project={project} onSaved={onSaved} />}

      <DeleteProjectCard project={project} />
    </div>
  );
};

// One BCP-47 tag on the project itself, not on a layer: it is a fact about the
// project, and readers of it (a parse spot, a frame file) need no layer config.
const LanguageCard = ({ onSaved, saved, save, description, note }) => {
  const [tag, setTag] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setTag(saved), [saved]);

  const changed = tag.trim() !== saved;

  const handleSave = async (event) => {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    try {
      await save(tag.trim());
      await onSaved?.();
      notifySuccess('Language saved');
    } catch (err) {
      console.error('Failed to save project language:', err);
      notifyError(humanizeError(err, 'Failed to save the language.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Language</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <form className="flex items-end gap-2" onSubmit={handleSave}>
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="en"
            className="w-56"
            spellCheck={false}
            aria-label="Project language"
            dir="ltr"
          />
          <Button type="submit" disabled={!changed || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        {note && <p className="text-sm text-muted-foreground">{note(saved)}</p>}
      </CardContent>
    </Card>
  );
};

// The project's research-telemetry switch. A checkbox that saves on its own,
// shown at once and put back if the save fails. The recorder in this tab is
// told straight away, so the editors in it start or stop at once rather than
// when they next read the project.
const ResearchCard = ({ project, onSaved }) => {
  const { getClient } = useAuth();
  const saved = project.config?.plaid?.research?.telemetry === true;
  const [on, setOn] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setOn(saved), [saved]);

  const toggle = async (next) => {
    setOn(next);
    setSaving(true);
    try {
      const client = getClient();
      await client.projects.setConfig(project.id, 'plaid', 'research', { telemetry: next });
      client.events?.setEnabled?.(project.id, next);
      await onSaved?.();
    } catch (err) {
      console.error('Failed to save research telemetry:', err);
      setOn(!next);
      notifyError(humanizeError(err, 'Failed to save the research setting.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Research</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
            checked={on}
            disabled={saving}
            onChange={(e) => toggle(e.target.checked)}
          />
          Record responses to suggestions
        </label>
        <p className="text-sm text-muted-foreground">
          Records when a suggestion is shown to a member, accepted or replaced, and when an
          assistant plan is expanded.
        </p>
      </CardContent>
    </Card>
  );
};
