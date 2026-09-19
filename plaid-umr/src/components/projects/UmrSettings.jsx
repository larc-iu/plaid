import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from './useManagedProject.js';
import { getUmrLayerInfo, readIlgConfig, UMR_NAMESPACE } from '../../utils/umrLayerUtils.js';
import { HEADERS, proposeIlg } from '../../domain/ilg.js';
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';

const STORED = 'stored';

// The UMR settings section: which of the project's layers feed which gloss
// line under the words and in an exported file, in what order. A line's
// source is the morpheme layer, one of the substrate's annotation layers
// (IGT's fields), or the lines an import stored that nothing else covers.
export const UmrSettings = () => {
  const { projectId } = useParams();
  const { getClient } = useAuth();
  const { project, fetchProject } = useManagedProject(projectId);
  const layerInfo = useMemo(() => getUmrLayerInfo(project), [project]);
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  // Seed from the stored mapping, else the proposal, and re-seed on reload.
  useEffect(() => {
    if (!project) return;
    setRows(readIlgConfig(project) || proposeIlg(layerInfo));
  }, [project, layerInfo]);

  const sources = useMemo(() => {
    const out = [];
    if (layerInfo.morphemeTokenLayer) {
      out.push({ value: 'morphemes', label: `Morphemes (${layerInfo.morphemeTokenLayer.name})` });
    }
    layerInfo.glossLayers.forEach((g) => {
      out.push({ value: `layer:${g.layer.id}`, label: `${g.layer.name} (${g.scope})` });
    });
    out.push({ value: STORED, label: 'Lines an import stored' });
    return out;
  }, [layerInfo]);

  // A row that stops being "stored" needs a header; the first that fits its
  // source's scope is a start.
  const update = (i, patch) =>
    setRows((r) =>
      r.map((row, k) => {
        if (k !== i) return row;
        const next = { ...row, ...patch };
        if (next.source !== STORED && !next.header) {
          const scope =
            next.source === 'morphemes'
              ? 'morpheme'
              : layerInfo.glossLayers.find((g) => `layer:${g.layer.id}` === next.source)?.scope;
          next.header = (HEADERS.find((h) => h.scope === scope) || HEADERS[3]).key;
        }
        return next;
      }),
    );
  const incomplete = rows.some((r) => r.source !== STORED && !r.header);
  const move = (i, d) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const remove = (i) => setRows((r) => r.filter((_, k) => k !== i));
  const add = () =>
    setRows((r) => [
      ...r,
      { header: 'word-gloss', lang: 'und', source: sources[0]?.value || STORED },
    ]);

  const save = async () => {
    setSaving(true);
    try {
      const clean = rows
        .filter((r) => r.source)
        .map((r) =>
          r.source === STORED
            ? { header: null, lang: null, source: STORED }
            : {
                header: r.header,
                lang: HEADERS.find((h) => h.key === r.header)?.lang ? r.lang || 'und' : null,
                source: r.source,
              },
        );
      await getClient().projects.setConfig(projectId, UMR_NAMESPACE, 'ilg', clean);
      await fetchProject();
      notifySuccess('Gloss lines saved');
    } catch (err) {
      console.error('Failed to save the gloss lines:', err);
      notifyError(humanizeError(err, 'Failed to save the gloss lines.'));
    } finally {
      setSaving(false);
    }
  };

  const propose = () => setRows(proposeIlg(layerInfo));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Gloss lines</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          The lines under each sentence and in an exported .umr file, in this order. Index and Words
          are always written.
        </p>
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => {
            const header = HEADERS.find((h) => h.key === row.header);
            const stored = row.source === STORED;
            return (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={row.source}
                  onValueChange={(v) => update(i, { source: v })}
                  disabled={saving}
                >
                  <SelectTrigger className="w-[260px]" aria-label="Source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {stored ? (
                  <span className="flex-1 text-sm text-muted-foreground">Written as stored</span>
                ) : (
                  <>
                    <Select
                      value={row.header || ''}
                      onValueChange={(v) => update(i, { header: v })}
                      disabled={saving}
                    >
                      <SelectTrigger className="w-[200px]" aria-label="Header">
                        <SelectValue placeholder="Header" />
                      </SelectTrigger>
                      <SelectContent>
                        {HEADERS.map((h) => (
                          <SelectItem key={h.key} value={h.key}>
                            {h.header}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={header?.lang ? row.lang || '' : ''}
                      onChange={(e) => update(i, { lang: e.target.value.trim() })}
                      placeholder="lang"
                      aria-label="Language code"
                      className="w-20"
                      disabled={saving || !header?.lang}
                    />
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move up"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  onClick={() => remove(i)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={add} disabled={saving}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
          <Button type="button" variant="outline" onClick={propose} disabled={saving}>
            Propose from layers
          </Button>
          <Button type="button" onClick={save} disabled={saving || incomplete}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
