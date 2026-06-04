import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export const VocabularyList = () => {
  const navigate = useNavigate();
  const [vocabularies, setVocabularies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { client, logout } = useAuth();

  const fetchVocabularies = async () => {
    try {
      setLoading(true);
      if (!client) throw new Error('Not authenticated');
      const vocabList = await client.vocabLayers.list();
      setVocabularies(vocabList);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        logout();
        return;
      }
      setError('Failed to load vocabularies');
      console.error('Error fetching vocabularies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVocabularies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="tw flex items-center justify-center py-24 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="tw mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Vocabularies</h1>
        <Button onClick={() => navigate('/vocabularies/new')}>
          <Plus className="h-4 w-4" /> New Vocabulary
        </Button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {vocabularies.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <p className="text-lg">No vocabularies found</p>
          <p className="mt-1 text-sm">Create your first vocabulary to get started.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {vocabularies.map((vocabulary) => (
            <Card
              key={vocabulary.id}
              onClick={() => navigate(`/vocabularies/${vocabulary.id}`)}
              className="cursor-pointer p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <h3 className="font-semibold">{vocabulary.name}</h3>
              <p className="mt-1 truncate text-sm text-muted-foreground">ID: {vocabulary.id}</p>
              {vocabulary.maintainers && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {vocabulary.maintainers.length} maintainer{vocabulary.maintainers.length !== 1 ? 's' : ''}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
