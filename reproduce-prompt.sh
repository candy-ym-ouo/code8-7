#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_PARENT="$(basename "$(dirname "$ROOT")")"
if [[ "$PROJECT_PARENT" == *-B ]]; then
  VARIANT="B"
  DEFAULT_STATE_DIR="$HOME/.cache/code8-7-b"
else
  VARIANT="A"
  DEFAULT_STATE_DIR="$HOME/.cache/code8-7-a"
fi
STATE_DIR="${STATE_DIR:-$DEFAULT_STATE_DIR}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:3000}"
DB_URL="${DB_URL:-$(cat "$STATE_DIR/database-url")}"
export DB_URL

node --input-type=module - "$API_BASE_URL" "$VARIANT" "$STATE_DIR" <<'NODE'
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2].replace(/\/$/, '');
const variant = process.argv[3];
const stateDir = process.argv[4];
const api = `${base}/api/v1`;
const dbUrl = process.env.DB_URL;
const email = `code8-7-${variant.toLowerCase()}@example.test`;
const password = `Code8-7-${variant}-Repro-2026!`;
const bookTitle = `Code8-7-修订验收-${variant}`;
let cookie = '';
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
}

function absorbCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const pair = String(value).split(';')[0];
    if (pair.startsWith('pbt_session=')) cookie = pair;
  }
}

async function request(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  absorbCookies(response);
  const contentType = response.headers.get('content-type') ?? '';
  const payload = response.status === 204
    ? null
    : contentType.includes('application/json')
      ? await response.json()
      : await response.text();
  return { status: response.status, payload };
}

