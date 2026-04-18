import { computed, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { usePreferencesStore } from '@/stores/preferences'
import { useReviewedStore } from '@/stores/reviewed'
import type {
  ImmichAsset,
  ImmichAlbum,
  MetadataSearchRequest,
  MetadataSearchResponse,
  ScoredAsset,
} from '@/types/immich'

export function useImmich() {
  const authStore = useAuthStore()
  const uiStore = useUiStore()
  const preferencesStore = usePreferencesStore()
  const reviewedStore = useReviewedStore()

  const currentAsset = ref<ImmichAsset | null>(null)
  const nextAsset = ref<ImmichAsset | null>(null)
  const pendingAssets = ref<ImmichAsset[]>([])
  const error = ref<string | null>(null)
  const SKIP_VIDEOS_BATCH_SIZE = 10
  const SKIP_VIDEOS_MAX_ATTEMPTS = 5
  const CHRONO_PAGE_SIZE = 50
  const RANDOM_BATCH_SIZE = 5
  const RANDOM_MAX_ATTEMPTS = 20
  const UNCERTAIN_QUEUE_TARGET = 12
  const UNCERTAIN_QUEUE_REFILL_THRESHOLD = 4
  const UNCERTAIN_QUEUE_FETCH_LIMIT = 40
  const UNCERTAIN_QUEUE_FETCH_PADDING = 6
  const UNCERTAIN_QUEUE_REFILL_ATTEMPTS = 4
  const UNCERTAIN_SCAN_BATCH_SIZE = 40
  const UNCERTAIN_SCAN_BATCHES = 4
  const UNCERTAIN_MIN_SCORE_DEFAULT = 0.2
  const UNCERTAIN_MAX_SCORE_DEFAULT = 0.5
  const ARCHIVE_VISIBILITY = 'archive'
  const TIMELINE_VISIBILITY = 'timeline'

  const albumsCache = ref<ImmichAlbum[] | null>(null)
  const ARCHIVED_ALBUM_NAME = 'archived'

  const chronologicalQueue = ref<ImmichAsset[]>([])
  const uncertainQueue = ref<ScoredAsset[]>([])
  const isRefillingUncertainQueue = ref(false)
  const chronologicalSkip = ref(0)
  const chronologicalPage = ref<number | null>(1)
  const chronologicalPagingMode = ref<'skip' | 'page' | null>(null)
  const chronologicalHasMore = ref(true)
  const isFetchingChronological = ref(false)
  const reviewCandidateSettings = ref({
    minScore: UNCERTAIN_MIN_SCORE_DEFAULT,
    maxScore: UNCERTAIN_MAX_SCORE_DEFAULT,
  })
  const currentAssetScore = ref<number | null>(null)
  const currentAssetSource = ref<'focused-range' | 'random-fallback' | 'chronological' | 'pending' | null>(null)
  const nextAssetScore = ref<number | null>(null)
  const nextAssetSource = ref<'focused-range' | 'random-fallback' | 'chronological' | 'pending' | null>(null)

  type LoadedCandidate = {
    asset: ImmichAsset
    score: number | null
    source: 'focused-range' | 'random-fallback' | 'chronological' | 'pending'
  }

  type ReviewAction = {
    asset: ImmichAsset
    type: 'keep' | 'delete' | 'keepToAlbum'
    albumName?: string
  }

  const actionHistory = ref<ReviewAction[]>([])

  function isArchivedAsset(asset: ImmichAsset): boolean {
    return asset.isArchived || asset.visibility === ARCHIVE_VISIBILITY || asset.isTrashed
  }

  function isReviewable(asset: ImmichAsset): boolean {
    if (reviewedStore.isReviewed(asset.id)) return false
    if (isArchivedAsset(asset)) return false
    if (uiStore.skipVideos && asset.type === 'VIDEO') return false
    return true
  }

  function resetReviewFlow() {
    chronologicalQueue.value = []
    uncertainQueue.value = []
    isRefillingUncertainQueue.value = false
    chronologicalSkip.value = 0
    chronologicalPage.value = 1
    chronologicalPagingMode.value = null
    chronologicalHasMore.value = true
    nextAsset.value = null
    currentAssetScore.value = null
    currentAssetSource.value = null
    nextAssetScore.value = null
    nextAssetSource.value = null
    pendingAssets.value = []
    actionHistory.value = []
  }

  watch(
    () => [authStore.serverUrl, authStore.currentUserName],
    () => {
      albumsCache.value = null
      reviewCandidateSettings.value = {
        minScore: UNCERTAIN_MIN_SCORE_DEFAULT,
        maxScore: UNCERTAIN_MAX_SCORE_DEFAULT,
      }
      resetReviewFlow()
    }
  )

  // Generic Immich API request helper
  async function apiRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    if (!authStore.immichBaseUrl) {
      throw new Error('Immich server URL is not configured')
    }

    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
    
    // REDIRECT: Use the local Node server as a proxy to avoid CORS and Mixed Content issues.
    const url = `${window.location.origin}/api/immich-proxy${normalizedEndpoint}`
    
    const headers: HeadersInit = {
      'x-api-key': authStore.apiKey,
      'x-target-host': authStore.immichBaseUrl,
      'Accept': 'application/json',
      ...options.headers,
    }

    // Add Content-Type for non-GET requests with body
    if (options.body && typeof options.body === 'string') {
      (headers as Record<string, string>)['Content-Type'] = 'application/json'
    }

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage: string
      try {
        const errorJson = JSON.parse(errorText)
        errorMessage = errorJson.message || errorJson.error || `API error: ${response.status}`
      } catch {
        errorMessage = `API error: ${response.status} - ${errorText}`
      }
      console.error(`[Immich API Request Failed] Endpoint: ${endpoint} | Status: ${response.status} | Err:`, errorMessage)
      throw new Error(errorMessage)
    }

    // Handle empty
    const text = await response.text()
    if (!text) return {} as T
    return JSON.parse(text)
  }

  // Test connection
  async function testConnection(): Promise<boolean> {
    try {
      uiStore.setLoading(true, 'Testing connection...')
      error.value = null
      
      console.log('[Auth] Testing Node backend reachability...');
      const pingResp = await fetch(`${window.location.origin}/api/ping`, {
          headers: { 'x-target-host': authStore.immichBaseUrl }
      }).catch(() => null);
      
      if (!pingResp || !pingResp.ok) {
          throw new Error('NETWORK_ERROR: Browser cannot reach Swiparr backend. Check your firewall/ports.');
      }
      
      const diag = await pingResp.json();
      if (diag.immich.includes('Failed')) {
          throw new Error(`ROUTING_ERROR: Swiparr Container cannot reach Immich IP: ${diag.immich}`);
      }
      
      console.log('[Auth] Diagnostics OK. Testing Immich API...');
      const resp = await fetch(`${window.location.origin}/api/immich-proxy/users/me`, {
          headers: { 
              'x-api-key': authStore.apiKey,
              'x-target-host': authStore.immichBaseUrl
          }
      });
      
      if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(`API_ERROR: ${resp.status} - ${body.error || body.message || 'Unknown backend error'}`);
      }
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      error.value = msg
      console.error('[Auth] Test failed:', msg);
      return false
    } finally {
      uiStore.setLoading(false)
    }
  }

  function applyCurrentCandidate(candidate: LoadedCandidate | null): void {
    currentAsset.value = candidate?.asset ?? null
    currentAssetScore.value = candidate?.score ?? null
    currentAssetSource.value = candidate?.source ?? null
  }

  function applyNextCandidate(candidate: LoadedCandidate | null): void {
    nextAsset.value = candidate?.asset ?? null
    nextAssetScore.value = candidate?.score ?? null
    nextAssetSource.value = candidate?.source ?? null
  }

  function dequeueUncertainAsset(): LoadedCandidate | null {
    while (uncertainQueue.value.length > 0) {
      const candidate = uncertainQueue.value.shift()
      if (candidate && isReviewable(candidate.asset)) {
        return {
          asset: candidate.asset,
          score: candidate.score,
          source: 'focused-range',
        }
      }
    }

    return null
  }

  function clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1)
  }

  async function loadReviewCandidateSettings(): Promise<void> {
    try {
      const response = await fetch(`${window.location.origin}/api/settings`)
      if (!response.ok) return
      const payload = await response.json() as Record<string, unknown>
      const minScore = clamp01(Number(payload.reviewCandidateMinScore ?? UNCERTAIN_MIN_SCORE_DEFAULT))
      const maxScore = clamp01(Number(payload.reviewCandidateMaxScore ?? UNCERTAIN_MAX_SCORE_DEFAULT))
      reviewCandidateSettings.value = {
        minScore,
        maxScore: Math.max(minScore, maxScore),
      }
    } catch (e) {
      console.error('Failed to load review candidate settings:', e)
    }
  }

  async function fetchReviewCandidates(requestedCount: number = UNCERTAIN_QUEUE_TARGET): Promise<ScoredAsset[]> {
    await loadReviewCandidateSettings()
    const query = new URLSearchParams({
      count: String(Math.min(UNCERTAIN_QUEUE_FETCH_LIMIT, Math.max(1, requestedCount))),
      scanBatchSize: String(UNCERTAIN_SCAN_BATCH_SIZE),
      scanBatches: String(UNCERTAIN_SCAN_BATCHES),
      minScore: String(reviewCandidateSettings.value.minScore),
      maxScore: String(reviewCandidateSettings.value.maxScore),
    })
    const response = await fetch(`${window.location.origin}/api/review-candidates?${query.toString()}`, {
      headers: {
        'x-api-key': authStore.apiKey,
        'x-target-host': authStore.immichBaseUrl,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || 'Failed to fetch review candidates')
    }

    const payload = await response.json() as unknown
    const items = Array.isArray(payload) ? payload as ScoredAsset[] : []
    return items.filter((item) => item && item.asset && isReviewable(item.asset))
  }

  async function refillUncertainQueue(force: boolean = false): Promise<void> {
    if (preferencesStore.reviewOrder !== 'random') return
    if (isRefillingUncertainQueue.value) return
    if (!force && uncertainQueue.value.length >= UNCERTAIN_QUEUE_REFILL_THRESHOLD) return

    isRefillingUncertainQueue.value = true
    try {
      const seenIds = new Set(uncertainQueue.value.map((item) => item.asset.id))
      const merged = [...uncertainQueue.value]

      for (let attempt = 0; attempt < UNCERTAIN_QUEUE_REFILL_ATTEMPTS; attempt += 1) {
        if (merged.length >= UNCERTAIN_QUEUE_TARGET) {
          break
        }

        const requestedCount = Math.min(
          UNCERTAIN_QUEUE_FETCH_LIMIT,
          Math.max(UNCERTAIN_QUEUE_TARGET, (UNCERTAIN_QUEUE_TARGET - merged.length) + UNCERTAIN_QUEUE_FETCH_PADDING),
        )
        const candidates = await fetchReviewCandidates(requestedCount)
        if (candidates.length === 0) {
          break
        }

        let addedCount = 0
        for (const candidate of candidates) {
          if (seenIds.has(candidate.asset.id)) continue
          seenIds.add(candidate.asset.id)
          merged.push(candidate)
          addedCount += 1
          if (merged.length >= UNCERTAIN_QUEUE_TARGET) {
            break
          }
        }

        if (addedCount === 0) {
          break
        }
      }

      uncertainQueue.value = merged.slice(0, UNCERTAIN_QUEUE_TARGET)
    } catch (e) {
      console.error('Failed to refill uncertain review queue:', e)
    } finally {
      isRefillingUncertainQueue.value = false
    }
  }

  // Fetch a random asset
  async function fetchRandomAsset(): Promise<LoadedCandidate | null> {
    try {
      if (uncertainQueue.value.length > 0) {
        const queued = dequeueUncertainAsset()
        if (queued) {
          void refillUncertainQueue()
          return queued
        }
      }

      await refillUncertainQueue(true)
      const uncertainCandidate = dequeueUncertainAsset()
      if (uncertainCandidate) {
        void refillUncertainQueue()
        return uncertainCandidate
      }

      const attempts = uiStore.skipVideos ? SKIP_VIDEOS_MAX_ATTEMPTS : RANDOM_MAX_ATTEMPTS
      for (let attempt = 0; attempt < attempts; attempt++) {
        const count = uiStore.skipVideos ? SKIP_VIDEOS_BATCH_SIZE : RANDOM_BATCH_SIZE
        const assets = await apiRequest<ImmichAsset[]>('/search/random', {
          method: 'POST',
          body: JSON.stringify({
            size: count,
            visibility: TIMELINE_VISIBILITY,
          }),
        })
        if (!assets || assets.length === 0) {
          continue
        }

        const candidate = assets.find(isReviewable)
        if (candidate) {
          return {
            asset: candidate,
            score: null,
            source: 'random-fallback',
          }
        }
      }

      if (uiStore.skipVideos) {
        throw new Error('No unreviewed photos found after skipping videos.')
      }
      throw new Error('No unreviewed assets found. Clear the reviewed cache to start over.')
    } catch (e) {
      console.error('Failed to fetch random asset:', e)
      throw e
    }
  }

  async function fetchChronologicalBatch(): Promise<{ items: ImmichAsset[]; hasMore: boolean; nextPage: number | null }> {
    const order = preferencesStore.reviewOrder === 'chronological-desc' ? 'desc' : 'asc'
    const usePagePagination = chronologicalPagingMode.value !== 'skip'
    const body: MetadataSearchRequest = {
      order,
      visibility: TIMELINE_VISIBILITY,
      assetType: ['IMAGE', 'VIDEO'],
    }
    if (usePagePagination && chronologicalPage.value !== null) {
      body.page = chronologicalPage.value
      body.size = CHRONO_PAGE_SIZE
    } else {
      body.take = CHRONO_PAGE_SIZE
      body.skip = chronologicalSkip.value
    }

    let response: MetadataSearchResponse | ImmichAsset[]
    try {
      response = await apiRequest<MetadataSearchResponse | ImmichAsset[]>('/search/metadata', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    } catch (e) {
      if (!usePagePagination || chronologicalPagingMode.value === 'skip') {
        throw e
      }

      chronologicalPagingMode.value = 'skip'
      chronologicalPage.value = null
      const fallbackBody: MetadataSearchRequest = {
        order,
        visibility: TIMELINE_VISIBILITY,
        assetType: ['IMAGE', 'VIDEO'],
        take: CHRONO_PAGE_SIZE,
        skip: chronologicalSkip.value,
      }
      response = await apiRequest<MetadataSearchResponse | ImmichAsset[]>('/search/metadata', {
        method: 'POST',
        body: JSON.stringify(fallbackBody),
      })
    }

    if (chronologicalPagingMode.value === null) {
      if (Array.isArray(response)) {
        chronologicalPagingMode.value = 'skip'
        chronologicalPage.value = null
      } else if (response?.nextPage !== undefined || response?.hasNextPage !== undefined) {
        chronologicalPagingMode.value = 'page'
      } else if (usePagePagination) {
        chronologicalPagingMode.value = 'page'
      } else {
        chronologicalPagingMode.value = 'skip'
        chronologicalPage.value = null
      }
    }

    const items = Array.isArray(response)
      ? response
      : response?.assets?.items ?? response?.items ?? []

    let hasMore = items.length === CHRONO_PAGE_SIZE
    let nextPage: number | null = null

    if (!Array.isArray(response)) {
      if (typeof response.hasNextPage === 'boolean') {
        hasMore = response.hasNextPage
      } else if (response?.nextPage !== undefined && response?.nextPage !== null) {
        hasMore = true
        const parsedNext = Number(response.nextPage)
        nextPage = Number.isNaN(parsedNext) ? null : parsedNext
      } else if (typeof response.assets?.total === 'number' && typeof response.assets?.count === 'number') {
        if (response.assets.total > response.assets.count) {
          hasMore = true
        }
      }
    }

    return { items, hasMore, nextPage }
  }

  async function fetchNextChronologicalAsset(): Promise<LoadedCandidate | null> {
    while (chronologicalQueue.value.length === 0 && chronologicalHasMore.value) {
      await loadChronologicalBatch()
    }

    if (chronologicalQueue.value.length === 0) {
      return null
    }

    const asset = chronologicalQueue.value.shift() || null
    return asset
      ? {
          asset,
          score: null,
          source: 'chronological',
        }
      : null
  }

  async function loadChronologicalBatch(): Promise<void> {
    if (isFetchingChronological.value || !chronologicalHasMore.value) return
    isFetchingChronological.value = true

    try {
      const batch = await fetchChronologicalBatch()
      if (chronologicalPagingMode.value === 'skip') {
        chronologicalSkip.value += batch.items.length
      }
      chronologicalHasMore.value = batch.hasMore
      if (batch.nextPage !== null && !Number.isNaN(batch.nextPage)) {
        chronologicalPage.value = batch.nextPage
      } else if (chronologicalPage.value !== null && batch.hasMore) {
        chronologicalPage.value += 1
      }

      const filtered = batch.items.filter(isReviewable)
      chronologicalQueue.value.push(...filtered)
    } catch (e) {
      console.error('Failed to fetch chronological assets:', e)
      chronologicalHasMore.value = false
      error.value = e instanceof Error ? e.message : 'Failed to load chronological assets'
    } finally {
      isFetchingChronological.value = false
    }
  }

  async function fetchNextAsset(): Promise<LoadedCandidate | null> {
    while (pendingAssets.value.length > 0) {
      const pending = pendingAssets.value.shift()
      if (pending && !reviewedStore.isReviewed(pending.id)) {
        return {
          asset: pending,
          score: null,
          source: 'pending',
        }
      }
    }
    if (preferencesStore.reviewOrder !== 'random') {
      return fetchNextChronologicalAsset()
    }
    return fetchRandomAsset()
  }

  // Load initial and preload next
  async function loadInitialAsset(resetFlow: boolean = true): Promise<void> {
    try {
      uiStore.setLoading(true, 'Loading photo...')
      error.value = null

      await loadReviewCandidateSettings()

      if (resetFlow) {
        resetReviewFlow()
      }
      applyCurrentCandidate(await fetchNextAsset())

      if (currentAsset.value) {
        preloadNextAsset()
      } else {
        if (preferencesStore.reviewOrder !== 'random') {
          error.value = uiStore.skipVideos
            ? 'No photos found in chronological mode after skipping videos.'
            : 'No photos found in chronological mode.'
        } else {
          error.value = uiStore.skipVideos
            ? 'No photos were found after skipping videos. Try turning off Skip Videos mode.'
            : 'No photos found in your library'
        }
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load photo'
    } finally {
      uiStore.setLoading(false)
    }
  }

  // Preload next
  async function preloadNextAsset(): Promise<void> {
    try {
      applyNextCandidate(await fetchNextAsset())

      if (preferencesStore.reviewOrder === 'random') {
        void refillUncertainQueue()
      }

      if (nextAsset.value) {
        const url = getAssetThumbnailUrl(nextAsset.value.id, 'preview')
        if (!url) return
        const img = new Image()
        img.decoding = 'async'
        img.src = url
      }
    } catch (e) {
      console.error('Failed to preload next asset:', e)
    }
  }

  // Re-useable helper to show an asset and ensure we have a sensible "next" lined up
  function setCurrentAssetWithFallback(asset: ImmichAsset, resumeAsset: ImmichAsset | null): void {
    applyCurrentCandidate({
      asset,
      score: null,
      source: 'pending',
    })

    if (resumeAsset && resumeAsset.id !== asset.id) {
      applyNextCandidate({
        asset: resumeAsset,
        score: null,
        source: 'pending',
      })
    } else if (!nextAsset.value) {
      preloadNextAsset()
    }
  }

  function enqueuePendingAsset(asset: ImmichAsset | null): void {
    if (!asset || reviewedStore.isReviewed(asset.id)) return
    pendingAssets.value = [
      asset,
      ...pendingAssets.value.filter((item) => item.id !== asset.id),
    ]
  }

  // Move to the next asset
  function moveToNextAsset(): void {
    if (nextAsset.value) {
      currentAsset.value = nextAsset.value
      currentAssetScore.value = nextAssetScore.value
      currentAssetSource.value = nextAssetSource.value
      nextAsset.value = null
      nextAssetScore.value = null
      nextAssetSource.value = null
      preloadNextAsset()
    } else {
      loadInitialAsset(false)
    }
  }

  // Get asset thumbnail URL
  function getAssetThumbnailUrl(assetId: string, size: 'thumbnail' | 'preview' = 'preview'): string {
    const params = `?size=${size}&key=${authStore.apiKey}&host=${encodeURIComponent(authStore.immichBaseUrl)}`;
    const url = `${window.location.origin}/api/immich-proxy/assets/${assetId}/thumbnail${params}`;
    console.log('[Media] Thumbnail URL:', url);
    return url
  }

  function getAssetOriginalUrl(assetId: string): string {
    const params = `?key=${authStore.apiKey}&host=${encodeURIComponent(authStore.immichBaseUrl)}`;
    return `${window.location.origin}/api/immich-proxy/assets/${assetId}/original${params}`
  }

  // Get headers for image requests
  function getAuthHeaders(): Record<string, string> {
    return {
      'x-api-key': authStore.apiKey,
      'X-Target-Host': authStore.immichBaseUrl,
    }
  }

  async function fetchAlbums(force: boolean = false): Promise<ImmichAlbum[]> {
    if (albumsCache.value && !force) {
      return albumsCache.value
    }

    // Fetch owned + shared albums
    const [ownedAlbums, sharedAlbums] = await Promise.all([
      apiRequest<ImmichAlbum[]>('/albums'),
      apiRequest<ImmichAlbum[]>('/albums?shared=true'),
    ])

    // Merge & deduplicate (by id)
    const albumMap = new Map<string, ImmichAlbum>()
    for (const album of ownedAlbums) {
      albumMap.set(album.id, album)
    }
    for (const album of sharedAlbums) {
      if (!albumMap.has(album.id)) {
        albumMap.set(album.id, album)
      }
    }

    const albums = Array.from(albumMap.values())
    albumsCache.value = albums
    return albums
  }

  async function getOrCreateArchivedAlbum(): Promise<ImmichAlbum> {
    const albums = await fetchAlbums()
    const existingAlbum = albums.find((album) => album.albumName.toLowerCase() === ARCHIVED_ALBUM_NAME)
    if (existingAlbum) {
      return existingAlbum
    }

    return createAlbum(ARCHIVED_ALBUM_NAME)
  }

  async function addAssetToArchivedAlbum(assetId: string): Promise<void> {
    const album = await getOrCreateArchivedAlbum()
    await addAssetToAlbum(album.id, assetId)
  }

  async function fetchAssetDetails(assetId: string): Promise<ImmichAsset> {
    return apiRequest<ImmichAsset>(`/assets/${assetId}`)
  }

  async function fetchAlbumAssets(albumId: string): Promise<ImmichAsset[]> {
    const album = await apiRequest<Record<string, unknown>>(`/albums/${albumId}`)
    const rawAssets = Array.isArray(album.assets)
      ? album.assets
      : Array.isArray(album.albumAssets)
        ? album.albumAssets
        : []

    return rawAssets as ImmichAsset[]
  }

  async function fetchArchivedAssets(): Promise<ImmichAsset[]> {
    const albums = await fetchAlbums()
    const archivedAlbum = albums.find((album) => album.albumName.toLowerCase() === ARCHIVED_ALBUM_NAME)
    if (!archivedAlbum) {
      return []
    }

    const assets = await fetchAlbumAssets(archivedAlbum.id)
    return assets.filter((asset) => isArchivedAsset(asset))
  }

  async function addAssetToAlbum(albumId: string, assetId: string): Promise<void> {
    const result = await apiRequest<Array<{ id: string; success: boolean; error?: string; errorMessage?: string }>>(`/albums/${albumId}/assets`, {
      method: 'PUT',
      body: JSON.stringify({
        ids: [assetId],
      }),
    })

    const status = Array.isArray(result) ? result.find((item) => item.id === assetId) : null
    if (!status || !status.success) {
      throw new Error(status?.errorMessage || status?.error || 'Album add failed')
    }
  }

  // Removed deleteAsset and restoreAsset as they were replaced by archivePhoto/archiveAsset logic.

  // Archive asset
  async function archiveAsset(assetId: string, isArchived: boolean = true): Promise<boolean> {
    try {
      await apiRequest(`/assets`, {
        method: 'PUT',
        body: JSON.stringify({ 
          ids: [assetId],
          visibility: isArchived ? ARCHIVE_VISIBILITY : TIMELINE_VISIBILITY,
        }),
      })

      const updatedAsset = await fetchAssetDetails(assetId)
      return isArchived ? isArchivedAsset(updatedAsset) : !isArchivedAsset(updatedAsset)
    } catch (e) {
      console.error('Failed to update archive status:', e)
      error.value = e instanceof Error ? e.message : 'Failed to archive photo'
      return false
    }
  }

  // Create album
  async function createAlbum(albumName: string): Promise<ImmichAlbum> {
    try {
      const album = await apiRequest<ImmichAlbum>('/albums', {
        method: 'POST',
        body: JSON.stringify({ albumName }),
      })
      albumsCache.value = null // Invalidate cache
      return album
    } catch (e) {
      console.error('Failed to create album:', e)
      throw e
    }
  }

  // Keep
  async function keepPhoto(): Promise<void> {
    if (!currentAsset.value) return
    const assetToKeep = currentAsset.value
    actionHistory.value.push({ asset: assetToKeep, type: 'keep' })
    reviewedStore.markReviewed(assetToKeep.id, 'keep')
    uiStore.incrementKept()
    uiStore.toast('Photo kept ✓', 'success', 1500)
    moveToNextAsset()
  }

  async function keepPhotoToAlbum(album: ImmichAlbum): Promise<void> {
    if (!currentAsset.value) return

    const assetToKeep = currentAsset.value
    try {
      await addAssetToAlbum(album.id, assetToKeep.id)
      preferencesStore.setLastUsedAlbumId(album.id)
      actionHistory.value.push({
        asset: assetToKeep,
        type: 'keepToAlbum',
        albumName: album.albumName,
      })
      reviewedStore.markReviewed(assetToKeep.id, 'keep')
      uiStore.incrementKept()
      uiStore.toast(`Added to ${album.albumName}`, 'success', 1800)
      moveToNextAsset()
    } catch (e) {
      console.error('Failed to add asset to album:', e)
      uiStore.toast('Failed to add to album', 'error')
    }
  }

  async function toggleFavorite(): Promise<void> {
    if (!currentAsset.value) return

    const assetToUpdate = currentAsset.value
    const nextFavorite = !assetToUpdate.isFavorite

    try {
      const updatedAsset = { ...assetToUpdate, isFavorite: nextFavorite }

      await apiRequest(`/assets/${assetToUpdate.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isFavorite: nextFavorite }),
      })

      currentAsset.value = updatedAsset

      if (nextFavorite) {
        actionHistory.value.push({ asset: updatedAsset, type: 'keep' })
        reviewedStore.markReviewed(updatedAsset.id, 'keep')
        uiStore.incrementKept()
        uiStore.toast('Favorited ✓', 'success', 1500)
        moveToNextAsset()
      } else {
        uiStore.toast('Removed from favorites', 'info', 1500)
      }
    } catch (e) {
      console.error('Failed to update favorite:', e)
      uiStore.toast('Failed to update favorite', 'error')
    }
  }

  // Archive (Left Swipe)
  async function archivePhoto(): Promise<void> {
    if (!currentAsset.value) return

    const assetToArchive = currentAsset.value
    const success = await archiveAsset(assetToArchive.id, true)

    if (success) {
      try {
        await addAssetToArchivedAlbum(assetToArchive.id)
      } catch (e) {
        console.error('Failed to add asset to archived album:', e)
      }
      actionHistory.value.push({ asset: assetToArchive, type: 'delete' }) // Keep 'delete' type for internal history/stats simplicity
      reviewedStore.markReviewed(assetToArchive.id, 'delete')
      uiStore.incrementDeleted()
      uiStore.toast('Photo archived', 'info', 1500)
      moveToNextAsset()
    } else {
      uiStore.toast('Failed to archive photo', 'error')
    }
  }

  // Undo last action (keep/delete/album)
  async function undoLastAction(): Promise<void> {
    const lastAction = actionHistory.value.pop()
    if (!lastAction) {
      uiStore.toast('Nothing to undo', 'info', 1500)
      return
    }

    const assetToResumeAfterUndo = currentAsset.value
    const preloadedAfterResume = nextAsset.value

    if (lastAction.type === 'delete') {
      // Undo archive by setting isArchived to false
      const success = await archiveAsset(lastAction.asset.id, false)
      if (!success) {
        actionHistory.value.push(lastAction)
        uiStore.toast('Failed to undo archive', 'error')
        return
      }

      reviewedStore.unmarkReviewed(lastAction.asset.id)
      uiStore.decrementDeleted()
      uiStore.toast(`${lastAction.asset.originalFileName} was un-archived`, 'success', 2500)
      if (preloadedAfterResume?.id !== assetToResumeAfterUndo?.id) {
        enqueuePendingAsset(preloadedAfterResume)
      }
      setCurrentAssetWithFallback(lastAction.asset, assetToResumeAfterUndo)
      return
    }

    reviewedStore.unmarkReviewed(lastAction.asset.id)
    uiStore.decrementKept()
    if (lastAction.type === 'keepToAlbum' && lastAction.albumName) {
      uiStore.toast(`Back to photo (in ${lastAction.albumName})`, 'info', 2000)
    } else {
      uiStore.toast('Back to previous photo', 'info', 1500)
    }
    if (preloadedAfterResume?.id !== assetToResumeAfterUndo?.id) {
      enqueuePendingAsset(preloadedAfterResume)
    }
    setCurrentAssetWithFallback(lastAction.asset, assetToResumeAfterUndo)
  }

  const canUndo = computed(() => actionHistory.value.length > 0)

  return {
    currentAsset,
    nextAsset,
    currentAssetScore,
    currentAssetSource,
    error,
    testConnection,
    loadInitialAsset,
    keepPhoto,
    keepPhotoToAlbum,
    toggleFavorite,
    archivePhoto,
    undoLastAction,
    canUndo,
    reviewCandidateSettings,
    getAssetThumbnailUrl,
    getAssetOriginalUrl,
    getAuthHeaders,
    fetchAlbums,
    fetchArchivedAssets,
    createAlbum,
    addAssetToAlbum,
    addAssetToArchivedAlbum,
    archiveAsset,
  }
}
