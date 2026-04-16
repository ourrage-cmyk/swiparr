<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useAiStore } from '@/stores/aiStore'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import AppHeader from '@/components/AppHeader.vue'
import type { ScoredAsset } from '@/types/immich'

const aiStore = useAiStore()
const uiStore = useUiStore()
const authStore = useAuthStore()

type TriageItem = ScoredAsset & { selected: boolean }

const loading = ref(true)
const items = ref<TriageItem[]>([])
const stats = ref({ total: 0, good: 0, bad: 0 })
const triageBatchSize = ref(60)
const DEFAULT_TRIAGE_CUTOFF = 0.3
const assistCutoff = ref(DEFAULT_TRIAGE_CUTOFF)
const autoArchiveThreshold = ref(0.2)
const savingAssistThreshold = ref(false)

function clamp01(value: number) {
    return Math.min(Math.max(value, 0), 1)
}

const selectedItems = computed(() => items.value.filter((item) => item.selected))
const keptItems = computed(() => items.value.filter((item) => !item.selected))

const highestSelectedScore = computed(() => {
    if (!selectedItems.value.length) return null
    return Math.max(...selectedItems.value.map((item) => item.score))
})

const lowestKeptScore = computed(() => {
    if (!keptItems.value.length) return null
    return Math.min(...keptItems.value.map((item) => item.score))
})

const hasLabelOverlap = computed(() => {
    if (highestSelectedScore.value === null || lowestKeptScore.value === null) return false
    return highestSelectedScore.value > lowestKeptScore.value
})

const suggestedThreshold = computed(() => {
    if (highestSelectedScore.value !== null && lowestKeptScore.value !== null && !hasLabelOverlap.value) {
        return clamp01((highestSelectedScore.value + lowestKeptScore.value) / 2)
    }
    if (highestSelectedScore.value !== null && lowestKeptScore.value === null) {
        return clamp01(highestSelectedScore.value + 0.03)
    }
    if (highestSelectedScore.value === null && lowestKeptScore.value !== null) {
        return clamp01(lowestKeptScore.value - 0.03)
    }
    return assistCutoff.value
})

const suggestedMessage = computed(() => {
    if (!items.value.length) return 'Load a batch to get a threshold suggestion.'
    if (!selectedItems.value.length || !keptItems.value.length) {
        return 'Mark at least one photo as bad and keep one as good to estimate a useful threshold from this batch.'
    }
    if (hasLabelOverlap.value) {
        return 'Your manual picks overlap the current score ordering. Keep training; do not tighten auto-archive yet from this batch alone.'
    }
    return 'This suggested threshold cleanly separates your current bad selections from the photos you kept in this batch.'
})

const badReasonCounts = computed(() => {
    const counts = new Map<string, number>()
    for (const item of selectedItems.value) {
        for (const reason of item.signals?.reasons ?? []) {
            counts.set(reason, (counts.get(reason) ?? 0) + 1)
        }
    }
    return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4)
})

function formatSignalLabel(reason: string) {
    if (reason === 'underexposed') return 'dark'
    if (reason === 'overexposed') return 'bright'
    if (reason === 'grainy') return 'grain'
    return reason
}

function getAssistRating(item: TriageItem) {
    if (item.score <= assistCutoff.value) return 'archive'
    if (item.score <= Math.min(1, assistCutoff.value + 0.18)) return 'review'
    return 'keep'
}

function applyAssistCutoff() {
    items.value = items.value.map((item) => ({
        ...item,
        selected: item.score <= assistCutoff.value,
    }))
}

function useSuggestedThreshold() {
    assistCutoff.value = suggestedThreshold.value
    applyAssistCutoff()
}

async function saveAssistThreshold() {
    savingAssistThreshold.value = true
    try {
        const response = await aiStore.saveSettings({
            autoArchiveConfidenceThreshold: assistCutoff.value,
        })
        autoArchiveThreshold.value = Number(response?.settings?.autoArchiveConfidenceThreshold ?? assistCutoff.value)
        uiStore.toast(`Saved auto-archive threshold ${autoArchiveThreshold.value.toFixed(2)}`, 'success', 2200)
    } catch (e) {
        console.error('Failed to save assist threshold:', e)
        uiStore.toast('Failed to save auto-archive threshold.', 'error')
    } finally {
        savingAssistThreshold.value = false
    }
}