async function must(method, path, body, expected = [200, 201, 204]) {
  const result = await request(method, path, body);
  if (!expected.includes(result.status)) {
    throw new Error(`${method} ${path} -> ${result.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload;
}

function apiCode(result) {
  return result?.payload?.error?.code ?? 'NONE';
}

function containsAction(result, action) {
  return result.status === 200 && JSON.stringify(result.payload).includes(`"${action}"`);
}

let passed = false;
try {
  const registration = await must('POST', '/auth/register', { email, password }, [201]);
  if (!registration?.user?.id) throw new Error('registration did not return a user');

  const created = await must('POST', '/books', {
    title: bookTitle,
    author: '录制验证',
    pageCount: 300,
    status: 'TO_READ'
  });
  const bookId = created.book.id;

  const reading = await must('PATCH', `/books/${bookId}/status`, {
    status: 'READING',
    version: created.book.version
  });
  const completed = await must('PATCH', `/books/${bookId}/status`, {
    status: 'READ',
    version: reading.book.version,
    reflection: { moodTags: ['MOVED'], text: '第一次合上书的感受。' }
  });
  const reflection = completed.reflection;
  const initialVersion = reflection.version;

  const concurrent = await Promise.all([
    request('PATCH', `/reflections/${reflection.id}`, {
      version: initialVersion,
      moodTags: ['CALM'],
      text: '设备 A 的修订内容。'
    }),
    request('PATCH', `/reflections/${reflection.id}`, {
      version: initialVersion,
      moodTags: ['JOYFUL'],
      text: '设备 B 的修订内容。'
    })
  ]);
  const statuses = concurrent.map((item) => item.status).sort((a, b) => a - b);
  const conflict = concurrent.find((item) => item.status === 409);
  check(
    '七日内多端并发编辑不互相覆盖',
    statuses[0] === 200 && statuses[1] === 409 && apiCode(conflict) === 'STALE_WRITE',
    `并发状态=${statuses.join('/')}，冲突码=${apiCode(conflict)}`
  );

  const activeAfterRace = await must('GET', `/books/${bookId}/reflections`);
  const afterRace = activeAfterRace.items.find((item) => item.id === reflection.id);
  const finalUpdate = await must('PATCH', `/reflections/${reflection.id}`, {
    version: afterRace.version,
    moodTags: ['CALM', 'MOVED'],
    text: '隔了几天，我仍然被这一页触动。'
  });
  const finalReflection = finalUpdate.reflection;

  const staleWrite = await request('PATCH', `/reflections/${reflection.id}`, {
    version: initialVersion,
    text: '过期版本试图覆盖。'
  });
  check(
    '过期页面写入被拒绝',
    staleWrite.status === 409 && apiCode(staleWrite) === 'STALE_WRITE',
    `状态=${staleWrite.status}，错误码=${apiCode(staleWrite)}`
  );

  const historyBeforeDelete = await must('GET', `/reflections/${reflection.id}/revisions`);
  const revisionText = JSON.stringify(historyBeforeDelete);
  check(
    '修订历史保留初版和后续版本',
    historyBeforeDelete.items.length >= 3 && revisionText.includes('第一次合上书的感受。') && revisionText.includes('隔了几天，我仍然被这一页触动。'),
    `版本数=${historyBeforeDelete.items.length}，初版与修订版均存在`
  );

  const deleted = await request('DELETE', `/reflections/${reflection.id}`, { version: finalReflection.version });
  check('最新轮次删除成功', deleted.status === 204, `状态=${deleted.status}`);

  const bookAfterDelete = await must('GET', `/books/${bookId}`);
  check('删除最新轮次后书目回到阅读中', bookAfterDelete.book.status === 'READING', `书目状态=${bookAfterDelete.book.status}`);

  const historyWhileDeleted = await request('GET', `/reflections/${reflection.id}/revisions`);
  check(
    '删除后仍可查看历史并记录删除节点',
    containsAction(historyWhileDeleted, 'DELETED'),
    `历史状态=${historyWhileDeleted.status}，删除节点=${containsAction(historyWhileDeleted, 'DELETED')}`
  );

  const restored = await must('POST', `/reflections/${reflection.id}/restore`);
  const bookAfterRestore = await must('GET', `/books/${bookId}`);
  check(
    '恢复最新轮次后状态与轮次一致',
    bookAfterRestore.book.status === 'READ' && restored.reflection.completionRound === finalReflection.completionRound,
    `书目状态=${bookAfterRestore.book.status}，完成轮次=${restored.reflection.completionRound}`
  );

  const historyAfterRestore = await request('GET', `/reflections/${reflection.id}/revisions`);
  check(
    '恢复历史追加恢复节点且不覆盖旧版本',
    containsAction(historyAfterRestore, 'DELETED') && containsAction(historyAfterRestore, 'RESTORED'),
    `历史状态=${historyAfterRestore.status}，删除节点=${containsAction(historyAfterRestore, 'DELETED')}，恢复节点=${containsAction(historyAfterRestore, 'RESTORED')}`
  );

  execFileSync('psql', [
    dbUrl,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE completion_reflections SET editable_until = now() - interval '1 minute' WHERE id = '${reflection.id}'::uuid;`
  ], { stdio: 'pipe' });

  const expiredUpdate = await request('PATCH', `/reflections/${reflection.id}`, {
    version: restored.reflection.version,
    text: '过期后不应保存。'
  });
  const expiredDelete = await request('DELETE', `/reflections/${reflection.id}`, {
    version: restored.reflection.version
  });
  const expiredHistory = await request('GET', `/reflections/${reflection.id}/revisions`);
  check(
    '超过七天后修订与删除均只读',
    expiredUpdate.status === 409 && apiCode(expiredUpdate) === 'EDIT_WINDOW_EXPIRED' &&
      expiredDelete.status === 409 && apiCode(expiredDelete) === 'EDIT_WINDOW_EXPIRED',
    `修订=${expiredUpdate.status}/${apiCode(expiredUpdate)}，删除=${expiredDelete.status}/${apiCode(expiredDelete)}`
  );
  check(
    '过期后仍可读取修订历史',
    expiredHistory.status === 200 && JSON.stringify(expiredHistory).includes('第一次合上书的感受。'),
    `历史状态=${expiredHistory.status}`
  );

  writeFileSync(join(stateDir, 'book-id'), `${bookId}\n`);
  writeFileSync(join(stateDir, 'reflection-id'), `${reflection.id}\n`);
  passed = checks.every((item) => item.ok);
  const summary = passed
    ? '并发防覆盖、不可变修订历史、删除恢复状态轮次一致、过期只读全部通过。'
    : '检测到修订历史或生命周期一致性缺陷；详见上方失败项。';
  console.log(`[repro Code8-7-${variant}] ${passed ? 'PASS' : 'FAIL'}: ${summary}`);
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[repro Code8-7-${variant}] FAIL: ${detail}`);
  process.exitCode = 2;
}

if (!passed && !process.exitCode) process.exitCode = 1;
NODE
