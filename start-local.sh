#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_KEY="Code8-7"
PROJECT_PARENT="$(basename "$(dirname "$ROOT")")"
if [[ "$PROJECT_PARENT" == *-B ]]; then
  VARIANT="B"
  DEFAULT_STATE_DIR="$HOME/.cache/code8-7-b"
else
  VARIANT="A"
  DEFAULT_STATE_DIR="$HOME/.cache/code8-7-a"
fi

STATE_DIR="${STATE_DIR:-$DEFAULT_STATE_DIR}"
PGDATA="$STATE_DIR/pgdata"
PGSOCKET="$STATE_DIR/pgsocket"
DB_NAME="paper_book_traces_code8_7_$(printf '%s' "$VARIANT" | tr '[:upper:]' '[:lower:]')"
INDEX="$ROOT/apps/web/index.html"
INDEX_BACKUP="$STATE_DIR/index.html.record-backup"
RECORD_AUTH="$ROOT/apps/web/public/record-auth.js"
VITE_RECORD_CONFIG="$ROOT/apps/web/vite.config.record.mjs"
PRISMA_SCHEMA="$ROOT/apps/api/prisma/schema.prisma"
PRISMA_RECORD_SCHEMA="$ROOT/apps/api/prisma/schema.record.prisma"
export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export TZ="Asia/Shanghai"
export SKIP_INSTALL="${SKIP_INSTALL:-0}"

pick_port() {
  node -e 'const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

DB_PORT="${DB_PORT:-$(pick_port)}"
API_PORT="${API_PORT:-$(pick_port)}"
WEB_PORT="${WEB_PORT:-$(pick_port)}"
while [ "$DB_PORT" = "$API_PORT" ] || [ "$DB_PORT" = "$WEB_PORT" ] || [ "$API_PORT" = "$WEB_PORT" ]; do
  DB_PORT="$(pick_port)"
  API_PORT="$(pick_port)"
  WEB_PORT="$(pick_port)"
done

API_URL="http://127.0.0.1:$API_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT"
DATABASE_URL="postgresql://postgres@127.0.0.1:$DB_PORT/$DB_NAME?schema=public"
EMAIL="code8-7-$(printf '%s' "$VARIANT" | tr '[:upper:]' '[:lower:]')@example.test"
PASSWORD="Code8-7-$VARIANT-Repro-2026!"
BOOK_TITLE="Code8-7-修订验收-$VARIANT"

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node.js 22+ is required" >&2; exit 1; }
for tool in initdb pg_ctl psql createdb dropdb python3 curl; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

mkdir -p "$STATE_DIR" "$PGSOCKET" "$ROOT/apps/web/public"
rm -f "$STATE_DIR/api-url" "$STATE_DIR/web-url" "$STATE_DIR/database-url"
if [ ! -f "$INDEX_BACKUP" ]; then cp "$INDEX" "$INDEX_BACKUP"; fi
rm -f "$RECORD_AUTH" "$VITE_RECORD_CONFIG" "$PRISMA_RECORD_SCHEMA"

API_PID=""
WEB_PID=""
PG_STARTED=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  if [ "$PG_STARTED" = "1" ]; then
    pg_ctl -D "$PGDATA" stop -m fast -w >/dev/null 2>&1 || true
  fi
  if [ -f "$INDEX_BACKUP" ]; then cp "$INDEX_BACKUP" "$INDEX" 2>/dev/null || true; fi
  rm -f "$INDEX_BACKUP" "$RECORD_AUTH" "$VITE_RECORD_CONFIG" "$PRISMA_RECORD_SCHEMA" \
    "$STATE_DIR/api-url" "$STATE_DIR/web-url" "$STATE_DIR/database-url" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

if [ "$SKIP_INSTALL" != "1" ]; then
  echo "[$PROJECT_KEY-$VARIANT] installing dependencies"
  (cd "$ROOT" && CI=true npm install --no-audit --no-fund)
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  rm -rf "$PGDATA"
  initdb -D "$PGDATA" -U postgres -A trust --encoding=UTF8 --locale=C --no-sync >"$STATE_DIR/initdb.log" 2>&1
fi
if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" stop -m fast -w >/dev/null 2>&1 || true
fi
pg_ctl -D "$PGDATA" -l "$STATE_DIR/postgres.log" \
  -o "-p $DB_PORT -h 127.0.0.1 -k $PGSOCKET -c shared_buffers=32MB -c max_connections=80 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  -w start >"$STATE_DIR/pg-start.log" 2>&1
PG_STARTED=1
dropdb --if-exists --force -h 127.0.0.1 -p "$DB_PORT" -U postgres "$DB_NAME" >/dev/null 2>&1 || true
createdb -h 127.0.0.1 -p "$DB_PORT" -U postgres "$DB_NAME"

export NODE_ENV=development
export PORT="$API_PORT"
export DATABASE_URL
export SESSION_SECRET="code8-7-$VARIANT-local-session-secret-at-least-32-characters"
export SESSION_TTL_DAYS=30
export COOKIE_SECURE=false
export WEB_ORIGIN="$WEB_URL"
export EXPORT_MAX_ROWS=100000
export UPLOAD_DIR="$STATE_DIR/uploads"
mkdir -p "$UPLOAD_DIR"

echo "[$PROJECT_KEY-$VARIANT] migrating and building API"
python3 - "$PRISMA_SCHEMA" "$PRISMA_RECORD_SCHEMA" <<'PYSCHEMA'
from pathlib import Path
import re
import sys
source = Path(sys.argv[1]).read_text()
# The relation field is not referenced by runtime code. A temporary alias keeps
# the original schema untouched while allowing Prisma to generate the client.
source = re.sub(
    r'(?m)^(\s*)reflection(\s+CompletionReflection\s+@relation\()',
    r'\1completionReflection\2',
    source,
)
Path(sys.argv[2]).write_text(source)
PYSCHEMA
(cd "$ROOT" && npm run db:generate -w @paper-book-traces/api -- --schema prisma/schema.record.prisma >"$STATE_DIR/db-generate.log" 2>&1)
(cd "$ROOT" && npm run db:migrate -w @paper-book-traces/api -- --schema prisma/schema.record.prisma >"$STATE_DIR/db-migrate.log" 2>&1)

(cd "$ROOT" && npm run dev -w @paper-book-traces/api >"$STATE_DIR/api.log" 2>&1) &
API_PID=$!
printf '%s\n' "$API_URL" >"$STATE_DIR/api-url"

cat >"$VITE_RECORD_CONFIG" <<VITECONFIG
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: $WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: '$API_URL', changeOrigin: false },
      '/health': { target: '$API_URL', changeOrigin: false }
    }
  }
});
VITECONFIG

