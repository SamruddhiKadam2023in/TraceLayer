import { expect, test, type Page } from '@playwright/test';

/**
 * The critical flow from spec §47, through the real UI and stack:
 * register → login → workspace → project → environment → endpoint → execute → monitor → run →
 * metrics → alert → incident → resolve. Each run uses a new account and deletes its workspace at
 * the end, so runs are independent and leave nothing behind.
 */

const upstream = process.env.E2E_UPSTREAM_URL || 'https://httpbin.org';
const stamp = Date.now();
const user = {
  name: 'E2E Tester',
  email: `e2e-${stamp}@example.com`,
  password: 'e2e-Str0ng-password',
};
const workspaceName = `E2E ${stamp}`;
const projectName = 'Orders API';
const endpointName = 'Health check';
const monitorName = 'Orders health';

/**
 * Safety net: if the flow failed before its own clean-up step, delete the workspace through the
 * API so failed runs do not pile up.
 */
test.afterEach(async ({ request }) => {
  const login = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  if (!login.ok()) return;
  const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const workspaces = await (await request.get('/api/workspaces', { headers })).json();
  for (const ws of workspaces.data as { id: string; name: string }[]) {
    if (ws.name === workspaceName) await request.delete(`/api/workspaces/${ws.id}`, { headers });
  }
});

/** A project tab (Endpoints, Monitors, …) in the project header. */
const openTab = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Project' })
    .getByRole('link', { name, exact: true })
    .click();

test('critical flow: from registration to a resolved incident', async ({ browser }) => {
  await test.step('Register', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/register');
    await page.getByLabel('Name').fill(user.name);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(user.password);
    await page.getByLabel('Confirm password').fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
    await context.close();
  });

  // A fresh browser context: nothing is remembered from registration.
  const context = await browser.newContext();
  const page = await context.newPage();

  await test.step('Login', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
  });

  await test.step('Create workspace', async () => {
    await page.getByLabel('Workspace name').fill(workspaceName);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // The live connection comes up for the new workspace.
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  });

  await test.step('Create project', async () => {
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByLabel('Project name').fill(projectName);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: projectName, level: 1 })).toBeVisible();
  });

  await test.step('Create environment', async () => {
    // Projects start with Development, Staging and Production (no base URLs); add one that
    // points at the upstream API.
    await openTab(page, 'Environments');
    await page.getByRole('button', { name: 'New environment' }).click();
    const dialog = page.getByRole('dialog', { name: 'New environment' });
    await dialog.getByLabel('Name').fill('Live');
    await dialog.getByLabel('Base URL').fill(upstream);
    await dialog.getByRole('button', { name: 'Create environment' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(upstream.replace(/\/+$/, ''))).toBeVisible();
  });

  await test.step('Create endpoint', async () => {
    await openTab(page, 'Endpoints');
    await page.getByRole('link', { name: 'New endpoint' }).first().click();
    await page.getByLabel('Name').fill(endpointName);
    await page.getByLabel('Method').selectOption('GET');
    await page.getByLabel('URL').fill('/status/200');
    await page.getByRole('button', { name: 'Create endpoint' }).click();
    await expect(page.getByRole('heading', { name: endpointName })).toBeVisible();
  });

  await test.step('Execute API', async () => {
    await page.getByLabel('Run in environment').selectOption({ label: 'Live' });
    await page.getByRole('button', { name: 'Send' }).click();
    const viewer = page.getByTestId('response-viewer');
    await expect(viewer.getByText(/^200\b/)).toBeVisible();
  });

  await test.step('Create monitor', async () => {
    await openTab(page, 'Monitors');
    await page.getByRole('link', { name: 'New monitor' }).first().click();
    await page.getByLabel('Name').fill(monitorName);
    await page.getByLabel('Check every').selectOption('60');
    await page.getByLabel('Endpoint').selectOption({ label: `GET ${endpointName}` });
    await page.getByLabel('Environment').selectOption({ label: 'Live' });
    await page.getByLabel(/^Status/).check();
    await page.getByRole('button', { name: 'Create monitor' }).click();
    await expect(page.getByRole('heading', { name: monitorName })).toBeVisible();
  });

  await test.step('Run monitor', async () => {
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByText('Pass', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  });

  await test.step('View metrics', async () => {
    const metrics = page.getByRole('region', { name: 'Key metrics' });
    await expect(metrics).toBeVisible();
    await expect(metrics.getByText(/^100(\.0+)?%$/).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step('Trigger alert', async () => {
    // Alert on any failed check.
    await page.getByRole('button', { name: 'New rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New alert rule' });
    await dialog.getByLabel('Name').fill('Any failure');
    await dialog.getByLabel('When').selectOption('CONSECUTIVE_FAILURES');
    await dialog.getByLabel(/^Threshold/).fill('0');
    await dialog.getByLabel('Severity').selectOption('HIGH');
    await dialog.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByTestId('rule-Any failure')).toBeVisible();

    // Break the upstream call the monitor makes.
    await openTab(page, 'Endpoints');
    await page.getByRole('link', { name: endpointName }).first().click();
    await page.getByLabel('URL').fill('/status/503');
    await page.getByRole('button', { name: 'Save changes' }).click();
    // Saved: the form is clean again, so saving is disabled.
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await openTab(page, 'Monitors');
    await page.getByRole('link', { name: monitorName }).first().click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByText('Fail', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('rule-Any failure').getByText('Firing')).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step('View incident', async () => {
    // The incident arrives live, as a notification.
    const notifications = page.getByRole('region', { name: 'Notifications' });
    await expect(notifications.getByRole('link', { name: /Incident #1 opened/ })).toBeVisible();

    await openTab(page, 'Incidents');
    const row = page.getByTestId('incident-row').first();
    await expect(row).toContainText('#1');
    await expect(row).toContainText('Open');
    await row.getByRole('link').click();
    await expect(
      page.getByRole('heading', { name: new RegExp(`#1 ${monitorName}`) }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Timeline' })).toContainText('Incident detected');
  });

  await test.step('Resolve incident', async () => {
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
      'Status changed from Open to Acknowledged',
    );
    await page.getByLabel('Add a comment').fill('Upstream returned 503; fixed the endpoint.');
    await page.getByRole('button', { name: 'Comment' }).click();
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByText(`by ${user.name}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  await test.step('Clean up: delete the workspace', async () => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Delete workspace' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(`Type ${workspaceName} to confirm`).fill(workspaceName);
    await dialog.getByRole('button', { name: 'Delete workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
  });

  await context.close();
});
