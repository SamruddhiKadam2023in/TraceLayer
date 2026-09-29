import { useOutletContext } from 'react-router';
import type { ProjectView } from '@tracelayer/shared';

export interface ProjectContext {
  project: ProjectView;
  /** Replace the loaded project after an edit. */
  setProject: (project: ProjectView) => void;
}

/** The project loaded by the surrounding ProjectLayout. */
export function useProject(): ProjectContext {
  return useOutletContext<ProjectContext>();
}
