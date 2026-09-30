import { useEffect } from 'react';
import { useRealtimeListener } from '@/hooks/useRealtime';
import { connectRealtime, disconnectRealtime, setRealtimeWorkspace } from '@/services/realtime';
import { useAuthStore } from '@/stores/auth.store';
import { useToastStore } from '@/stores/toast.store';
import { useCurrentWorkspace } from '@/stores/workspace.store';

/**
 * Keeps this tab's live connection subscribed to the current workspace, and turns incident
 * events into notifications (spec: "incident notifications"). Renders nothing.
 */
export function RealtimeConnector() {
  const workspace = useCurrentWorkspace();
  const userId = useAuthStore((s) => s.user?.id);
  const show = useToastStore((s) => s.show);

  useEffect(() => {
    connectRealtime();
    return () => disconnectRealtime();
  }, []);

  useEffect(() => {
    setRealtimeWorkspace(workspace.id);
  }, [workspace.id]);

  useRealtimeListener((message) => {
    if (message.event !== 'incident.created' && message.event !== 'incident.updated') return;
    const { incident, projectId, change, actor } = message.payload;
    // People know about their own changes; comments and assignments are not worth a pop-up.
    if (actor?.id === userId) return;
    const href = `/projects/${projectId}/incidents/${incident.id}`;
    if (change === 'opened') {
      show({
        tone: 'danger',
        title: `Incident #${incident.number} opened`,
        body: incident.title,
        href,
      });
    } else if (change === 'resolved_automatically') {
      show({
        tone: 'success',
        title: `Incident #${incident.number} resolved`,
        body: 'The monitor recovered.',
        href,
      });
    } else if (change === 'status' && incident.status === 'RESOLVED' && actor) {
      show({
        tone: 'success',
        title: `Incident #${incident.number} resolved by ${actor.name}`,
        body: incident.title,
        href,
      });
    }
  });

  return null;
}
