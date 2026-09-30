import { expect, test } from '@playwright/test';

test('new user can create a book and keep a dog ear', async ({ page }) => {
  const email = `acceptance-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await expect(page.getByRole('heading', { name: '我的书' })).toBeVisible();
  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('验收测试书');
  await page.getByLabel('总页数').fill('300');
  await page.getByRole('button', { name: '保存书目' }).click();

  await expect(page.getByRole('heading', { name: '验收测试书' })).toBeVisible();
  await page.getByRole('button', { name: '记一次折角' }).click();
  await page.getByLabel('页码').fill('42');
  await page.getByLabel('折角原因（可选）').fill('这一页与当下有关。');
  await page.getByRole('button', { name: '保存痕迹' }).click();

  await expect(page.getByText('第 42 页').first()).toBeVisible();
  await expect(page.getByText('这一页与当下有关。')).toBeVisible();
});

test('completion reflection keeps revision history and rejects stale multi-device writes', async ({ page }) => {
  const email = `revision-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('修订验收书');
  await page.getByRole('button', { name: '保存书目' }).click();

  await page.getByRole('button', { name: '开始阅读' }).click();
  await page.getByRole('button', { name: '标记为读完' }).click();
  await page.getByRole('button', { name: /被触动|喜悦/ }).first().click();
  await page.getByPlaceholder('不写摘要，只写此刻与你有关的感受。').fill('第一次读完的感受');
  await page.getByRole('button', { name: '保存完成感受' }).click();

  await page.getByRole('tab', { name: /读完感受/ }).click();
  await page.getByRole('button', { name: '修订' }).click();
  await page.getByLabel('感受').fill('修订后的感受');
  await page.getByRole('button', { name: '保存修订' }).click();
  await expect(page.getByText('完成感受已修订')).toBeVisible();

  await page.getByRole('button', { name: /修订历史/ }).click();
  await expect(page.getByText('第 1 版 · 初次记录')).toBeVisible();
  await expect(page.getByText('第 2 版 · 内容修订')).toBeVisible();

  // 勾选两个版本后可看到差异：旧句被删除、无纯覆盖。
  await page.locator('.revision-item input[type="checkbox"]').nth(1).check();
  await page.locator('.revision-item input[type="checkbox"]').nth(0).check();
  await page.getByRole('button', { name: '对比选中的两个版本' }).click();
  await expect(page.locator('del.diff-removed')).toContainText('第一次读完的感受');
  await expect(page.locator('ins.diff-added')).toContainText('修订后的感受');

  // 恢复到第 1 版后，正文还原，同时第 3 版被追加进历史。
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '恢复为此版本' }).first().click();
  await expect(page.getByText('已恢复为第 1 版')).toBeVisible();
  await expect(page.getByText('第 3 版 · 恢复历史版本')).toBeVisible();

  // 删除最大轮次后，书目状态回到“阅读中”；已删除感受仍列在同页，7 天内可撤销。
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('heading', { name: '已删除的完成感受' })).toBeVisible();
  await expect(page.getByText('阅读中')).toBeVisible();
  await page.getByRole('button', { name: '撤销删除' }).click();
  await expect(page.getByText('已读完')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已删除的完成感受' })).toHaveCount(0);
});
