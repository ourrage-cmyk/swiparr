<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAiStore } from '@/stores/aiStore'
import { useUiStore } from '@/stores/ui'
import AppHeader from '@/components/AppHeader.vue'

const aiStore = useAiStore()
const uiStore = useUiStore()

const minimumTrainingPoints = 5
const loading = ref(true)
const saving = ref(false)
const running = ref(false)
const trainingStats = ref({ total: 0, good: 0, bad: 0, qualityPoints: 0 })
const lastRunResult = ref<Record<string, unknown> | null>(null)
const recentLogs = ref<string[]>([])

const settings = ref({
  autoArchive: false,
  autoArchiveConfidenceThreshold: 0.2,
  autoArchiveBatchSize: 25,
  autoArchiveScanBatchSize: 40,
  autoArchiveScanBatchesPerRun: 3,
  autoArchiveCronExpression: '0 * * * *',
  triageBatchSize: 60,
})

const cronPresets = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Daily at 02:00', value: '0 2 * * *' },
  { label: 'Daily at 03:00', value: '0 3 * * *' },
]

const selectedCronPreset = computed(() => {
  const match = cronPresets.find((preset) => preset.value === settings.value.autoArchiveCronExpression)
  return match ? match.value : 'custom'
})

const estimatedScanCount = computed(() => settings.value.autoArchiveScanBatchSize * settings.value.autoArchiveScanBatchesPerRun)
const thresholdLabel = computed(() => settings.value.autoArchiveConfidenceThreshold.toFixed(2))

function applyCronPreset(value: string) {
  if (value !== 'custom') {
    settings.value.autoArchiveCronExpression = value
  }
}

async function loadData() {
  loading.value = true
  try {
    const [appSettings, stats] = await Promise.all([
      aiStore.fetchSettings(),
      aiStore.fetchStats(),
    ])
    const logs = await aiStore.fetchLogs().catch(() => ({ lines: [] }))

    settings.value = {
      ...settings.value,
      ...appSettings,
    }
    trainingStats.value = stats
    recentLogs.value = Array.isArray(logs.lines) ? logs.lines : []
  } catch (e) {
    console.error('Failed to load settings:', e)
    uiStore.toast('Failed to load settings.', 'error')
  } finally {
    loading.value = false
  }
}

async function saveSettings(message: string = 'Settings saved.') {
  saving.value = true
  try {
    const response = await aiStore.saveSettings(settings.value)
    settings.value = {
      ...settings.value,
      ...(response.settings || {}),
    }
    uiStore.toast(message, 'success', 2200)
  } catch (e) {
    console.error('Failed to save settings:', e)
    uiStore.toast('Failed to save settings.', 'error')
    throw e
  } finally {
    saving.value = false
  }
}

