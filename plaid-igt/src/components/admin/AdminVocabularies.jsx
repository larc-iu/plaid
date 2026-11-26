import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '@ui/components/shared/data-table';
import { notifyError, humanizeError } from '@/utils/feedback';
import { textIncludes } from '@ui/domain/collation.js';
import { ProjectLink } from './ProjectLink';
import { t } from '@ui/lib/i18n.js';

// Every vocabulary belongs to one project and other projects may link it, so
// which projects use one is invisible from inside any of them. This is the
// join: its project first, then the projects that link it.

export const AdminVocabularies = ({ client }) => {
  const [vocabs, setVocabs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vocabList, projectList] = await Promise.all([
        client.vocabLayers.list(),
        client.projects.list(),
      ]);
      setVocabs(vocabList || []);
      setProjects(projectList || []);
    } catch (err) {
      console.error('Error loading vocabularies:', err);
      notifyError(humanizeError(err), t('Failed to load the vocabularies'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const usedBy = new Map();
    projects.forEach((p) => {
      (p.vocabs || []).forEach((v) => {
        if (!usedBy.has(v.id)) usedBy.set(v.id, []);
        usedBy.get(v.id).push(p);
      });
    });
    return vocabs.map((v) => {
      const home = byId.get(v.project) ?? null;
      const others = (usedBy.get(v.id) || []).filter((p) => p.id !== v.project);
      return {
        ...v,
        // The project's name, or its id when the list does not hold it.
        homeLabel: home?.name ?? v.project,
        home: home ?? { id: v.project },
        projects: home ? [home, ...others] : others,
      };
    });
  }, [vocabs, projects]);

  const columns = [
    {
      key: 'name',
      label: t('Name'),
      sort: (v) => (v.name || '').toLowerCase(),
      render: (v) => (
        <Link to={`/vocabularies/${v.id}`} className="font-medium hover:underline">
          {v.name}
        </Link>
      ),
    },
    {
      key: 'project',
      label: t('Project'),
      sort: (v) => (v.homeLabel || '').toLowerCase(),
      render: (v) => (
        <ProjectLink project={v.home} dir="auto" className="hover:underline">
          {v.homeLabel}
        </ProjectLink>
      ),
    },
    {
      key: 'projects',
      label: t('Used by'),
      sort: (v) => v.projects.length,
      render: (v) => (
        <span className="flex flex-wrap gap-x-2 gap-y-1">
          {v.projects.map((p) => (
            <ProjectLink
              key={p.id}
              project={p}
              dir="auto"
              className="text-muted-foreground hover:underline"
            />
          ))}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(v) => v.id}
      id="admin-vocabularies"
      defaultSort={{ key: 'name', dir: 'asc' }}
      search={{
        placeholder: t('Search vocabularies…'),
        match: (v, q) => textIncludes(v.name || '', q),
      }}
      countLabel={(v) => t('{total} {n, plural, one {vocabulary} other {vocabularies}}', v)}
      empty={t('No vocabularies.')}
      noMatch={t('No vocabularies match.')}
      loading={loading}
    />
  );
};
