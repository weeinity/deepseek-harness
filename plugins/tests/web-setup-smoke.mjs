/** Run with Playwright's run-code on an authenticated English Web page after dismissing first-use dialogs. */
async page => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const panels = page.getByRole('navigation', { name: 'Global panels' })
  for (const name of ['Dashboard', 'MoYu', 'Taskboard', 'Skill Center', 'Plugins']) {
    await panels.getByRole('button', { name, exact: true }).waitFor()
  }

  await panels.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Personal Work', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Azure DevOps', exact: true }).click()
  await page.getByRole('button', { name: 'Snapshot Q&A', exact: true }).waitFor()

  await panels.getByRole('button', { name: 'MoYu', exact: true }).click()
  await page.getByRole('tab', { name: 'Watchlist', exact: true }).click()
  await page.locator('#stocks-page').waitFor()
  const host = await page.evaluate(async () => {
    const post = async (path, body = {}) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, data: await response.json() }
    }
    const settings = await post('/api/dsh-stocks/settings')
    const state = await post('/api/dsh-stocks/state')
    const invalid = await post('/api/dsh-stocks/quotes', { symbols: ['<script>'] })
    const sidebar = await post('/sidebar/api/settings.get')
    const source = await post('/api/dsh-stocks/source')
    return {
      settings: settings.status === 200 && settings.data.ok === true,
      state: state.status === 200 && state.data.ok === true,
      invalidRejected: invalid.data.ok === false,
      sidebar: sidebar.status === 200 && sidebar.data.ok === true,
      source: source.status === 200 && source.data.license === 'AGPL-3.0-only'
        && typeof source.data.files?.['src/host/index.ts'] === 'string'
        && typeof source.data.files?.['pnpm-lock.yaml'] === 'string',
    }
  })
  for (const [name, passed] of Object.entries(host)) check(passed, `Portable Web Host check failed: ${name}`)

  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'OAuth / Subscriptions', exact: true }).click()
  await settings.getByRole('heading', { name: 'OAuth / subscription plans', exact: true }).waitFor()
  await settings.getByRole('listitem').first().waitFor()
  check(await settings.getByRole('listitem').count() === 6, 'The pinned OAuth provider catalog did not load.')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  return { passed: ['extension navigation', 'Dashboard views', 'MoYu watchlist', ...Object.keys(host), 'OAuth settings'] }
}
