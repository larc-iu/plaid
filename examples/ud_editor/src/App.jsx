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

// Get the deployment basename by finding where the app's static assets are served from
function getBasename() {
  // Find a script tag that loads this app's bundle
  const scripts = document.querySelectorAll('script[src]');
  
  for (const script of scripts) {
    const src = script.getAttribute('src');
    // Look for the main bundle (usually contains 'main' or 'index' and ends with .js)
    if (src && (src.includes('main') || src.includes('index')) && src.endsWith('.js') && !src.startsWith('http')) {
      // Extract the directory path from the script src
      const lastSlash = src.lastIndexOf('/');
      if (lastSlash > 0) {
        const scriptDir = src.substring(0, lastSlash);
        // If script is in a subdirectory like '/app/assets/main.js', 
        // the basename is likely '/app'
        const segments = scriptDir.split('/').filter(Boolean);
        if (segments.length > 0 && segments[segments.length - 1] === 'assets') {
          // Remove 'assets' directory to get app root
          return '/' + segments.slice(0, -1).join('/');
        } else if (segments.length > 0) {
          // Script is directly in subdirectory
          return '/' + segments.join('/');
        }
      }
    }
  }
  
  // Fallback: no basename (root deployment)
  return '';
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