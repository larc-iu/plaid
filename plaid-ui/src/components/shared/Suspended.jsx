import { Suspense } from 'react';
import { Loading } from './Loading.jsx';

// The boundary around a lazily loaded screen or tab: the same "Loading…" line
// the lists show while a chunk downloads.
export const Suspended = ({ children }) => <Suspense fallback={<Loading />}>{children}</Suspense>;
