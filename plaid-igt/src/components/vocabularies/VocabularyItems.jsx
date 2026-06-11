import { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2, Pencil, Check, X, AlertTriangle, ArrowUp, ArrowDown, Upload, Download, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { FLEX_MORPH_TYPES } from '@/domain/affixMarkers';

// Sortable column header (arrow on the active column, toggles direction).
const SortHeader = ({ field, label, sort, onSort, style }) => {
  const active = sort.key === field;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className="px-3 py-2 text-left font-medium" style={style}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(field)}
      >
        {label}
        {active && <Arrow className="h-3 w-3" />}
      </button>
    </th>
  );
};

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export const VocabularyItems = ({ vocabularyId, vocabulary, client, customFields }) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newItemForm, setNewItemForm] = useState('');
  const [newItemFields, setNewItemFields] = useState({});
  const [editingItem, setEditingItem] = useState(null);
  const [editForm, setEditForm] = useState('');
  const [editFields, setEditFields] = useState({});
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const openDeleteModal = () => setDeleteModalOpened(true);
  const closeDeleteModal = () => setDeleteModalOpened(false);
  const [itemToDelete, setItemToDelete] = useState(null);

  // Search / sort / usage counts / bulk add.
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'form', dir: 'asc' });
  const [usageCounts, setUsageCounts] = useState(null); // {itemId: n} | null while loading/unavailable
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const fetchItems = async () => {
    try {
      setLoading(true);
      if (!client) {
        throw new Error('Not authenticated');
      }

      if (!vocabularyId || vocabularyId === 'undefined' || vocabularyId === 'new') {
        throw new Error('Invalid vocabulary ID');
      }

      const vocabularyData = await client.vocabLayers.get(vocabularyId, true);
      setItems(vocabularyData.items || []);
      setError('');
      fetchUsageCounts(); // not awaited — counts fill in when ready
    } catch (err) {
      setError('Failed to load vocabulary items');
      console.error('Error fetching vocabulary items:', err);
    } finally {
      setLoading(false);
    }
  };

  // One grouped aggregate query: tokens linked per item, across every project
  // the user can read. null leaves the column as "—".
  const fetchUsageCounts = async () => {
    try {
      const res = await client.query({
        where: [['vocab', '?v', { layer: vocabularyId }], ['vocab-link', '?t', '?v']],
        return: { group: ['?v'], aggregates: [['count']] },
      });
      const counts = {};
      for (const [itemId, n] of res?.results || []) counts[itemId] = n;
      setUsageCounts(counts);
    } catch (err) {
      console.error('Usage-count query failed:', err);
      setUsageCounts(null);
      notifyWarning('Usage counts could not be loaded.', 'Usage counts unavailable');
    }
  };

  useEffect(() => {
    if (vocabularyId && vocabularyId !== 'new') {
      fetchItems();
    } else {
      setLoading(false);
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabularyId]);

  const handleCreateItem = async () => {
    if (!newItemForm.trim()) {
      notifyError('Item form cannot be empty', 'Invalid Form');
      return;
    }

    try {
      const metadata = Object.keys(newItemFields).length > 0 ? newItemFields : undefined;
      await client.vocabItems.create(vocabularyId, newItemForm.trim(), metadata);

      // Reset form
      setNewItemForm('');
      setNewItemFields({});

      // Refresh items
      await fetchItems();

      notifySuccess('Vocabulary item created successfully', 'Success');
    } catch (err) {
      console.error('Error creating vocabulary item:', err);
      notifyError('Failed to create vocabulary item', 'Error');
    }
  };

  const handleStartEdit = (item) => {
    setEditingItem(item.id);
    setEditForm(item.form);
    setEditFields(item.metadata || {});
  };

  const handleSaveEdit = async () => {
    if (!editForm.trim()) {
      notifyError('Item form cannot be empty', 'Invalid Form');
      return;
    }

    try {
      const item = items.find(i => i.id === editingItem);

      // Update form if changed
      if (editForm !== item.form) {
        await client.vocabItems.update(editingItem, editForm.trim());
      }

      // Update metadata
      if (Object.keys(editFields).length > 0) {
        await client.vocabItems.setMetadata(editingItem, editFields);
      } else if (item.metadata && Object.keys(item.metadata).length > 0) {
        await client.vocabItems.deleteMetadata(editingItem);
      }

      // Reset edit state
      setEditingItem(null);
      setEditForm('');
      setEditFields({});

      // Refresh items
      await fetchItems();

      notifySuccess('Vocabulary item updated successfully', 'Success');
    } catch (err) {
      console.error('Error updating vocabulary item:', err);
      notifyError('Failed to update vocabulary item', 'Error');
    }
  };

  const handleCancelEdit = () => {
    setEditingItem(null);
    setEditForm('');
    setEditFields({});
  };

  const handleDeleteClick = (item) => {
    setItemToDelete(item);
    openDeleteModal();
  };

  const handleConfirmDelete = async () => {
    if (!itemToDelete) return;

    try {
      await client.vocabItems.delete(itemToDelete.id);

      closeDeleteModal();
      setItemToDelete(null);

      // Refresh items
      await fetchItems();

      notifySuccess('Vocabulary item deleted successfully', 'Success');
    } catch (err) {
      console.error('Error deleting vocabulary item:', err);
      notifyError('Failed to delete vocabulary item', 'Error');
    }
  };

  // ---- bulk add (paste one item per line; TSV columns = Form + custom fields,
  // i.e. directly pasteable from a spreadsheet) ----
  const parsedBulk = useMemo(() => {
    const lines = bulkText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
    const existing = new Set(items.map((i) => i.form.toLowerCase()));
    const rows = [];
    const seen = new Set();
    let skipped = 0;
    for (const line of lines) {
      const cells = line.split('\t').map((c) => c.trim());
      const form = cells[0];
      if (!form) continue;
      const k = form.toLowerCase();
      if (existing.has(k) || seen.has(k)) { skipped++; continue; }
      seen.add(k);
      const metadata = {};
      customFields.forEach((f, i) => {
        if (cells[i + 1]) metadata[f] = cells[i + 1];
      });
      rows.push({ form, metadata: Object.keys(metadata).length ? metadata : undefined });
    }
    return { rows, skipped };
  }, [bulkText, items, customFields]);

  const handleBulkAdd = async () => {
    const { rows, skipped } = parsedBulk;
    if (!rows.length) return;
    setBulkBusy(true);
    try {
      client.beginBatch();
      rows.forEach((r) => client.vocabItems.create(vocabularyId, r.form, r.metadata));
      await client.submitBatch();
      setBulkOpen(false);
      setBulkText('');
      await fetchItems();
      notifySuccess(
        `Added ${rows.length} item${rows.length === 1 ? '' : 's'}${skipped ? ` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped)` : ''}`,
        'Bulk Add Complete'
      );
    } catch (err) {
      console.error('Bulk add failed:', err);
      notifyError('Bulk add failed — no items were created.', 'Error');
    } finally {
      setBulkBusy(false);
    }
  };

  // ---- CSV export (Form + custom fields + Uses) ----
  const handleExportCsv = () => {
    const header = ['Form', ...customFields, ...(usageCounts ? ['Uses'] : [])];
    const lines = [header.map(csvCell).join(',')];
    for (const it of sortedItems) {
      const row = [it.form, ...customFields.map((f) => it.metadata?.[f] ?? '')];
      if (usageCounts) row.push(usageCounts[it.id] ?? 0);
      lines.push(row.map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vocabulary?.name || 'vocabulary'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- search + sort ----
  const onSort = (key) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const sortedItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items;
    if (q) {
      list = items.filter((it) =>
        it.form.toLowerCase().includes(q) ||
        customFields.some((f) => String(it.metadata?.[f] ?? '').toLowerCase().includes(q)));
    }
    const val = (it) => {
      if (sort.key === 'form') return it.form.toLowerCase();
      if (sort.key === '_uses') return usageCounts?.[it.id] ?? 0;
      return String(it.metadata?.[sort.key] ?? '').toLowerCase();
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [items, search, sort, customFields, usageCounts]);

  const renderCustomFieldInputs = (values, onChange, keyPrefix) => {
    return customFields.map(fieldName => (
      <div key={`${keyPrefix}-${fieldName}`} className="flex flex-col gap-1.5">
        <Label>{fieldName}</Label>
        {fieldName === 'morphType' ? (
          // morphType is a controlled vocabulary (FLEx's exact inventory)
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={values.morphType || ''}
            onChange={(event) => onChange({
              ...values,
              morphType: event.target.value || undefined
            })}
          >
            <option value="">—</option>
            {FLEX_MORPH_TYPES.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        ) : (
          <Input
            placeholder={`Enter ${fieldName}`}
            value={values[fieldName] || ''}
            onChange={(event) => onChange({
              ...values,
              [fieldName]: event.target.value
            })}
          />
        )}
      </div>
    ));
  };

  if (loading) {
    return (
      <div className="tw flex flex-col items-center gap-6 py-6">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm">Loading vocabulary items...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tw rounded-md border border-destructive/50 bg-destructive/5 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">Error</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tw flex flex-col gap-6">
      {/* Items table */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              Vocabulary Items ({search ? `${sortedItems.length} of ${items.length}` : items.length})
            </p>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search items…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-56 pl-7"
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
                <Upload className="h-3.5 w-3.5" /> Bulk Add
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={!items.length}>
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No vocabulary items yet. Add your first item below.
            </p>
          ) : sortedItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No items match "{search}".
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <SortHeader field="form" label="Form" sort={sort} onSort={onSort} style={{ width: '26%' }} />
                    {customFields.map(fieldName => (
                      <SortHeader
                        key={fieldName}
                        field={fieldName}
                        label={fieldName}
                        sort={sort}
                        onSort={onSort}
                        style={{ width: `${Math.max(14, 52 / (customFields.length + 2))}%` }}
                      />
                    ))}
                    <SortHeader field="_uses" label="Uses" sort={sort} onSort={onSort} style={{ width: '10%' }} />
                    <th className="px-3 py-2 text-left font-medium" style={{ width: '16%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedItems.map(record => (
                    <tr key={record.id} className="group border-t hover:bg-muted/50">
                      <td className="px-3 py-2">
                        {editingItem === record.id ? (
                          <Input
                            value={editForm}
                            onChange={(event) => setEditForm(event.target.value)}
                            className="h-8"
                          />
                        ) : (
                          <span>{record.form}</span>
                        )}
                      </td>
                      {customFields.map(fieldName => (
                        <td key={fieldName} className="px-3 py-2">
                          {editingItem === record.id ? (
                            fieldName === 'morphType' ? (
                              // morphType is a controlled vocabulary (FLEx's
                              // exact morph-type inventory), not free text.
                              <select
                                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                                value={editFields.morphType || ''}
                                onChange={(event) => setEditFields({
                                  ...editFields,
                                  morphType: event.target.value || undefined
                                })}
                              >
                                <option value="">—</option>
                                {FLEX_MORPH_TYPES.map(t => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            ) : (
                              <Input
                                value={editFields[fieldName] || ''}
                                onChange={(event) => setEditFields({
                                  ...editFields,
                                  [fieldName]: event.target.value
                                })}
                                className="h-8"
                              />
                            )
                          ) : (
                            <span>{record.metadata?.[fieldName] || ''}</span>
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-muted-foreground" title="Linked words/morphemes across projects you can read">
                        {usageCounts ? (usageCounts[record.id] ?? 0) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {editingItem === record.id ? (
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-green-600 hover:text-green-600"
                              onClick={handleSaveEdit}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={handleCancelEdit}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => handleStartEdit(record)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => handleDeleteClick(record)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Add new item form */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium">Add New Vocabulary Item</p>

          <div className="flex flex-col gap-1.5">
            <Label>Form</Label>
            <Input
              placeholder="Enter item form"
              value={newItemForm}
              onChange={(event) => setNewItemForm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleCreateItem();
                }
              }}
            />
          </div>

          {customFields.length > 0 && (
            <>
              <div className="border-t" />
              <p className="text-sm font-medium">Custom Fields</p>
              <div className="flex flex-col gap-2">
                {renderCustomFieldInputs(newItemFields, setNewItemFields, 'new')}
              </div>
            </>
          )}

          <div className="flex justify-end">
            <Button
              onClick={handleCreateItem}
              disabled={!newItemForm.trim()}
            >
              <Plus className="h-4 w-4" /> Add Item
            </Button>
          </div>
        </div>
      </div>

      {/* Bulk add dialog */}
      <Dialog open={bulkOpen} onOpenChange={(o) => { if (!o && !bulkBusy) setBulkOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bulk Add Items</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              One item per line. Columns are tab-separated (paste straight from a
              spreadsheet): <strong>Form</strong>{customFields.length ? <> then {customFields.join(', ')}</> : null}.
              Duplicates of existing forms are skipped.
            </p>
            <Textarea
              rows={10}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={customFields.length ? `form\t${customFields.join('\t')}` : 'one form per line'}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {parsedBulk.rows.length} item{parsedBulk.rows.length === 1 ? '' : 's'} to add
              {parsedBulk.skipped ? ` · ${parsedBulk.skipped} duplicate${parsedBulk.skipped === 1 ? '' : 's'} skipped` : ''}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>Cancel</Button>
            <Button onClick={handleBulkAdd} disabled={!parsedBulk.rows.length || bulkBusy}>
              {bulkBusy ? 'Adding…' : `Add ${parsedBulk.rows.length} item${parsedBulk.rows.length === 1 ? '' : 's'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Modal */}
      <AlertDialog open={deleteModalOpened} onOpenChange={(o) => { if (!o) closeDeleteModal(); }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Vocabulary Item</AlertDialogTitle>
          </AlertDialogHeader>

          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Warning</p>
                <p className="mt-1 text-muted-foreground">
                  You are about to permanently delete the vocabulary item <strong>"{itemToDelete?.form}"</strong>.
                </p>
                <p className="mt-1 text-muted-foreground">
                  {usageCounts && (usageCounts[itemToDelete?.id] ?? 0) > 0
                    ? <>It is linked to <strong>{usageCounts[itemToDelete.id]} word{usageCounts[itemToDelete.id] === 1 ? '' : 's'}/morpheme{usageCounts[itemToDelete.id] === 1 ? '' : 's'}</strong> — those links will be removed. </>
                    : null}
                  This action cannot be undone.
                </p>
              </div>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeDeleteModal}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              <Trash2 className="h-4 w-4" /> Delete Item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
