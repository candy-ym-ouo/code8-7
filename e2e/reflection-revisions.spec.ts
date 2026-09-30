import { expect, test } from '@playwright/test';

test('reflection keeps revision history and can restore an older revision', async ({ page }) => {
  const email = `reflection-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('修订之书');
  await page.getByRole('button', { name: '保存书目' }).click();

  await page.getByRole('button', { name: '开始阅读' }).click();
  await page.getByRole('button', { name: '标记为读完' }).click();

  // 初版：被触动 + 一段文字
  await page.getByRole('button', { name: '被触动' }).click();
  await page.getByPlaceholder('不写摘要，只写此刻与你有关的感受。').fill('第一次合上书的感受。');
  await page.getByRole('button', { name: '保存完成感受' }).click();
  await expect(page.getByText('这本书的完成感受已保存')).toBeVisible();

  await page.getByRole('tab', { name: /读完感受/ }).click();
  await expect(page.getByText('第一次合上书的感受。')).toBeVisible();

  // 修订：改为平静，替换文字
  await page.getByRole('button', { name: '修订', exact: true }).click();
  const editor = page.locator('.inline-editor').last();
  await editor.getByRole('button', { name: '平静' }).click();
  await editor.getByRole('button', { name: '被触动' }).click();
  await editor.locator('textarea').fill('隔了几天，心里很平静。');
  await editor.getByRole('button', { name: '保存修订' }).click();
  await expect(page.getByText('完成感受已修订，旧版本保留在历史中可对比与恢复')).toBeVisible();
  await expect(page.getByText('隔了几天，心里很平静。')).toBeVisible();

  // 打开历史：应看到两版，且对比出现新增行
  await page.getByRole('button', { name: '查看修订历史与对比' }).click();
  await expect(page.getByRole('button', { name: '恢复为此版本' })).toBeVisible();
  await expect(page.locator('.diff-added').filter({ hasText: '隔了几天，心里很平静。' })).toBeVisible();

  // 恢复第 1 版为当前内容
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '恢复为此版本' }).first().click();
  await expect(page.getByText('第一次合上书的感受。').first()).toBeVisible();

  // 历史恢复会追加一版，因此列表里有 3 个版本条目
  await expect(page.locator('.revision-item')).toHaveCount(3);
});
