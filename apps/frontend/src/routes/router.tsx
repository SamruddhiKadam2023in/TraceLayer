import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RootLayout } from '@/layouts/RootLayout';
import { AppLayout } from '@/layouts/AppLayout';
import { AuthLayout } from '@/layouts/AuthLayout';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { SystemStatusPage } from '@/pages/SystemStatusPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { WorkspaceSettingsPage } from '@/pages/WorkspaceSettingsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { ProjectLayout } from '@/layouts/ProjectLayout';
import { ProjectOverviewPage } from '@/pages/project/ProjectOverviewPage';
import { ProjectEnvironmentsPage } from '@/pages/project/ProjectEnvironmentsPage';
import { ProjectSettingsPage } from '@/pages/project/ProjectSettingsPage';
import { RedirectIfAuthenticated, RequireAuth, RequireWorkspace } from './guards';

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      {
        element: <RedirectIfAuthenticated />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { path: '/login', element: <LoginPage /> },
              { path: '/register', element: <RegisterPage /> },
            ],
          },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireWorkspace />,
            children: [
              {
                element: <AppLayout />,
                children: [
                  // The dashboard replaces this redirect when it is built (Phase 9).
                  { path: '/', element: <Navigate to="/projects" replace /> },
                  { path: '/projects', element: <ProjectsPage /> },
                  {
                    path: '/projects/:projectId',
                    element: <ProjectLayout />,
                    children: [
                      { index: true, element: <ProjectOverviewPage /> },
                      { path: 'environments', element: <ProjectEnvironmentsPage /> },
                      { path: 'settings', element: <ProjectSettingsPage /> },
                    ],
                  },
                  { path: '/status', element: <SystemStatusPage /> },
                  { path: '/settings', element: <WorkspaceSettingsPage /> },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
