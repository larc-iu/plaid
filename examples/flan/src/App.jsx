import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { ProjectList } from './components/projects/ProjectList';
import { ProjectDetail } from './components/projects/ProjectDetail';
import { ProjectSetup } from './components/projects/ProjectSetup';
import { DocumentDetail } from './components/documents/DocumentDetail';
import { UserProfile } from './components/auth/UserProfile';
import { VocabularyList } from './components/vocabularies/VocabularyList';
import { VocabularyDetail } from './components/vocabularies/VocabularyDetail';
import { AppLayout } from './components/layout/AppLayout';

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />
          
          {/* Protected routes */}
          <Route path="/" element={
            <ProtectedRoute>
              <AppLayout>
                <Navigate to="/projects" replace />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/projects" element={
            <ProtectedRoute>
              <AppLayout>
                <ProjectList />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/projects/new" element={
            <ProtectedRoute>
              <AppLayout>
                <ProjectSetup />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/projects/:projectId/setup" element={
            <ProtectedRoute>
              <AppLayout>
                <ProjectSetup />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/projects/:projectId/documents/:documentId" element={
            <ProtectedRoute>
              <AppLayout>
                <DocumentDetail />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/projects/:projectId" element={
            <ProtectedRoute>
              <AppLayout>
                <ProjectDetail />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/vocabularies" element={
            <ProtectedRoute>
              <AppLayout>
                <VocabularyList />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/vocabularies/new" element={
            <ProtectedRoute>
              <AppLayout>
                <VocabularyDetail />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/vocabularies/:vocabularyId" element={
            <ProtectedRoute>
              <AppLayout>
                <VocabularyDetail />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          <Route path="/profile" element={
            <ProtectedRoute>
              <AppLayout>
                <UserProfile />
              </AppLayout>
            </ProtectedRoute>
          } />
          
          {/* Catch all - redirect to login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;