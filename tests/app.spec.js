const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#currentUserName')).toHaveText('我');
});

test('六个底部页面都可以切换', async ({ page }) => {
  for (const name of ['home', 'add', 'stats', 'yearly', 'map', 'settings']) {
    await page.locator(`.nav-btn[data-page="${name}"]`).click();
    await expect(page.locator(`#page-${name}`)).toHaveClass(/active/);
    await expect(page.locator(`.nav-btn[data-page="${name}"]`)).toHaveClass(/active/);
  }
});

test('手机端可以新增一笔支出', async ({ page }) => {
  await page.locator('.nav-btn[data-page="add"]').click();
  await page.locator('#addAmount').fill('12.34');
  await page.locator('#catGrid .cat-chip').first().click();
  await page.locator('#addNote').fill('自动化测试');
  await page.locator('#saveBtn').click();

  await expect(page.locator('#page-home')).toHaveClass(/active/);
  await expect(page.locator('#txnList')).toContainText('自动化测试');
  await expect(page.locator('#txnList')).toContainText('12.34');
});

test('旧版备份可迁移，未知新版和重复键会被拒绝', async ({ page }) => {
  const result = await page.evaluate(() => {
    const legacy = normalizeBackupData({
      transactions: [],
      categories: [],
      users: [],
      settings: [{ id: 'currentUser', value: 'u1' }],
      badges: [],
      wishes: [],
      recurring: [],
    });
    const messages = [];
    for (const raw of [
      { formatVersion: 999 },
      { settings: [{ key: 'x', value: 1 }, { id: 'x', value: 2 }] },
    ]) {
      try { normalizeBackupData(raw); } catch (error) { messages.push(error.message); }
    }
    return {
      version: legacy.formatVersion,
      setting: legacy.settings[0],
      defaults: [legacy.users.length, legacy.categories.length],
      messages,
    };
  });

  expect(result.version).toBe(2);
  expect(result.setting).toEqual({ key: 'currentUser', value: 'u1' });
  expect(result.defaults[0]).toBeGreaterThan(0);
  expect(result.defaults[1]).toBeGreaterThan(0);
  expect(result.messages).toHaveLength(2);
});

test('整库替换失败会回滚，替换前可创建并恢复快照', async ({ page }) => {
  const rolledBack = await page.evaluate(async () => {
    const original = await App.collectAllData();
    original.transactions = [{
      id: 'original', type: 'expense', amount: 8, date: '2026-08-24',
      categoryId: 'e1', categoryName: '餐饮', categoryIcon: '🍜',
      userId: 'u1', userName: '我', userColor: '#E17055', createdAt: new Date().toISOString(),
    }];
    await App.replaceWithBackup(original, { reason: '测试初始数据' });

    const invalid = await App.collectAllData();
    invalid.transactions = [];
    invalid.settings = [{ value: '缺少主键，应触发整个事务回滚' }];
    try { await dbReplaceAll(invalid); } catch (_) {}
    const afterFailure = await dbGetAll('transactions');

    const replacement = await App.collectAllData();
    replacement.transactions = [];
    await App.replaceWithBackup(replacement, { reason: '测试替换' });
    return afterFailure.length === 1 && afterFailure[0].id === 'original';
  });

  expect(rolledBack).toBe(true);
  expect(await page.evaluate(() => dbGetAll('transactions'))).toHaveLength(0);
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(() => App.restoreLatestSnapshot());
  await expect.poll(() => page.evaluate(async () => (await dbGetAll('transactions')).length)).toBe(1);
});

test('Token 默认只保存到会话，可主动清除', async ({ page }) => {
  await page.locator('.nav-btn[data-page="settings"]').click();
  await page.getByText('GitHub Gist 跨设备同步').click();
  await page.locator('#syncToken').fill('test_token');
  await page.evaluate(() => App.saveSyncTokenFromInput());
  expect(await page.evaluate(() => sessionStorage.getItem('ledgerSyncToken'))).toBe('test_token');
  expect(await page.evaluate(() => localStorage.getItem('ledgerSyncToken'))).toBeNull();

  await page.getByRole('button', { name: '清除本机 Token' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('ledgerSyncToken'))).toBeNull();
});
