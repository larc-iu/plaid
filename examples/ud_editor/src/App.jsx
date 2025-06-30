import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { Layout } from './components/common/Layout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { UserProfile } from './components/auth/UserProfile';
import { ProjectList } from './components/projects/ProjectList';
import { ProjectManagement } from './components/projects/ProjectManagement';
import { DocumentList } from './components/documents/DocumentList';
import { TextEditor } from './components/editor/TextEditor';
import { AnnotationEditor } from './components/editor/AnnotationEditor';
import { ExportEditor } from './components/editor/ExportEditor';
import './App.css';

// Determine the basename from the current URL for subdirectory deployments
function getBasename() {
  let pathname = window.location.pathname;
  
  // Remove /index.html if present
  if (pathname.endsWith('/index.html')) {
    pathname = pathname.slice(0, -11); // Remove '/index.html'
  }
  
  // Remove trailing slash unless it's the root
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  
  // Ensure we return at least '/' for root
  return pathname || '/';
}

function App() {
  const basename = getBasename();
  
  return (
    <BrowserRouter basename={basename}>
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
            
            {/* Project management page */}
            <Route path="projects/:projectId/management" element={<ProjectManagement />} />
            
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
    </BrowserRouter>
  );
}

export default App;