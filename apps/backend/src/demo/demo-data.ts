import type {
  AlertMetric,
  Assertion,
  DependencyNodeKind,
  EndpointAuth,
  EndpointBody,
  HttpMethod,
  IncidentStatus,
  KeyValue,
  MonitorType,
  Severity,
} from '@tracelayer/shared';

/**
 * The demo workspace (spec §52): three APIs with endpoints, monitors, a week of monitor history
 * and the incidents that history caused.
 *
 * Endpoints point at real public demo APIs (dummyjson.com for e-commerce and sign-in,
 * httpbin.org echoing payment requests), so every request can be sent and every monitor resumed
 * for real. The history itself is generated: that is what the workspace's Demo label says.
 */

export const DEMO_WORKSPACE_NAME = 'Demo Workspace';
export const DEMO_EMAIL_DOMAIN = 'demo.tracelayer.local';
export const DEMO_HISTORY_DAYS = 7;

export interface DemoTeammate {
  key: 'teammate' | 'viewer';
  name: string;
  email: string;
  role: 'MEMBER' | 'VIEWER';
}

export const DEMO_TEAMMATES: DemoTeammate[] = [
  { key: 'teammate', name: 'Priya Shah', email: `priya@${DEMO_EMAIL_DOMAIN}`, role: 'MEMBER' },
  { key: 'viewer', name: 'Leo Martins', email: `leo@${DEMO_EMAIL_DOMAIN}`, role: 'VIEWER' },
];

export type Person = 'owner' | 'teammate';

/** What people did while an incident was open, in minutes after it was detected. */
export interface DemoResponse {
  assignee: Person;
  steps: (
    | { after: number; by: Person; status: Exclude<IncidentStatus, 'OPEN' | 'RESOLVED'> }
    | { after: number; by: Person; comment: string }
  )[];
  /** A note added after the incident resolved (minutes after resolution). */
  followUp?: { after: number; by: Person; comment: string };
}

/**
 * A stretch of trouble in the generated history.
 * - outage: every check fails (a status code, or timeouts when `statusCode` is null).
 * - slow: responses take `factor` times longer than usual.
 * - flaky: a share (`failRate`) of checks fail with `statusCode`.
 * An incident follows only if the monitor's alert rule fires on it.
 */
export interface DemoScenario {
  kind: 'outage' | 'slow' | 'flaky';
  /** Start, in hours before now. */
  startHoursAgo: number;
  /** Length in minutes; a scenario reaching now is still going on. */
  durationMinutes: number;
  statusCode?: number | null;
  factor?: number;
  failRate?: number;
  response?: DemoResponse;
}

export interface DemoRule {
  name: string;
  metric: AlertMetric;
  threshold: number;
  durationMinutes: number;
  severity: Severity;
}

export interface DemoMonitor {
  name: string;
  endpoint: string;
  type: MonitorType;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number | null;
  latencyThresholdMs?: number;
  assertions?: Assertion[];
  /** Typical response time and how much it varies (log-normal spread). */
  latency: { medianMs: number; spread: number };
  sizeBytes: number;
  /** Body returned by healthy checks, for response validation. */
  body?: string;
  rule: DemoRule;
  scenarios: DemoScenario[];
}

export interface DemoEndpoint {
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  queryParams?: KeyValue[];
  headers?: KeyValue[];
  body?: EndpointBody;
  auth?: EndpointAuth;
  expectedStatus?: number;
  tags: string[];
}

export interface DemoVariable {
  key: string;
  value: string;
  secret: boolean;
}

export interface DemoDependencyNode {
  key: string;
  label: string;
  kind: DependencyNodeKind;
  host: string | null;
  x: number;
  y: number;
  inferred?: boolean;
}

export interface DemoProject {
  name: string;
  description: string;
  baseUrl: string;
  variables: DemoVariable[];
  endpoints: DemoEndpoint[];
  monitors: DemoMonitor[];
  dependencies?: {
    nodes: DemoDependencyNode[];
    edges: { from: string; to: string; label?: string; inferred?: boolean }[];
  };
}