cat >"$RECORD_AUTH" <<AUTHJS
const EMAIL = "$EMAIL";
const PASSWORD = "$PASSWORD";
const BOOK_TITLE = "$BOOK_TITLE";

if (location.pathname === "/__record-login") {
  fetch("/api/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("login " + response.status + " " + (await response.text()));
      const booksResponse = await fetch("/api/v1/books?page=1&pageSize=100", { credentials: "include" });
      if (!booksResponse.ok) throw new Error("books " + booksResponse.status + " " + (await booksResponse.text()));
      const payload = await booksResponse.json();
      const book = payload.items.find((item) => item.title === BOOK_TITLE);
      if (!book) throw new Error("record book not found");
      location.replace("/books/" + book.id);
    })
    .catch((error) => {
      document.body.innerHTML = '<pre style="padding:24px;color:#b42318;white-space:pre-wrap">录制自动登录失败: ' + String(error.message || error) + '</pre>';
    });
}
if (location.pathname.startsWith("/books/")) {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const buttons = Array.from(document.querySelectorAll("button"));
    const reflectionTab = buttons.find((button) => button.textContent.includes("读完感受"));
    if (reflectionTab && !document.querySelector(".revision-history")) reflectionTab.click();

    const historyButton = buttons.find((button) => button.textContent.includes("修订历史"));
    if (historyButton && !historyButton.textContent.includes("收起")) historyButton.click();

    const boxes = Array.from(document.querySelectorAll('.revision-item input[type="checkbox"]'));
    if (boxes.length >= 2 && !boxes[0].checked) {
      const olderIndex = Math.max(0, boxes.length - 3);
      const initialIndex = boxes.length - 1;
      boxes[olderIndex].click();
      boxes[initialIndex].click();
    }
    const compareButton = buttons.find((button) => button.textContent.includes("对比选中的两个版本"));
    if (compareButton && !compareButton.disabled) {
      compareButton.click();
      window.clearInterval(timer);
    }
    if (attempts > 100) window.clearInterval(timer);
  }, 100);
}
AUTHJS

python3 - "$INDEX" <<'PY'
import pathlib, sys
index = pathlib.Path(sys.argv[1])
html = index.read_text()
tag = '<script type="module" src="/record-auth.js"></script>'
if tag not in html:
    html = html.replace('</head>', f'  {tag}\n</head>')
    index.write_text(html)
PY

(
  cd "$ROOT"
  VITE_API_BASE_URL="/api/v1" exec npm run dev -w @paper-book-traces/web -- --config vite.config.record.mjs --host 127.0.0.1
) >"$STATE_DIR/web.log" 2>&1 &
WEB_PID=$!
printf '%s\n' "$WEB_URL" >"$STATE_DIR/web-url"
printf '%s\n' "postgresql://postgres@127.0.0.1:$DB_PORT/$DB_NAME" >"$STATE_DIR/database-url"

wait_for_http() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 240); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.15
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_for_http "$API_URL/health/ready"
wait_for_http "$WEB_URL/"
echo "[$PROJECT_KEY-$VARIANT] DB 127.0.0.1:$DB_PORT API $API_URL Web $WEB_URL"
wait "$API_PID" "$WEB_PID"
