// apps/frontend/e2e/smoke.spec.ts
//
// Playwright build-and-render smoke test (opt-in via `pnpm test:e2e`, excluded
// from `pnpm -r test`). RED until the SPA (index.html + src/main.tsx + App +
// ChatPanel) exists and builds.
//
// This is NOT a backend-integration test: the webServer in playwright.config.ts
// builds and serves the static bundle, and we only assert the shell mounts and
// the chat panel is present and interactable.

import { test, expect } from '@playwright/test';

test('the SPA builds, serves, and renders an interactable chat panel', async ({ page }) => {
  await page.goto('/');

  // The React shell mounts into #root.
  await expect(page.locator('#root')).not.toBeEmpty();

  // The chat panel exposes an editable question input.
  const input = page.getByRole('textbox').first();
  await expect(input).toBeVisible();
  await input.click();
  await input.fill('What is quantum entanglement?');
  await expect(input).toHaveValue('What is quantum entanglement?');

  // …and a submit control to send the question.
  await expect(page.getByRole('button', { name: /send|ask|submit/i }).first()).toBeVisible();
});
