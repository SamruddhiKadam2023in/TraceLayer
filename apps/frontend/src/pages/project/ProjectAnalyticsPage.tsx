import { LazyAnalyticsView as AnalyticsView } from '@/components/analytics/LazyAnalyticsView';
import { useProject } from '@/hooks/useProject';

export function ProjectAnalyticsPage() {
  const { project } = useProject();
  return <AnalyticsView scope={{ projectId: project.id }} createMonitorHref="../monitors/new" />;
}
