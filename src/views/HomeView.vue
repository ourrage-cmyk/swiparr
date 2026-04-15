<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useImmich } from '@/composables/useImmich'
import { useUiStore } from '@/stores/ui'
import { usePreferencesStore } from '@/stores/preferences'
import { useAiStore } from '@/stores/aiStore'
import { useRouter } from 'vue-router'
import type { ImmichAlbum } from '@/types/immich'
import AppHeader from '@/components/AppHeader.vue'
import SwipeCard from '@/components/SwipeCard.vue'
import ActionButtons from '@/components/ActionButtons.vue'
import AlbumPicker from '@/components/AlbumPicker.vue'

const {
  currentAsset,
  error,
  loadInitialAsset,
  keepPhoto,
  keepPhotoToAlbum,
  toggleFavorite,
  archivePhoto,
  undoLastAction,
  fetchAlbums,
  canUndo,
} = useImmich()
const router = useRouter()
const uiStore = useUiStore()
const preferencesStore = usePreferencesStore()
const aiStore = useAiStore()

const showAlbumPicker = ref(false)
const isLoadingAlbums = ref(false)
const albumsError = ref<string | null>(null)
const albums = ref<ImmichAlbum[]>([])

const autoArchiveEnabled = ref(false)
const autoArchiveThreshold = ref(0.2)
const trainingStats = ref({ total: 0, good: 0, bad: 0 })
const minimumTrainingPoints = 5
const thresholdLabel = computed(() => autoArchiveThreshold.value.toFixed(2))

function queueTrainingDecision(isGood: boolean) {
  const assetId = currentAsset.value?.id ?? null
  void aiStore.trainOnAsset(assetId, isGood)
}

async function handleKeep() {
  queueTrainingDecision(true)
  await keepPhoto()
}

async function handleArchive() {
  queueTrainingDecision(false)
  await archivePhoto()
}

async function saveAutoArchiveSettings(successMessage?: string) {
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoArchive: autoArchiveEnabled.value,
        autoArchiveConfidenceThreshold: autoArchiveThreshold.value,
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to save settings')
    }

    if (successMessage) {
      uiStore.toast(successMessage, 'success', 2200)
    }
  } catch (e) {
    console.error('Failed to save settings', e)
    uiStore.toast('Failed to update auto-archive settings.', 'error')
  }
}

async function toggleAutoArchive() {
  await saveAutoArchiveSettings(
    autoArchiveEnabled.value
      ? 'Auto-archive enabled. Hourly cron will use your threshold once enough manual training exists.'
      : 'Auto-archive disabled.',
  )
}

async function updateAutoArchiveThreshold() {
  await saveAutoArchiveSettings(`Auto-archive threshold set to ${thresholdLabel.value}.`)
}

async function loadTrainingStats() {
  try {
    trainingStats.value = await aiStore.fetchStats()
  } catch (e) {
    console.error('Failed to load training stats', e)
  }
}

onMounted(async () => {
  try {
    const resp = await fetch('/api/settings')
    if (resp.ok) {
      const settings = await resp.json()
      autoArchiveEnabled.value = Boolean(settings.autoArchive)
      autoArchiveThreshold.value = Number(settings.autoArchiveConfidenceThreshold ?? 0.2)
    }
  } catch (e) {
    console.error('Failed to load auto-archive settings', e)
  }

  await loadTrainingStats()
})

// Keyboard navigation
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    undoLastAction()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault()
    undoLastAction()
    return
  }

  if (!currentAsset.value) return

  if (e.key === 'ArrowRight') {
    e.preventDefault()
    void handleKeep()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    void handleArchive()
  } else if (e.key.toLowerCase() === 'f') {
    if (shouldIgnoreHotkeys()) return
    e.preventDefault()
    toggleFavorite()
  } else if (/^[0-9]$/.test(e.key)) {
    if (shouldIgnoreHotkeys()) return
    const albumId = preferencesStore.albumHotkeys[e.key]
    if (!albumId) {
      uiStore.toast(`No album configured for key ${e.key}`, 'info', 2000)
      return
    }
    const album = albums.value.find((item) => item.id === albumId)
    keepPhotoToAlbum(album || { id: albumId, albumName: `Album ${e.key}` })
  }
}

function shouldIgnoreHotkeys(): boolean {
  const active = document.activeElement as HTMLElement | null
  const isTyping = active && ['INPUT', 'TEXTAREA'].includes(active.tagName)
  return !!isTyping || showAlbumPicker.value
}

async function ensureAlbumsLoaded() {
  if (albums.value.length > 0) return
  try {
    isLoadingAlbums.value = true
    albumsError.value = null
    albums.value = await fetchAlbums()
  } catch (e) {
    console.error(e)
    albumsError.value = e instanceof Error ? e.message : 'Failed to load albums'
  } finally {
    isLoadingAlbums.value = false
  }
}

async function openAlbumPicker() {
  await ensureAlbumsLoaded()
  showAlbumPicker.value = true
}

function closeAlbumPicker() {
  showAlbumPicker.value = false
}

async function handleAlbumSelected(album: ImmichAlbum) {
  await keepPhotoToAlbum(album)
  showAlbumPicker.value = false
}

function handleAssignHotkey(key: string, albumId: string | null) {
  if (albumId) {
    preferencesStore.setHotkey(key, albumId)
  } else {
    preferencesStore.clearHotkey(key)
  }
}

watch(
  () => preferencesStore.reviewOrder,
  async () => {
    await loadInitialAsset()
  }
)