function getThumbnailUrl(assetId: string) {
    const params = new URLSearchParams({
        size: 'thumbnail',
        key: authStore.apiKey,
        host: authStore.immichBaseUrl,
    })
    return `${window.location.origin}${authStore.proxyBaseUrl}/assets/${assetId}/thumbnail?${params.toString()}`
}

async function loadTriage() {
    loading.value = true;
    const [batch, trainingStats, settings] = await Promise.all([
        aiStore.fetchTriageBatch(),
        aiStore.fetchStats(),
        aiStore.fetchSettings(),
    ]);
    items.value = (batch as ScoredAsset[]).map((item) => ({
        ...item,
        selected: false,
    }));
    stats.value = trainingStats;
    triageBatchSize.value = Number(settings.triageBatchSize ?? 60);
    autoArchiveThreshold.value = clamp01(Number(settings.autoArchiveConfidenceThreshold ?? 0.2))
    assistCutoff.value = autoArchiveThreshold.value || DEFAULT_TRIAGE_CUTOFF
    applyAssistCutoff()
    loading.value = false;
}

async function submitTriage() {
    loading.value = true;
    try {
        await aiStore.trainOnBatch(items.value);
        const result = await aiStore.applyTriageBatch(items.value);
        const archivedCount = Number(result?.archivedCount ?? 0);
        uiStore.toast(`Batch submitted. Archived ${archivedCount} items.`, 'success', 2200);
    } catch (e) {
        console.error('Failed to submit triage batch:', e);
        uiStore.toast('Failed to apply triage batch.', 'error');
    }
    // Reload a new batch
    await loadTriage();
}

