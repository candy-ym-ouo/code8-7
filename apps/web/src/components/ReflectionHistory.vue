<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ApiError } from '../api/client';
import { diffMoodTags, diffText } from '../api/diff';
import { reflectionApi } from '../api';
import { formatDateTime } from '../api/format';
import { MOOD_LABELS, type DiffSegment, type MoodTag, type Reflection, type ReflectionRevision } from '../types/domain';

const props = defineProps<{ reflection: Reflection; editable: boolean }>();
const emit = defineEmits<{
  restored: [];
  notify: [message: string];
  failed: [message: string];
}>();

const open = ref(false);
const loading = ref(false);
const busy = ref(false);
const revisions = ref<ReflectionRevision[]>([]);
const selected = ref<Record<string, boolean>>({});
const comparePair = ref<{ from: ReflectionRevision; to: ReflectionRevision } | null>(null);

const sortedRevisions = computed(() => [...revisions.value].sort((a, b) => b.revisionNo - a.revisionNo));
const selectedIds = computed(() => Object.keys(selected.value).filter((id) => selected.value[id]));

// 其他端（或本页其他操作）改变了版本后，保持历史面板内容最新。
watch(
  () => props.reflection.version,
  async () => {
    if (open.value) await loadRevisions();
  }
);

function moodLabel(tag: MoodTag): string {
  return MOOD_LABELS[tag] ?? tag;
}

async function toggleHistory(): Promise<void> {
  open.value = !open.value;
  comparePair.value = null;
  if (open.value && revisions.value.length === 0) {
    await loadRevisions();
  }
}

async function loadRevisions(): Promise<void> {
  loading.value = true;
  try {
    const result = await reflectionApi.revisions(props.reflection.id);
    revisions.value = result.items;
  } catch (caught) {
    emit('failed', caught instanceof ApiError ? caught.message : '修订历史加载失败');
    open.value = false;
  } finally {
    loading.value = false;
  }
}

function toggleSelected(revision: ReflectionRevision): void {
  const next = { ...selected.value };
  if (next[revision.id]) {
    delete next[revision.id];
  } else {
    if (selectedIds.value.length >= 2) {
      delete next[selectedIds.value[0]];
    }
    next[revision.id] = true;
  }
  selected.value = next;
  comparePair.value = null;
}

function compareSelected(): void {
  const ids = selectedIds.value;
  if (ids.length !== 2) return;
  const [first, second] = ids
    .map((id) => revisions.value.find((revision) => revision.id === id))
    .filter((revision): revision is ReflectionRevision => Boolean(revision))
    .sort((a, b) => a.revisionNo - b.revisionNo);
  // 优先使用后端计算结果；网络失败时退回本地相同算法。
  reflectionApi
    .revisionDiff(props.reflection.id, first.id, second.id)
    .then((result) => {
      comparePair.value = { from: result.from, to: result.to };
    })
    .catch(() => {
      comparePair.value = { from: first, to: second };
    });
}

function textSegments(from: ReflectionRevision, to: ReflectionRevision): DiffSegment[] {
  return diffText(from.text, to.text);
}

function moodChanges(from: ReflectionRevision, to: ReflectionRevision) {
  return diffMoodTags(from.moodTags, to.moodTags);
}