onMounted(() => {
  loadInitialAsset()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="viewport-fit flex flex-col"
    :class="uiStore.isDarkMode ? 'bg-black text-white' : 'bg-white text-black'"
  >
    <AppHeader />

    <!-- Main content -->
    <main class="flex-1 flex flex-col px-4 safe-area-bottom min-h-0 gap-3 overflow-hidden">
      <!-- Error state -->
      <div v-if="error && !currentAsset" class="flex-1 flex flex-col items-center justify-center gap-4">
        <div class="text-center">
          <svg class="w-16 h-16 mx-auto mb-4"
            :class="uiStore.isDarkMode ? 'text-gray-600' : 'text-gray-400'"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-lg"
            :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'"
          >
            {{ error }}
          </p>
        </div>
        <button
          @click="() => loadInitialAsset()"
          class="px-6 py-2 rounded-lg transition-colors"
          :class="uiStore.isDarkMode
            ? 'bg-white text-black hover:bg-gray-200'
            : 'bg-black text-white hover:bg-gray-800'"
        >
          Try Again
        </button>
      </div>

      <!-- Swipe area -->
      <div v-else class="flex-1 flex flex-col min-h-0 gap-2">
        <!-- Card container -->
        <div class="flex-1 min-h-0 flex items-center justify-center p-1">
          <div v-if="currentAsset" class="w-full h-full max-w-4xl max-h-full">
            <SwipeCard
              :asset="currentAsset"
              @keep="() => { void handleKeep() }"
              @delete="() => { void handleArchive() }"
            />
          </div>

          <!-- Empty state while loading -->
          <div v-else class="flex h-full items-center justify-center"
            :class="uiStore.isDarkMode ? 'text-gray-600' : 'text-gray-400'"
          >
            <svg class="w-16 h-16 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        </div>

        <div class="shrink-0 flex flex-col items-center gap-2">
          <!-- Action buttons -->
          <ActionButtons
            v-if="currentAsset"
            class="-mx-4 sm:mx-0"
            :can-undo="canUndo"
            :is-favorite="currentAsset?.isFavorite ?? false"
            @keep="handleKeep"
            @delete="handleArchive"
            @undo="undoLastAction"
            @toggle-favorite="toggleFavorite"
            @open-album-picker="openAlbumPicker"
            @album-drop="openAlbumPicker"
          />
          <button 
              @click="router.push('/triage')"
              class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
              Automatic Cleanup
          </button>
          <div class="mt-4 flex items-center gap-2">
              <input type="checkbox" v-model="autoArchiveEnabled" @change="toggleAutoArchive" id="autoArchive" class="w-4 h-4" />
              <label for="autoArchive" class="text-sm">Enable Server-Side Auto-Archive (Cron)</label>
          </div>
          <div class="w-full max-w-md rounded-xl border px-4 py-3"
            :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/60' : 'border-gray-200 bg-gray-50'"
          >
            <div class="flex items-center justify-between gap-4">
              <label for="autoArchiveThreshold" class="text-sm font-medium">
                Auto-archive threshold
              </label>
              <span class="text-sm font-mono">{{ thresholdLabel }}</span>
            </div>
            <input
              id="autoArchiveThreshold"
              v-model.number="autoArchiveThreshold"
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="mt-3 w-full"
              @change="updateAutoArchiveThreshold"
            />
            <div class="mt-2 flex justify-between text-xs"
              :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'"
            >
              <span>More aggressive</span>
              <span>More conservative</span>
            </div>
            <p class="mt-3 text-xs"
              :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'"
            >
              Manual training vectors: {{ trainingStats.total }}
              ({{ trainingStats.good }} keep, {{ trainingStats.bad }} archive).
              The threshold starts mattering after at least {{ minimumTrainingPoints }} manual decisions.
            </p>
          </div>

          <!-- Instructions (now mobile -> hidden) -->
          <div class="hidden sm:flex text-center text-sm py-2 items-center flex-col gap-y-2"
            :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-400'"
          >
            <!-- Mobile -->
            <div class="sm:hidden flex gap-x-2">
              <span class="px-3 py-1 rounded-full text-xs font-medium border transition-colors border-green-700 text-green-600 bg-green-300">
                RIGHT 
                
              </span>
              <div
                class="w-px h-6"
                :class="uiStore.isDarkMode ? 'bg-gray-700' : 'bg-gray-300'"
              ></div>
              <span class="px-3 py-1 rounded-full text-xs font-medium border transition-colors border-red-700 text-red-600 bg-red-300">
                LEFT
              </span>
            </div>
            <!-- Desktop -->
            <div class="hidden sm:flex gap-x-3">
              <span class="flex gap-x-2 px-3 py-1 rounded-full text-xs font-medium border transition-colors border-red-700 text-red-600 bg-red-300">
                LEFT
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </span>
              <div
                class="w-px h-6"
                :class="uiStore.isDarkMode ? 'bg-gray-700' : 'bg-gray-300'"
              ></div>
              <span class="flex gap-x-2 px-3 py-1 rounded-full text-xs font-medium border transition-colors border-green-700 bg-green-300 text-green-600">
                RIGHT 
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
              </span>
            </div>
            <p class="hidden sm:flex">
              (←/→) • Ctrl+Z or ↑ (back) • F = favorite • 0–9 = album hotkeys
            </p>
          </div>
        </div>
      </div>
    </main>

    <AlbumPicker
      :open="showAlbumPicker"
      :albums="albums"
      :loading="isLoadingAlbums"
      :error="albumsError"
      :hotkeys="preferencesStore.albumHotkeys"
      @close="closeAlbumPicker"
      @select="handleAlbumSelected"
      @assign-hotkey="handleAssignHotkey"
    />
  </div>
</template>
