<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAiStore } from '@/stores/aiStore'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import AppHeader from '@/components/AppHeader.vue'

const aiStore = useAiStore()
const uiStore = useUiStore()
const authStore = useAuthStore()

const loading = ref(true)
const items = ref<any[]>([])
const stats = ref({ total: 0, good: 0, bad: 0 })
const triageBatchSize = ref(60)

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
    items.value = batch;
    stats.value = trainingStats;
    triageBatchSize.value = Number(settings.triageBatchSize ?? 60);
    // By default, mark items as "delete" (checked) if score is < 0.3
    items.value.forEach(i => i.selected = (i.score < 0.3));
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
            <p>Fetching and scoring batch via Qdrant models...</p>
        </div>

        <div v-else>
            <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 mb-8">
                <div v-for="item in items" :key="item.asset.id" 
                     class="relative aspect-square cursor-pointer overflow-hidden rounded-lg border-2 transition-colors"
                     :class="item.selected ? 'border-red-500' : 'border-transparent'"
                     @click="item.selected = !item.selected">
                    <img :src="getThumbnailUrl(item.asset.id)" class="w-full h-full object-cover" loading="lazy" />
                    <div class="absolute top-2 right-2 bg-black/50 rounded-full p-1 border">
                        <input type="checkbox" v-model="item.selected" @click.stop class="w-4 h-4" />
                    </div>
                    <div class="absolute bottom-0 inset-x-0 bg-black/60 text-white text-xs p-1">
                        Score: {{ item.score.toFixed(2) }}
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
