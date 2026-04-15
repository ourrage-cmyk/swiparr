<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppHeader from '@/components/AppHeader.vue'
import { useImmich } from '@/composables/useImmich'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'

const authStore = useAuthStore()
const uiStore = useUiStore()
const { fetchArchivedAssets, archiveAsset, getAssetThumbnailUrl } = useImmich()

const loading = ref(true)
const items = ref<any[]>([])

const archivedCount = computed(() => items.value.length)

function openInImmich(assetId: string) {
  const baseUrl = authStore.immichBaseUrl
  if (!baseUrl) {
    uiStore.toast('Immich server URL is not configured.', 'error')
    return
  }

  window.open(`${baseUrl}/photos/${assetId}`, '_blank', 'noopener,noreferrer')
}

async function loadArchivedAssets() {
  loading.value = true
  try {
    const assets = await fetchArchivedAssets()
    items.value = assets.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  } catch (e) {
    console.error('Failed to load archived assets:', e)
    uiStore.toast('Failed to load archived assets.', 'error')
  } finally {
    loading.value = false
  }
}

async function restoreAsset(assetId: string) {
  try {
    const success = await archiveAsset(assetId, false)
    if (!success) {
      throw new Error('Unarchive failed')
    }
    items.value = items.value.filter((item) => item.id !== assetId)
    uiStore.toast('Asset restored from archive.', 'success', 1800)
  } catch (e) {
    console.error('Failed to restore asset:', e)
    uiStore.toast('Failed to restore asset.', 'error')
  }
}

onMounted(() => {
  loadArchivedAssets()
})
</script>

<template>
  <div class="viewport-fit flex flex-col" :class="uiStore.isDarkMode ? 'bg-black text-white' : 'bg-white text-black'">
    <AppHeader />
    <main class="flex-1 overflow-y-auto px-4 py-6">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <section>
          <h1 class="text-2xl font-bold">Archived Review</h1>
          <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
            Shows assets from the Immich album named <span class="font-mono">archived</span>. Use this page to spot-check what was archived and restore anything that should stay visible.
          </p>
          <p class="mt-2 text-sm" :class="uiStore.isDarkMode ? 'text-gray-500' : 'text-gray-500'">
            Current archived items shown: {{ archivedCount }}
          </p>
        </section>

        <section v-if="loading" class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'">
          <p>Loading archived assets...</p>
        </section>

        <section v-else-if="archivedCount === 0" class="rounded-2xl border p-5" :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70 text-gray-300' : 'border-gray-200 bg-gray-50 text-gray-700'">
          No archived assets found in the <span class="font-mono">archived</span> album.
        </section>

        <section v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <article
            v-for="asset in items"
            :key="asset.id"
            class="overflow-hidden rounded-2xl border"
            :class="uiStore.isDarkMode ? 'border-gray-800 bg-gray-950/70' : 'border-gray-200 bg-gray-50'"
          >
            <img
              :src="getAssetThumbnailUrl(asset.id, 'preview')"
              :alt="asset.originalFileName"
              class="aspect-square w-full object-cover"
              loading="lazy"
            />
            <div class="space-y-2 p-3">
              <p class="truncate text-sm font-medium">{{ asset.originalFileName }}</p>
              <p class="text-xs" :class="uiStore.isDarkMode ? 'text-gray-400' : 'text-gray-600'">
                Updated {{ new Date(asset.updatedAt).toLocaleString() }}
              </p>
              <div class="grid grid-cols-2 gap-2">
                <button
                  class="rounded-xl border px-3 py-2 text-sm font-medium transition-colors"
                  :class="uiStore.isDarkMode
                    ? 'border-gray-700 text-gray-200 hover:bg-gray-900'
                    : 'border-gray-300 text-gray-700 hover:bg-white'"
                  @click="openInImmich(asset.id)"
                >
                  Open in Immich
                </button>
                <button
                  class="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
                  @click="restoreAsset(asset.id)"
                >
                  Restore
                </button>
              </div>
            </div>
          </article>
        </section>
      </div>
    </main>
  </div>
</template>