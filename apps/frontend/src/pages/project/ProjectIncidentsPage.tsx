import { IncidentsBrowser } from '@/components/incidents/IncidentsBrowser';
import { useProject } from '@/hooks/useProject';

/** The project's Incidents tab. */
export function ProjectIncidentsPage() {
  const { project } = useProject();
  return <IncidentsBrowser scope={{ projectId: project.id }} />;
}
