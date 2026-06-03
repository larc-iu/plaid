import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { UserProfile } from './components/auth/UserProfile';
import { ProjectList } from './components/projects/ProjectList';
import { ProjectSettings } from './components/projects/ProjectSettings.jsx';
import { DocumentList } from './components/documents/DocumentList';
import { TextEditor } from './components/editor/TextEditor.jsx';
import { AnnotationEditor } from './components/editor/AnnotationEditor.jsx';
import { ExportEditor } from './components/editor/ExportEditor.jsx';
import './App.css';

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
              <Layout />
            </ProtectedRoute>
          }>
            {/* Default redirect to projects */}
            <Route index element={<Navigate to="/projects" replace />} />
            
            {/* User profile page */}
            <Route path="profile" element={<UserProfile />} />
            
            {/* Projects page */}
            <Route path="projects" element={<ProjectList />} />
            
            {/* Documents page */}
            <Route path="projects/:projectId/documents" element={<DocumentList />} />
            
            {/* Project settings (tabbed: users & permissions, customization, UD
                configuration). All paths render the same view; the active tab
                follows the path. */}
            <Route path="projects/:projectId/management" element={<ProjectSettings />} />
            <Route path="projects/:projectId/customization" element={<ProjectSettings />} />
            <Route path="projects/:projectId/configuration" element={<ProjectSettings />} />
            
            {/* Text editor route */}
            <Route path="projects/:projectId/documents/:documentId/edit" element={<TextEditor />} />
            
            {/* Annotation editor route */}
            <Route path="projects/:projectId/documents/:documentId/annotate" element={<AnnotationEditor />} />
            
            {/* Export editor route */}
            <Route path="projects/:projectId/documents/:documentId/export" element={<ExportEditor />} />
          </Route>
          
          {/* Catch all - redirect to login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
