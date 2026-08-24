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

test('手机端新增后可以通过应用内弹窗删除', async ({ page }) => {
  const note = `新增后删除-${Date.now()}`;
  await page.locator('.nav-btn[data-page="add"]').click();
  await page.locator('#addAmount').fill('45.67');
  await page.locator('#catGrid .cat-chip').first().click();
  await page.locator('#addNote').fill(note);
  await page.locator('#saveBtn').click();

  const item = page.locator('#txnList .txn-item').filter({ hasText: note });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#editTxnModal')).toHaveClass(/show/);

  await page.locator('#editTxnModal').getByRole('button', { name: '删除' }).click();
  await expect(page.locator('#confirmModal')).toHaveClass(/show/);
  await expect(page.locator('#confirmMessage')).toContainText('删除后无法撤销');
  await page.locator('#confirmSubmitBtn').click();

  await expect(page.locator('#confirmModal')).not.toHaveClass(/show/);
  await expect(page.locator('#editTxnModal')).not.toHaveClass(/show/);
  await expect(page.locator('#txnList')).not.toContainText(note);
  await expect.poll(() => page.evaluate(async () => (await dbGetAll('transactions')).length)).toBe(0);
});

test('删除失败会保留编辑窗口并显示具体原因', async ({ page }) => {
  await page.evaluate(async () => {
    await dbPut('transactions', {
      id: 'delete-failure', type: 'expense', amount: 9.99, date: '2026-08-24',
      categoryId: 'e1', categoryName: '餐饮', categoryIcon: '🍜', note: '删除失败测试',
      userId: 'u1', userName: '我', userColor: '#E17055', createdAt: new Date().toISOString(),
    });
    await App.render();
    App._deleteTxnForTest = App.deleteTxn;
    App.deleteTxn = async () => { throw new Error('模拟数据库故障'); };
  });

  await page.locator('#txnList .txn-item').filter({ hasText: '删除失败测试' }).click();
  await page.locator('#editTxnModal').getByRole('button', { name: '删除' }).click();
  await page.locator('#confirmSubmitBtn').click();

  await expect(page.locator('#confirmError')).toContainText('删除失败：模拟数据库故障');
  await expect(page.locator('#confirmError')).toBeVisible();
  await expect(page.locator('#confirmModal')).toHaveClass(/show/);
  await expect(page.locator('#editTxnModal')).toHaveClass(/show/);
  expect(await page.evaluate(async () => (await dbGet('transactions', 'delete-failure'))?.id)).toBe('delete-failure');
  await page.evaluate(() => { App.deleteTxn = App._deleteTxnForTest; });
});

test('热力图默认只统计支出并按地点聚合，可叠加月份和日期筛选', async ({ page }) => {
  const result = await page.evaluate(() => {
    const txns = [
      { type: 'expense', amount: 10, date: '2026-08-01', lat: 22.54301, lng: 114.05791, locationName: '地点A', categoryName: '餐饮' },
      { type: 'expense', amount: 15, date: '2026-08-15', lat: 22.54302, lng: 114.05792, locationName: '地点A', categoryName: '购物' },
      { type: 'expense', amount: 20, date: '2026-07-31', lat: 22.55, lng: 114.06, locationName: '地点B', categoryName: '交通' },
      { type: 'income', amount: 100, date: '2026-08-15', lat: 22.54301, lng: 114.05791, locationName: '地点A', categoryName: '工资' },
    ];
    const defaults = filterMapTransactions(txns);
    const filtered = filterMapTransactions(txns, {
      type: 'expense', month: '2026-08', dateFrom: '2026-08-10', dateTo: '2026-08-31',
    });
    const groups = aggregateMapLocations(defaults);
    return {
      defaultTypes: [...new Set(defaults.map(txn => txn.type))],
      filteredAmounts: filtered.map(txn => txn.amount),
      groups: groups.map(group => ({ locationName: group.locationName, amount: group.amount, count: group.count })),
    };
  });

  expect(result.defaultTypes).toEqual(['expense']);
  expect(result.filteredAmounts).toEqual([15]);
  expect(result.groups).toEqual([
    { locationName: '地点A', amount: 25, count: 2 },
    { locationName: '地点B', amount: 20, count: 1 },
  ]);
  await expect(page.locator('#mapTypeFilter')).toHaveValue('expense');
  await expect(page.locator('#mapLegend')).toContainText('相对金额低');
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
