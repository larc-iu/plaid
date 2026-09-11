import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyNamed } from '@ui/lib/lazyNamed.js';
import { Suspended } from '@ui/components/shared/Suspended.jsx';
import { AuthProvider } from './contexts/AuthContext';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { RedeemInvite } from './components/auth/RedeemInvite';
import { UserProfile } from './components/auth/UserProfile';
import { ProjectList } from './components/projects/ProjectList';
import { DocumentList } from './components/documents/DocumentList';
import { TextEditor } from './components/editor/TextEditor.jsx';
import { AnnotationEditor } from './components/editor/AnnotationEditor.jsx';
import { DocumentEditorShell } from './components/editor/DocumentEditorShell.jsx';
import { DocumentDetails } from './components/documents/DocumentDetails.jsx';
import './App.css';

// Screens a session opens rarely, if at all: they download when first opened
// rather than riding along with the project list. The editor and the two lists
// stay eager, being where a session starts and spends its time.
const SearchPage = lazyNamed(() => import('./components/search/SearchPage.jsx'), 'SearchPage');
const ProjectImportExport = lazyNamed(
  () => import('./components/projects/ProjectImportExport.jsx'),
  'ProjectImportExport',
);
const ProjectSettings = lazyNamed(
  () => import('./components/projects/ProjectSettings.jsx'),
  'ProjectSettings',
);
const ProjectActivity = lazyNamed(
  () => import('./components/projects/ProjectActivity.jsx'),
  'ProjectActivity',
);
const ProjectValidation = lazyNamed(
  () => import('./components/validate/ProjectValidation.jsx'),
  'ProjectValidation',
);
const ProjectConfiguration = lazyNamed(
  () => import('./components/projects/ProjectConfiguration.jsx'),
  'ProjectConfiguration',
);
const ExportEditor = lazyNamed(
  () => import('./components/editor/ExportEditor.jsx'),
  'ExportEditor',
);

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginForm />} />
          {/* Unauthenticated by necessity: whoever follows an invite link has
              no account yet, or has lost the password to the one they have.
              The code rides in the hash fragment, so it never reaches the
              server as part of a URL. */}
          <Route path="/invite/:code" element={<RedeemInvite />} />

          {/* Protected routes */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            {/* Default redirect to projects */}
            <Route index element={<Navigate to="/projects" replace />} />

            {/* User profile page */}
            <Route path="profile" element={<UserProfile />} />

            {/* Projects page */}
            <Route path="projects" element={<ProjectList />} />

            {/* Documents page */}
            <Route path="projects/:projectId/documents" element={<DocumentList />} />

            {/* Grew-match search over the project's sentences */}
            <Route
              path="projects/:projectId/search"
              element={
                <Suspended>
                  <SearchPage />
                </Suspended>
              }
            />

            {/* Values stored that the project's vocabularies do not list. */}
            <Route
              path="projects/:projectId/validate"
              element={
                <Suspended>
                  <ProjectValidation />
                </Suspended>
              }
            />

            {/* Who has been working on this project, and on what. Maintainers. */}
            <Route
              path="projects/:projectId/activity"
              element={
                <Suspended>
                  <ProjectActivity />
                </Suspended>
              }
            />

            {/* Bulk CoNLL-U import + project-wide ZIP export */}
            <Route
              path="projects/:projectId/import-export"
              element={
                <Suspended>
                  <ProjectImportExport />
                </Suspended>
              }
            />

            {/* Project settings (tabbed: users & permissions, UD customization,
                services, access tokens, general). All paths render the same
                view; the active tab follows the path. */}
            <Route
              path="projects/:projectId/management"
              element={
                <Suspended>
                  <ProjectSettings />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/customization"
              element={
                <Suspended>
                  <ProjectSettings />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/services"
              element={
                <Suspended>
                  <ProjectSettings />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/tokens"
              element={
                <Suspended>
                  <ProjectSettings />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/general"
              element={
                <Suspended>
                  <ProjectSettings />
                </Suspended>
              }
            />

            {/* Standalone UD layer setup/repair page — the destination of the
                annotation editor's "missing layers" auto-redirect. */}
            <Route
              path="projects/:projectId/configuration"
              element={
                <Suspended>
                  <ProjectConfiguration />
                </Suspended>
              }
            />

            {/* The three document-editor tabs are CHILDREN of one shell route,
                not siblings. The shell's params don't change when you switch
                tabs, so it stays mounted: the breadcrumbs and tab strip never
                unmount and the document is loaded once instead of once per
                tab visit. See DocumentEditorShell. */}
            <Route
              path="projects/:projectId/documents/:documentId"
              element={<DocumentEditorShell />}
            >
              <Route path="edit" element={<TextEditor />} />
              <Route path="annotate" element={<AnnotationEditor />} />
              <Route path="details" element={<DocumentDetails />} />
              <Route
                path="export"
                element={
                  <Suspended>
                    <ExportEditor />
                  </Suspended>
                }
              />
            </Route>
          </Route>

          {/* Catch all - redirect to login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