onMounted(() => {
    loadTriage();
});
</script>
<template>
<div class="viewport-fit flex flex-col" :class="uiStore.isDarkMode ? 'bg-black text-white' : 'bg-white text-black'">
    <AppHeader />
    <main class="flex-1 overflow-y-auto px-4 py-6">
        <h1 class="text-2xl font-bold mb-4">Triage Grid</h1>
        <p class="mb-4 text-sm text-gray-500">Uncheck photos you want to KEEP. Photos that remain checked will be marked as bad.</p>
        <p class="mb-4 text-sm text-gray-500">Training set: {{ stats.total }} vectors, {{ stats.good }} keep, {{ stats.bad }} archive.</p>
        <p class="mb-4 text-sm text-gray-500">Current triage batch size: {{ triageBatchSize }} images.</p>
        
        <div v-if="loading" class="flex flex-col items-center justify-center p-12">
            <div class="w-full max-w-md bg-gray-200 rounded-full h-2.5 mb-4 dark:bg-gray-700 overflow-hidden">
              <div class="bg-blue-600 h-2.5 w-full animate-pulse transition-all"></div>
            </div>
                        <p>Fetching and scoring batch via Qdrant plus image-quality signals...</p>
        </div>

        <div v-else>
            <section class="mb-6 rounded-2xl border p-4" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
                <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div class="max-w-2xl">
                        <h2 class="text-lg font-semibold">Manual Triage Assist</h2>
                        <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
                            Use this batch to tune the archive cutoff. Your manual checks are treated as ground truth, and the suggested threshold is derived from the photos you marked bad versus kept.
                        </p>
                        <p class="mt-3 text-sm" :class="hasLabelOverlap ? 'text-amber-500' : (uiStore.isDarkMode ? 'text-gray-300' : 'text-gray-700')">
                            {{ suggestedMessage }}
                        </p>
                    </div>
                    <div class="grid grid-cols-2 gap-3 text-sm lg:min-w-[18rem]">
                        <div class="rounded-xl border px-3 py-2" :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/40' : 'border-gray-200 bg-white'">
                            <div class="text-xs uppercase tracking-wide opacity-70">Current setting</div>
                            <div class="mt-1 font-mono text-lg">{{ autoArchiveThreshold.toFixed(2) }}</div>
                        </div>
                        <div class="rounded-xl border px-3 py-2" :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/40' : 'border-gray-200 bg-white'">
                            <div class="text-xs uppercase tracking-wide opacity-70">Suggested</div>
                            <div class="mt-1 font-mono text-lg">{{ suggestedThreshold.toFixed(2) }}</div>
                        </div>
                        <div class="rounded-xl border px-3 py-2" :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/40' : 'border-gray-200 bg-white'">
                            <div class="text-xs uppercase tracking-wide opacity-70">Marked bad</div>
                            <div class="mt-1 font-mono text-lg">{{ selectedItems.length }}</div>
                        </div>
                        <div class="rounded-xl border px-3 py-2" :class="uiStore.isDarkMode ? 'border-gray-800 bg-black/40' : 'border-gray-200 bg-white'">
                            <div class="text-xs uppercase tracking-wide opacity-70">Marked keep</div>
                            <div class="mt-1 font-mono text-lg">{{ keptItems.length }}</div>
                        </div>
                    </div>
                </div>

                <div class="mt-4">
                    <div class="flex items-center justify-between gap-4">
                        <label class="text-sm font-medium">Assist cutoff</label>
                        <span class="font-mono text-sm">{{ assistCutoff.toFixed(2) }}</span>
                    </div>
                    <input v-model.number="assistCutoff" type="range" min="0" max="1" step="0.01" class="mt-2 w-full" />
                    <p class="mt-2 text-xs" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
                        Apply this cutoff to auto-check likely bad images in the current batch. Then adjust manually where the model is wrong.
                    </p>
                </div>

                <div class="mt-4 flex flex-wrap gap-3">
                    <button @click="applyAssistCutoff" class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                        Apply cutoff to batch
                    </button>
                    <button @click="useSuggestedThreshold" class="rounded-xl border px-4 py-2 text-sm font-medium" :class="uiStore.isDarkMode ? 'border-gray-700 hover:bg-gray-900' : 'border-gray-300 hover:bg-gray-100'">
                        Use suggested threshold
                    </button>
                    <button @click="saveAssistThreshold" :disabled="savingAssistThreshold" class="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-50" :class="uiStore.isDarkMode ? 'border-gray-700 hover:bg-gray-900' : 'border-gray-300 hover:bg-gray-100'">
                        Save cutoff to settings
                    </button>
                </div>

                <div v-if="badReasonCounts.length" class="mt-4 flex flex-wrap items-center gap-2 text-xs">
                    <span class="opacity-70">Most common bad reasons in your current picks:</span>
                    <span v-for="([reason, count]) in badReasonCounts" :key="reason" class="rounded-full bg-red-500/15 px-2 py-1 text-red-600 dark:text-red-300">
                        {{ formatSignalLabel(reason) }} {{ count }}
                    </span>
                </div>
            </section>

            <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 mb-8">
                <div v-for="item in items" :key="item.asset.id" 
                     class="relative aspect-square cursor-pointer overflow-hidden rounded-lg border-2 transition-colors"
                     :class="item.selected ? 'border-red-500' : 'border-transparent'"
                     @click="item.selected = !item.selected">
                    <img :src="getThumbnailUrl(item.asset.id)" class="w-full h-full object-cover" loading="lazy" />
                    <div class="absolute top-2 right-2 bg-black/50 rounded-full p-1 border">
                        <input type="checkbox" v-model="item.selected" @click.stop class="w-4 h-4" />
                    </div>
                    <div class="absolute bottom-0 inset-x-0 bg-black/70 text-white text-xs p-1 space-y-1">
                        <div>Score: {{ item.score.toFixed(2) }}</div>
                        <div class="uppercase tracking-wide opacity-90">{{ getAssistRating(item) }}</div>
                        <div class="opacity-80">CLIP {{ (item.clipScore ?? 0.5).toFixed(2) }} · Quality {{ (item.qualityScore ?? 0.5).toFixed(2) }}</div>
                        <div v-if="item.signals?.reasons?.length" class="flex flex-wrap gap-1">
                            <span v-for="reason in item.signals.reasons.slice(0, 3)" :key="reason" class="rounded bg-red-500/70 px-1.5 py-0.5 uppercase tracking-wide">
                                {{ formatSignalLabel(reason) }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="sticky bottom-4 mx-auto max-w-sm">
                <button @click="submitTriage" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-xl shadow-lg">
                    Submit Triage & Train ({{ items.filter(i => i.selected).length }} bad)
                </button>
            </div>
        </div>
    </main>
</div>
</template>
