import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/contexts/AuthContext';
import { CatalogProvider } from '@/contexts/CatalogContext';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { LoginForm } from '@/components/auth/LoginForm';
import { AppLayout } from '@/components/layout/AppLayout';
import { DictionaryProvider } from '@/contexts/DictionaryContext';
import { Home } from '@/pages/Home';
import { Setup } from '@/pages/Setup';
import { FrontPage } from '@/pages/FrontPage';
import { FormPage } from '@/pages/FormPage';

// Every screen but the login form is inside the catalog, which resolves a slug
// to the vocabulary behind it.
const Reader = ({ children }) => (
  <ProtectedRoute>
    <CatalogProvider>
      <AppLayout>{children}</AppLayout>
    </CatalogProvider>
  </ProtectedRoute>
);

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginForm />} />
          <Route
            path="/"
            element={
              <Reader>
                <Home />
              </Reader>
            }
          />
          <Route
            path="/setup/:vocabularyId"
            element={
              <Reader>
                <Setup />
              </Reader>
            }
          />
          {/* A dictionary and its pages share one loaded vocabulary, so they
              sit under a provider that fetches it once. */}
          <Route
            path="/:slug"
            element={
              <Reader>
                <DictionaryProvider />
              </Reader>
            }
          >
            <Route index element={<FrontPage />} />
            <Route path=":form" element={<FormPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
