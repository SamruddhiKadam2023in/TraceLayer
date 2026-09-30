import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Automated accessibility checks (spec §46) with axe-core, on the real pages in a real browser,
 * in both themes: WCAG 2.1 A and AA rules, including colour contrast. Automated checks catch
 * only part of what matters (keyboard flows and screen-reader wording are covered by the
 * component tests), but no page may ship with a violation they can find.
 */

const stamp = Date.now();
const user = {
  name: 'A11y Tester',
  email: `e2e-a11y-${stamp}@example.com`,
  password: 'e2e-Str0ng-password',
};
const workspaceName = `E2E a11y ${stamp}`;

async function expectNoViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(summary, `${label}\n${summary.join('\n')}`).toEqual([]);
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => {
    localStorage.setItem('tracelayer-theme', JSON.stringify({ state: { theme: t }, version: 0 }));
  }, theme);
}

for (const theme of ['light', 'dark'] as const) {
  test(`public pages have no accessibility violations (${theme})`, async ({ page }) => {
    await setTheme(page, theme);
    for (const path of ['/welcome', '/login', '/register', '/privacy']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoViolations(page, `${path} (${theme})`);
    }
  });
}

test('signed-in pages have no accessibility violations (light and dark)', async ({
  page,
  request,
}) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill(user.name);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Workspace name').fill(workspaceName);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('dialog').getByLabel('Project name').fill('Orders API');
  await expectNoViolations(page, 'new project dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Orders API', level: 1 })).toBeVisible();
  const project = new URL(page.url()).pathname;

  const pages = [
    ['/', 'Dashboard'],
    ['/projects', 'Projects'],
    ['/incidents', 'Incidents'],
    ['/settings', 'Workspace settings'],
    ['/status', 'System status'],
    [project, 'Orders API'],
    [`${project}/endpoints/new`, 'Orders API'],
    [`${project}/monitors`, 'Orders API'],
    [`${project}/environments`, 'Orders API'],
    [`${project}/dependencies`, 'Orders API'],
  ] as const;
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(
      (t) =>
        localStorage.setItem(
          'tracelayer-theme',
          JSON.stringify({ state: { theme: t }, version: 0 }),
        ),
      theme,
    );
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      // Let lazy content (charts, the map) settle before scanning.
      await page.waitForLoadState('networkidle');
      await expectNoViolations(page, `${path} (${theme})`);
    }
  }

  // Clean up through the API.
  const login = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const workspaces = (await (await request.get('/api/workspaces', { headers })).json()).data as {
    id: string;
    name: string;
  }[];
  for (const ws of workspaces.filter((w) => w.name === workspaceName)) {
    await request.delete(`/api/workspaces/${ws.id}`, { headers });
  }
});
