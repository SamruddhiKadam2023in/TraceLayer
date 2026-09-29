import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthReport } from '@tracelayer/shared';
import { SystemStatusPage } from './SystemStatusPage';
import { fetchHealth } from '@/services/health.service';

vi.mock('@/services/health.service', () => ({ fetchHealth: vi.fn() }));
const mockFetchHealth = vi.mocked(fetchHealth);

function makeReport(overrides: Partial<HealthReport['dependencies']> = {}): HealthReport {
  return {
    status: 'ok',
    version: '0.1.0',
    uptimeSeconds: 125,
    timestamp: '2026-09-29T10:00:00.000Z',
    dependencies: {
      database: { status: 'up', latencyMs: 3 },
      redis: { status: 'up', latencyMs: 1 },
      worker: { status: 'up', latencyMs: null, lastHeartbeatAt: '2026-09-29T09:59:55.000Z' },
      ...overrides,
    },
  };
}

describe('SystemStatusPage', () => {
  beforeEach(() => mockFetchHealth.mockReset());

  it('renders every service as operational when all dependencies are up', async () => {
    mockFetchHealth.mockResolvedValue(makeReport());
    render(<SystemStatusPage />);

    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    for (const key of ['api', 'database', 'redis', 'worker']) {
      expect(
        within(screen.getByTestId(`service-${key}`)).getByText('Operational'),
      ).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('service-database')).getByText('3ms')).toBeInTheDocument();
  });

  it('flags a down dependency with text, not only color', async () => {
    mockFetchHealth.mockResolvedValue(
      makeReport({
        worker: {
          status: 'down',
          latencyMs: null,
          lastHeartbeatAt: null,
          error: 'no recent heartbeat',
        },
      }),
    );
    render(<SystemStatusPage />);

    expect(await screen.findByText('1 service down')).toBeInTheDocument();
    const worker = screen.getByTestId('service-worker');
    expect(within(worker).getByText('Down')).toBeInTheDocument();
    expect(within(worker).getByText('no recent heartbeat')).toBeInTheDocument();
  });

  it('shows an error state with a working retry when the API is unreachable', async () => {
    mockFetchHealth.mockRejectedValueOnce(new Error('Network Error'));
    render(<SystemStatusPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the TraceLayer API');

    mockFetchHealth.mockResolvedValue(makeReport());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
