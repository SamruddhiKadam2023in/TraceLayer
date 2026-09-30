import {
  Activity,
  FolderKanban,
  LayoutDashboard,
  Settings,
  Siren,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Sidebar entries. Endpoints, monitors, analytics and dependencies belong to a project, so they
 * are tabs of each project; incidents also have a workspace-wide list.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/status', label: 'System status', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];
