import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
import { LoginForm } from './components/auth/LoginForm';
import { RedeemInvite } from './components/auth/RedeemInvite';
import { ProjectList } from './components/projects/ProjectList';
import { ProjectDetail } from './components/projects/ProjectDetail';
import { NewProjectChooser } from './components/projects/NewProjectChooser';
import { StrictModeProvider } from './components/documents/contexts/StrictModeContext.jsx';
import { DocumentDetail } from './components/documents/DocumentDetail';
import { AppLayout } from './components/layout/AppLayout';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';
import { Suspended } from '@ui/components/shared/Suspended';
import { lazyNamed } from '@ui/lib/lazyNamed';

// Screens most visits never open ride in their own chunks: the import wizards
// (and the parsers behind them), the lexicon area, the admin area, the setup
// wizard, and the profile. Everything on the way to a document loads at once.
const ProjectSetup = lazyNamed(() => import('./components/projects/ProjectSetup'), 'ProjectSetup');
const ImportFlexProject = lazyNamed(
  () => import('./components/projects/ImportFlexProject'),
  'ImportFlexProject',
);
const ImportNativeProject = lazyNamed(
  () => import('./components/projects/ImportNativeProject'),
  'ImportNativeProject',
);
const ImportCldfProject = lazyNamed(
  () => import('./components/projects/ImportCldfProject'),
  'ImportCldfProject',
);
const ImportElanProject = lazyNamed(
  () => import('./components/projects/ImportElanProject'),
  'ImportElanProject',
);
const ImportElanDocuments = lazyNamed(
  () => import('./components/projects/ImportElanDocuments'),
  'ImportElanDocuments',
);
const UserProfile = lazyNamed(() => import('./components/auth/UserProfile'), 'UserProfile');
const AdminView = lazyNamed(() => import('./components/admin/AdminView'), 'AdminView');
const VocabularyList = lazyNamed(
  () => import('./components/vocabularies/VocabularyList'),
  'VocabularyList',
);
const VocabularyDetail = lazyNamed(
  () => import('./components/vocabularies/VocabularyDetail'),
  'VocabularyDetail',
);

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <ConfirmProvider>
          <Suspended>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<LoginForm />} />
              {/* Unauthenticated by necessity: whoever follows an invite link
                has no account yet, or has lost the password to the one they
                have. The code rides in the hash fragment, so it never reaches
                the server as part of a URL. */}
              <Route path="/invite/:code" element={<RedeemInvite />} />

              {/* Protected routes, all inside ONE shell.

                Every one of these used to carry its own
                `<ProtectedRoute><AppLayout>…</AppLayout></ProtectedRoute>`,
                so the shell was re-declared 20-odd times and its survival
                across a navigation was a matter of how React happened to
                reconcile two different elements of the same type. The
                assistant panel lives in the shell now and has to hold a
                conversation while the reader walks from one screen to the
                next, so the shell is declared once, as a layout route, and
                the screens swap inside its Outlet. */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<ProjectList />} />
                <Route path="/projects/new" element={<NewProjectChooser />} />
                <Route path="/projects/new/blank" element={<ProjectSetup />} />
                <Route path="/projects/import" element={<ImportFlexProject />} />
                <Route path="/projects/import-archive" element={<ImportNativeProject />} />
                <Route path="/projects/import-cldf" element={<ImportCldfProject />} />
                <Route path="/projects/import-elan" element={<ImportElanProject />} />
                <Route path="/projects/:projectId/import-elan" element={<ImportElanDocuments />} />
                <Route path="/projects/:projectId/setup" element={<ProjectSetup />} />
                <Route
                  path="/projects/:projectId/documents/:documentId"
                  element={
                    <StrictModeProvider>
                      <DocumentDetail />
                    </StrictModeProvider>
                  }
                />
                <Route path="/projects/:projectId" element={<ProjectDetail />} />

                {/* Project administration is the Settings tab of ProjectDetail; the
                section suffixes keep each settings section deep-linkable. */}
                <Route path="/projects/:projectId/access" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/services" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/export" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/export/:presetId" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/general" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/text-and-vocab" element={<ProjectDetail />} />
                <Route path="/projects/:projectId/annotation" element={<ProjectDetail />} />

                <Route path="/vocabularies" element={<VocabularyList />} />
                <Route path="/vocabularies/new" element={<VocabularyDetail />} />
                <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />

                <Route path="/admin" element={<AdminView />} />
                <Route path="/profile" element={<UserProfile />} />
              </Route>

              {/* Settings used to be one long scroll at /settings before it was
              split into General / Text and Vocab / Annotation, and the middle
              section was briefly /orthography and then /lexicon. Without these, those URLs fall through
              to the catch-all and bounce a logged-in user to /login. */}
              <Route
                path="/projects/:projectId/settings"
                element={<Navigate to="../general" replace relative="path" />}
              />
              <Route
                path="/projects/:projectId/orthography"
                element={<Navigate to="../text-and-vocab" replace relative="path" />}
              />
              <Route
                path="/projects/:projectId/lexicon"
                element={<Navigate to="../text-and-vocab" replace relative="path" />}
              />
              {/* Access Tokens folded into Access. */}
              <Route
                path="/projects/:projectId/tokens"
                element={<Navigate to="../access" replace relative="path" />}
              />

              {/* Catch all - redirect to login */}
              <Route path="*" element={<Navigate to="/login" replace />} />
            </Routes>
          </Suspended>
        </ConfirmProvider>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