async function executeAutoArchive(dryRun: boolean) {
  running.value = true
  try {
    await saveSettings(dryRun ? 'Settings saved. Running dry run...' : 'Settings saved. Running cron job now...')
    lastRunResult.value = await aiStore.runAutoArchive(dryRun)
    await loadData()
    uiStore.toast(dryRun ? 'Dry run completed.' : 'Auto-archive run completed.', 'success', 2200)
  } catch (e) {
    console.error('Failed to execute auto-archive:', e)
    uiStore.toast('Failed to run auto-archive.', 'error')
  } finally {
    running.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="viewport-fit flex flex-col" :class="uiStore.isDarkMode ? 'bg-black text-white' : 'bg-white text-black'">
    <AppHeader />
    <main class="flex-1 overflow-y-auto px-4 py-6">
      <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section>
          <h1 class="text-2xl font-bold">Settings</h1>
          <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
            Configure triage batch size, cron timing, scan limits, and archive confidence. The backend enforces safe caps so requests stay within reasonable Immich API limits.
          </p>
        </section>

        <section class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
          <h2 class="text-lg font-semibold">Training State</h2>
          <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
            Manual vectors: {{ trainingStats.total }} total, {{ trainingStats.good }} keep, {{ trainingStats.bad }} archive.
            Cron only becomes useful after at least {{ minimumTrainingPoints }} manual decisions.
          </p>
          <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
            Adaptive quality labels: {{ trainingStats.qualityPoints }} vectors with learned quality features.
          </p>
        </section>

        <section v-if="loading" class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
          <p>Loading settings...</p>
        </section>

        <template v-else>
          <section class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
            <h2 class="text-lg font-semibold">Triage</h2>
            <label class="mt-4 block text-sm font-medium" for="triageBatchSize">Triage grid batch size</label>
            <input
              id="triageBatchSize"
              v-model.number="settings.triageBatchSize"
              type="number"
              min="12"
              max="250"
              class="mt-2 w-full rounded-xl border px-3 py-2"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
            />
            <p class="mt-2 text-xs" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
              Controls how many images the triage grid requests and scores per load. Safe range: 12-250.
            </p>
          </section>

          <section class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
            <h2 class="text-lg font-semibold">Auto-Archive</h2>

            <label class="mt-4 flex items-center gap-3 text-sm font-medium">
              <input v-model="settings.autoArchive" type="checkbox" class="h-4 w-4" />
              Enable server-side auto-archive cron
            </label>

            <label class="mt-5 block text-sm font-medium">Confidence threshold</label>
            <div class="mt-2 flex items-center gap-4">
              <input
                v-model.number="settings.autoArchiveConfidenceThreshold"
                type="range"
                min="0"
                max="1"
                step="0.05"
                class="w-full"
              />
              <span class="min-w-12 text-right font-mono text-sm">{{ thresholdLabel }}</span>
            </div>
            <p class="mt-2 text-xs" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
              Lower values are stricter. Higher values archive more aggressively.
            </p>

            <label class="mt-5 block text-sm font-medium" for="autoArchiveBatchSize">Maximum archives per run</label>
            <input
              id="autoArchiveBatchSize"
              v-model.number="settings.autoArchiveBatchSize"
              type="number"
              min="1"
              max="100"
              class="mt-2 w-full rounded-xl border px-3 py-2"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
            />

            <label class="mt-5 block text-sm font-medium" for="autoArchiveScanBatchSize">Images per Immich scan request</label>
            <input
              id="autoArchiveScanBatchSize"
              v-model.number="settings.autoArchiveScanBatchSize"
              type="number"
              min="10"
              max="250"
              class="mt-2 w-full rounded-xl border px-3 py-2"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
            />

            <label class="mt-5 block text-sm font-medium" for="autoArchiveScanBatchesPerRun">Scan requests per cron run</label>
            <input
              id="autoArchiveScanBatchesPerRun"
              v-model.number="settings.autoArchiveScanBatchesPerRun"
              type="number"
              min="1"
              max="10"
              class="mt-2 w-full rounded-xl border px-3 py-2"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
            />

            <p class="mt-2 text-xs" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
              Estimated candidates scanned per run: {{ estimatedScanCount }} images.
            </p>

            <label class="mt-5 block text-sm font-medium" for="cronPreset">Cron schedule preset</label>
            <select
              id="cronPreset"
              :value="selectedCronPreset"
              class="mt-2 w-full rounded-xl border px-3 py-2"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
              @change="applyCronPreset(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="preset in cronPresets" :key="preset.value" :value="preset.value">
                {{ preset.label }}
              </option>
              <option value="custom">Custom cron expression</option>
            </select>

            <label class="mt-5 block text-sm font-medium" for="autoArchiveCronExpression">Cron expression</label>
            <input
              id="autoArchiveCronExpression"
              v-model="settings.autoArchiveCronExpression"
              type="text"
              class="mt-2 w-full rounded-xl border px-3 py-2 font-mono"
              :class="uiStore.isDarkMode ? 'border-gray-700 bg-black text-white' : 'border-gray-300 bg-white text-black'"
            />
            <p class="mt-2 text-xs" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
              Uses standard 5-field cron syntax, for example <span class="font-mono">0 * * * *</span> for hourly or <span class="font-mono">0 3 * * *</span> for daily at 03:00.
            </p>
          </section>

          <section class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
            <div class="flex flex-wrap gap-3">
              <button
                class="rounded-xl bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                :disabled="saving || running"
                @click="saveSettings()"
              >
                Save settings
              </button>
              <button
                class="rounded-xl border px-4 py-2 font-medium transition-colors disabled:opacity-50"
                :class="uiStore.isDarkMode ? 'border-gray-700 hover:bg-gray-900' : 'border-gray-300 hover:bg-gray-100'"
                :disabled="saving || running"
                @click="executeAutoArchive(true)"
              >
                Dry run now
              </button>
              <button
                class="rounded-xl border px-4 py-2 font-medium transition-colors disabled:opacity-50"
                :class="uiStore.isDarkMode ? 'border-gray-700 hover:bg-gray-900' : 'border-gray-300 hover:bg-gray-100'"
                :disabled="saving || running"
                @click="executeAutoArchive(false)"
              >
                Run now
              </button>
            </div>

            <div v-if="lastRunResult" class="mt-5 rounded-xl border p-4 text-sm"
              :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/50 text-gray-300' : 'border-gray-200 bg-white text-gray-700'"
            >
              <p><strong>Last run:</strong> {{ lastRunResult.skipped ? 'Skipped' : 'Completed' }}</p>
              <p v-if="'reason' in lastRunResult"><strong>Reason:</strong> {{ lastRunResult.reason }}</p>
              <p v-if="'scannedCount' in lastRunResult"><strong>Scanned:</strong> {{ lastRunResult.scannedCount }}</p>
              <p v-if="'archivedCount' in lastRunResult"><strong>Archived:</strong> {{ lastRunResult.archivedCount }}</p>
              <p v-if="'threshold' in lastRunResult"><strong>Threshold:</strong> {{ lastRunResult.threshold }}</p>
              <p v-if="'albumAddFailedCount' in lastRunResult"><strong>Album add failures:</strong> {{ lastRunResult.albumAddFailedCount }}</p>
            </div>

            <div class="mt-5 rounded-xl border p-4 text-sm"
              :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/50 text-gray-300' : 'border-gray-200 bg-white text-gray-700'"
            >
              <div class="flex items-center justify-between gap-3">
                <p><strong>Recent backend logs</strong></p>
                <button
                  class="rounded-lg border px-3 py-1 text-xs transition-colors"
                  :class="uiStore.isDarkMode ? 'border-gray-700 hover:bg-gray-900' : 'border-gray-300 hover:bg-gray-100'"
                  @click="loadData()"
                >
                  Refresh
                </button>
              </div>
              <pre class="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap font-mono text-xs">{{ recentLogs.length ? recentLogs.join('\n') : 'No logs yet.' }}</pre>
            </div>
          </section>
        </template>
      </div>
    </main>
  </div>
</template>