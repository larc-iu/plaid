import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { Layout } from './components/common/Layout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { ProjectList } from './components/projects/ProjectList';
import { DocumentList } from './components/documents/DocumentList';
import { TextEditor } from './components/editor/TextEditor';
import { AnnotationEditor } from './components/editor/AnnotationEditor';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />
          
          {/* Protected routes */}
          <Route path="/" element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }>
            {/* Default redirect to projects */}
            <Route index element={<Navigate to="/projects" replace />} />
            
            {/* Projects page */}
            <Route path="projects" element={<ProjectList />} />
            
            {/* Documents page */}
            <Route path="projects/:projectId/documents" element={<DocumentList />} />
            
            {/* Text editor route */}
            <Route path="projects/:projectId/documents/:documentId/edit" element={<TextEditor />} />
            
            {/* Annotation editor route */}
            <Route path="projects/:projectId/documents/:documentId/annotate" element={<AnnotationEditor />} />
          </Route>
          
          {/* Catch all - redirect to login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;