const kv = (key: string, value: string): KeyValue => ({ key, value, enabled: true });

export const DEMO_PROJECTS: DemoProject[] = [
  {
    name: 'E-Commerce API',
    description: 'Storefront catalogue, search and cart (demo data).',
    baseUrl: 'https://dummyjson.com',
    variables: [],
    endpoints: [
      {
        name: 'List products',
        description: 'First page of the product catalogue.',
        method: 'GET',
        url: '/products',
        queryParams: [kv('limit', '20'), kv('select', 'title,price,stock')],
        expectedStatus: 200,
        tags: ['catalog'],
      },
      {
        name: 'Search products',
        description: 'Full-text product search used by the storefront search box.',
        method: 'GET',
        url: '/products/search',
        queryParams: [kv('q', 'phone')],
        tags: ['catalog', 'search'],
      },
      {
        name: 'Get cart',
        description: 'A shopping cart with its line items and totals.',
        method: 'GET',
        url: '/carts/1',
        tags: ['cart'],
      },
      {
        name: 'Add to cart',
        description: 'Adds products to a new cart.',
        method: 'POST',
        url: '/carts/add',
        headers: [kv('Content-Type', 'application/json')],
        body: {
          type: 'json',
          content: '{\n  "userId": 1,\n  "products": [{ "id": 144, "quantity": 2 }]\n}',
        },
        tags: ['cart'],
      },
    ],
    monitors: [
      {
        name: 'Product catalogue',
        endpoint: 'List products',
        type: 'STATUS',
        intervalSeconds: 300,
        timeoutMs: 5000,
        expectedStatus: 200,
        latency: { medianMs: 190, spread: 0.22 },
        sizeBytes: 2860,
        rule: {
          name: 'Catalogue down',
          metric: 'CONSECUTIVE_FAILURES',
          threshold: 1,
          durationMinutes: 0,
          severity: 'HIGH',
        },
        scenarios: [
          {
            kind: 'outage',
            startHoursAgo: 50,
            durationMinutes: 32,
            statusCode: 503,
            response: {
              assignee: 'teammate',
              steps: [
                { after: 4, by: 'teammate', status: 'ACKNOWLEDGED' },
                { after: 7, by: 'teammate', status: 'INVESTIGATING' },
                {
                  after: 9,
                  by: 'teammate',
                  comment: 'Catalogue returns 503 in every region. Checking the database.',
                },
                { after: 18, by: 'teammate', status: 'IDENTIFIED' },
                {
                  after: 19,
                  by: 'teammate',
                  comment: 'Primary database node lost its disk; failing over to the replica.',
                },
              ],
              followUp: {
                after: 12,
                by: 'owner',
                comment: 'Post-mortem scheduled. Adding an alert on replica lag.',
              },
            },
          },
        ],
      },
      {
        name: 'Search latency',
        endpoint: 'Search products',
        type: 'PERFORMANCE',
        intervalSeconds: 300,
        timeoutMs: 5000,
        expectedStatus: 200,
        latencyThresholdMs: 700,
        latency: { medianMs: 320, spread: 0.25 },
        sizeBytes: 5310,
        rule: {
          name: 'Search slow',
          metric: 'RESPONSE_TIME',
          threshold: 700,
          durationMinutes: 10,
          severity: 'MEDIUM',
        },
        scenarios: [
          {
            kind: 'slow',
            startHoursAgo: 26,
            durationMinutes: 55,
            factor: 2.8,
            response: {
              assignee: 'owner',
              steps: [
                { after: 6, by: 'owner', status: 'ACKNOWLEDGED' },
                {
                  after: 8,
                  by: 'owner',
                  comment:
                    'Search index rebuild started at the same time. Expected to finish soon.',
                },
                { after: 10, by: 'owner', status: 'IDENTIFIED' },
              ],
            },
          },
          // A slower evening that stays under the alert threshold.
          { kind: 'slow', startHoursAgo: 110, durationMinutes: 90, factor: 1.6 },
        ],
      },
      {
        name: 'Cart API',
        endpoint: 'Get cart',
        type: 'RESPONSE_VALIDATION',
        intervalSeconds: 300,
        timeoutMs: 5000,
        expectedStatus: 200,
        assertions: [
          { path: 'id', operator: 'equals', value: 1 },
          { path: 'products', operator: 'exists' },
        ],
        latency: { medianMs: 230, spread: 0.2 },
        sizeBytes: 1720,
        body: '{"id":1,"products":[{"id":168,"title":"Charger SXT RWD","quantity":3}],"total":103774.85,"userId":33}',
        rule: {
          name: 'Cart broken',
          metric: 'CONSECUTIVE_FAILURES',
          threshold: 2,
          durationMinutes: 0,
          severity: 'HIGH',
        },
        scenarios: [],
      },
    ],
    dependencies: {
      nodes: [
        { key: 'web', label: 'Web storefront', kind: 'FRONTEND', host: null, x: 220, y: 0 },
        { key: 'gateway', label: 'API gateway', kind: 'GATEWAY', host: null, x: 220, y: 150 },
        {
          key: 'catalog',
          label: 'Catalogue & cart',
          kind: 'SERVICE',
          host: 'dummyjson.com',
          x: 60,
          y: 300,
        },
        { key: 'db', label: 'Orders database', kind: 'DATABASE', host: null, x: 60, y: 450 },
        { key: 'cache', label: 'Session cache', kind: 'CACHE', host: null, x: 300, y: 450 },
        {
          key: 'payments',
          label: 'Payment API',
          kind: 'EXTERNAL',
          host: 'httpbin.org',
          x: 420,
          y: 300,
          inferred: true,
        },
      ],
      edges: [
        { from: 'web', to: 'gateway', label: 'HTTPS' },
        { from: 'gateway', to: 'catalog' },
        { from: 'catalog', to: 'db', label: 'SQL' },
        { from: 'catalog', to: 'cache' },
        { from: 'gateway', to: 'payments', inferred: true },
      ],
    },
  },
  {
    name: 'Payment API',
    description: 'Card charges and refunds (demo data; requests are echoed by httpbin.org).',
    baseUrl: 'https://httpbin.org/anything/payments',
    variables: [{ key: 'API_KEY', value: 'sk_test_demo_4eC39HqLyjWDarjtT1zdp7dc', secret: true }],
    endpoints: [
      {
        name: 'Create charge',
        description: 'Charges a card.',
        method: 'POST',
        url: '/charges',
        headers: [
          kv('Content-Type', 'application/json'),
          kv('Idempotency-Key', 'demo-charge-0001'),
        ],
        body: {
          type: 'json',
          content: '{\n  "amount": 4999,\n  "currency": "usd",\n  "source": "tok_visa"\n}',
        },
        auth: { type: 'bearer', token: '{{API_KEY}}' },
        tags: ['charges'],
      },
      {
        name: 'Get charge',
        description: 'Looks up a charge by id.',
        method: 'GET',
        url: '/charges/ch_3NqX8r',
        auth: { type: 'bearer', token: '{{API_KEY}}' },
        tags: ['charges'],
      },
      {
        name: 'Create refund',
        description: 'Refunds part of a charge.',
        method: 'POST',
        url: '/refunds',
        headers: [kv('Content-Type', 'application/json')],
        body: { type: 'json', content: '{\n  "charge": "ch_3NqX8r",\n  "amount": 1500\n}' },
        auth: { type: 'bearer', token: '{{API_KEY}}' },
        tags: ['refunds'],
      },
    ],
    monitors: [
      {
        name: 'Charges API',
        endpoint: 'Get charge',
        type: 'AVAILABILITY',
        intervalSeconds: 300,
        timeoutMs: 5000,
        expectedStatus: null,
        latency: { medianMs: 410, spread: 0.24 },
        sizeBytes: 640,
        rule: {
          name: 'Charges failing',
          metric: 'CONSECUTIVE_FAILURES',
          threshold: 1,
          durationMinutes: 0,
          severity: 'CRITICAL',
        },
        scenarios: [
          {
            kind: 'outage',
            startHoursAgo: 121,
            durationMinutes: 18,
            statusCode: null,
            response: {
              assignee: 'owner',
              steps: [
                { after: 3, by: 'owner', status: 'ACKNOWLEDGED' },
                {
                  after: 11,
                  by: 'owner',
                  comment: 'Requests to the card network time out. Provider status page confirms.',
                },
              ],
            },
          },
          // Still going on: the demo's active incident.
          {
            kind: 'outage',
            startHoursAgo: 0.75,
            durationMinutes: 50,
            statusCode: 502,
            response: {
              assignee: 'owner',
              steps: [
                { after: 5, by: 'teammate', status: 'ACKNOWLEDGED' },
                { after: 8, by: 'teammate', status: 'INVESTIGATING' },
                {
                  after: 14,
                  by: 'teammate',
                  comment:
                    'Seeing 502s from the card network gateway. Ticket opened with the provider.',
                },
              ],
            },
          },
        ],
      },
      {
        name: 'Refunds latency',
        endpoint: 'Create refund',
        type: 'PERFORMANCE',
        intervalSeconds: 600,
        timeoutMs: 5000,
        expectedStatus: 200,
        latencyThresholdMs: 1200,
        latency: { medianMs: 520, spread: 0.22 },
        sizeBytes: 910,
        rule: {
          name: 'Refunds slow',
          metric: 'RESPONSE_TIME',
          threshold: 1200,
          durationMinutes: 20,
          severity: 'LOW',
        },
        scenarios: [{ kind: 'slow', startHoursAgo: 70, durationMinutes: 40, factor: 1.5 }],
      },
    ],
  },
  {
    name: 'Authentication API',
    description: 'Sign-in and sessions (demo data; dummyjson.com demo accounts).',
    baseUrl: 'https://dummyjson.com/auth',
    variables: [
      { key: 'DEMO_USERNAME', value: 'emilys', secret: false },
      { key: 'DEMO_PASSWORD', value: 'emilyspass', secret: true },
    ],
    endpoints: [
      {
        name: 'Login',
        description: 'Exchanges credentials for an access token.',
        method: 'POST',
        url: '/login',
        headers: [kv('Content-Type', 'application/json')],
        body: {
          type: 'json',
          content:
            '{\n  "username": "{{DEMO_USERNAME}}",\n  "password": "{{DEMO_PASSWORD}}",\n  "expiresInMins": 30\n}',
        },
        expectedStatus: 200,
        tags: ['auth'],
      },
      {
        name: 'Current user',
        description: 'The signed-in user; needs a token in ACCESS_TOKEN.',
        method: 'GET',
        url: '/me',
        auth: { type: 'bearer', token: '{{ACCESS_TOKEN}}' },
        tags: ['auth'],
      },
    ],
    monitors: [
      {
        name: 'Login',
        endpoint: 'Login',
        type: 'STATUS',
        intervalSeconds: 300,
        timeoutMs: 5000,
        expectedStatus: 200,
        latency: { medianMs: 260, spread: 0.2 },
        sizeBytes: 1290,
        rule: {
          name: 'Login failing',
          metric: 'CONSECUTIVE_FAILURES',
          threshold: 1,
          durationMinutes: 0,
          severity: 'CRITICAL',
        },
        scenarios: [
          {
            kind: 'outage',
            startHoursAgo: 98,
            durationMinutes: 12,
            statusCode: 500,
            response: {
              assignee: 'owner',
              steps: [
                { after: 2, by: 'owner', status: 'ACKNOWLEDGED' },
                {
                  after: 6,
                  by: 'owner',
                  comment: 'Bad config deploy to the session service; rolling back.',
                },
              ],
            },
          },
        ],
      },
    ],
  },
];