async function restoreRevision(revision: ReflectionRevision): Promise<void> {
  if (!props.editable) return;
  if (!window.confirm(`将当前感受恢复为第 ${revision.revisionNo} 版（${revision.actionLabel}）的内容吗？当前内容会另存为新版本，不会丢失。`)) {
    return;
  }
  busy.value = true;
  try {
    await reflectionApi.restoreRevision(props.reflection.id, revision.id, props.reflection.version);
    await loadRevisions();
    comparePair.value = null;
    selected.value = {};
    emit('restored');
    emit('notify', `已恢复为第 ${revision.revisionNo} 版，当前内容已留存在历史中`);
  } catch (caught) {
    emit('failed', caught instanceof ApiError ? caught.message : '恢复历史版本失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="revision-history">
    <button class="text-button" type="button" @click="toggleHistory">
      {{ open ? '收起修订历史' : `修订历史（${reflection.version} 版）` }}
    </button>

    <div v-if="open" class="revision-panel">
      <p v-if="loading" class="muted">正在读取修订历史…</p>
      <template v-else>
        <p class="muted">
          每次修订、删除与恢复都会追加一条历史，旧内容不会被覆盖。勾选两个版本可对比差异。
        </p>
        <ul class="revision-list">
          <li v-for="revision in sortedRevisions" :key="revision.id" class="revision-item">
            <label class="revision-check">
              <input
                :checked="Boolean(selected[revision.id])"
                type="checkbox"
                :disabled="busy"
                @change="toggleSelected(revision)"
              />
            </label>
            <div class="revision-body">
              <div class="revision-heading">
                <span class="trace-type">第 {{ revision.revisionNo }} 版 · {{ revision.actionLabel }}</span>
                <time>{{ formatDateTime(revision.createdAt) }}</time>
              </div>
              <div class="mood-list">
                <span v-for="tag in revision.moodTags" :key="tag" class="mood-chip selected">
                  {{ moodLabel(tag) }}
                </span>
                <span v-if="revision.moodTags.length === 0" class="muted">（删除节点，无情绪标签）</span>
              </div>
              <p v-if="revision.action !== 'DELETED'" class="preserve-text revision-text">
                {{ revision.text || '当时没有写下更多文字。' }}
              </p>
              <p v-else class="muted revision-text">该节点记录了一次删除操作，不能恢复为正文。</p>
              <button
                v-if="editable && revision.action !== 'DELETED'"
                class="text-button"
                type="button"
                :disabled="busy"
                @click="restoreRevision(revision)"
              >
                恢复为此版本
              </button>
            </div>
          </li>
        </ul>
        <div class="form-actions">
          <button
            class="button button-quiet"
            type="button"
            :disabled="selectedIds.length !== 2 || busy"
            @click="compareSelected"
          >
            对比选中的两个版本
          </button>
          <button
            v-if="comparePair"
            class="button button-quiet"
            type="button"
            @click="comparePair = null"
          >
            关闭对比
          </button>
        </div>

        <section v-if="comparePair" class="diff-panel" aria-label="修订对比">
          <h4>
            第 {{ comparePair.from.revisionNo }} 版 → 第 {{ comparePair.to.revisionNo }} 版
          </h4>
          <div class="diff-moods">
            <span
              v-for="tag in moodChanges(comparePair.from, comparePair.to).removed"
              :key="`removed-${tag}`"
              class="mood-chip diff-removed"
            >移除 {{ moodLabel(tag) }}</span>
            <span
              v-for="tag in moodChanges(comparePair.from, comparePair.to).added"
              :key="`added-${tag}`"
              class="mood-chip diff-added"
            >新增 {{ moodLabel(tag) }}</span>
            <span v-if="
              moodChanges(comparePair.from, comparePair.to).added.length === 0 &&
              moodChanges(comparePair.from, comparePair.to).removed.length === 0
            " class="muted">情绪标签没有变化</span>
          </div>
          <p class="preserve-text diff-text">
            <template v-for="(segment, index) in textSegments(comparePair.from, comparePair.to)" :key="index">
              <span v-if="segment.op === 'EQUAL'">{{ segment.text }}</span>
              <del v-else-if="segment.op === 'REMOVED'" class="diff-removed">{{ segment.text }}</del>
              <ins v-else class="diff-added">{{ segment.text }}</ins>
            </template>
          </p>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.revision-history {
  margin-top: 8px;
}

.revision-panel {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.02);
}

.revision-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.revision-item {
  display: flex;
  gap: 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--color-surface, #fff);
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.revision-check {
  padding-top: 4px;
}

.revision-body {
  flex: 1;
  min-width: 0;
}

.revision-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.9rem;
}

.revision-text {
  margin: 6px 0;
}

.diff-panel {
  margin-top: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.diff-panel h4 {
  margin: 0 0 8px;
}

.diff-moods {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.diff-added {
  background: rgba(46, 125, 80, 0.14);
  color: #1b5e3f;
  text-decoration: none;
}

.diff-removed {
  background: rgba(180, 60, 60, 0.12);
  color: #8a2b2b;
}

ins.diff-added {
  text-decoration: underline;
}
</style>
