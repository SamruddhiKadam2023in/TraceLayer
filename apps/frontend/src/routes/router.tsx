import { createBrowserRouter } from 'react-router';
import { RootLayout } from '@/layouts/RootLayout';
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <SystemStatusPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
