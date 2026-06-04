import { useState, useEffect } from 'react';
import { Plus, Trash2, Pencil, Check, X, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';

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
    } catch (err) {
      setError('Failed to load vocabulary items');
      console.error('Error fetching vocabulary items:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (vocabularyId && vocabularyId !== 'new') {
      fetchItems();
    } else {
      setLoading(false);
      setItems([]);
    }
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

  const renderCustomFieldInputs = (values, onChange, keyPrefix) => {
    return customFields.map(fieldName => (
      <div key={`${keyPrefix}-${fieldName}`} className="flex flex-col gap-1.5">
        <Label>{fieldName}</Label>
        <Input
          placeholder={`Enter ${fieldName}`}
          value={values[fieldName] || ''}
          onChange={(event) => onChange({
            ...values,
            [fieldName]: event.target.value
          })}
        />
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
          <p className="text-sm font-medium">Vocabulary Items ({items.length})</p>

          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No vocabulary items yet. Add your first item below.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left font-medium" style={{ width: '30%' }}>Form</th>
                    {customFields.map(fieldName => (
                      <th
                        key={fieldName}
                        className="px-3 py-2 text-left font-medium"
                        style={{ width: `${Math.max(15, 60 / (customFields.length + 2))}%` }}
                      >
                        {fieldName}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-left font-medium" style={{ width: '20%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(record => (
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
                            <Input
                              value={editFields[fieldName] || ''}
                              onChange={(event) => setEditFields({
                                ...editFields,
                                [fieldName]: event.target.value
                              })}
                              className="h-8"
                            />
                          ) : (
                            <span>{record.metadata?.[fieldName] || ''}</span>
                          )}
                        </td>
                      ))}
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
                  This action cannot be undone and will remove all links to this item.
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
