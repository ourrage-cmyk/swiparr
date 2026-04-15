import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { useImmich } from '@/composables/useImmich'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import type { ImmichAsset } from '@/types/immich'

describe('useImmich album flow', () => {
  const dummyAsset: ImmichAsset = {
    id: 'asset-1',
    deviceAssetId: 'da-1',
    ownerId: 'owner-1',
    deviceId: 'device-1',
    type: 'IMAGE',
    originalPath: '/tmp/file.jpg',
    originalFileName: 'file.jpg',
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    localDateTime: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    visibility: 'timeline',
    isFavorite: false,
    isArchived: false,
    isTrashed: false,
    isOffline: false,
    hasMetadata: false,
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    let currentVisibility: ImmichAsset['visibility'] = 'timeline'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, ..._rest: unknown[]) => {
      const url = typeof input === 'string' ? input : input.toString()
      const init = (_rest[0] as RequestInit | undefined) ?? {}
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null

      if (url.includes('/assets/asset-1') && (!init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({
          ...dummyAsset,
          visibility: currentVisibility,
          isArchived: currentVisibility === 'archive',
        }), { status: 200 })
      }

      if (url.includes('/assets') && init.method === 'PUT') {
        currentVisibility = body?.visibility === 'archive' ? 'archive' : 'timeline'
        return new Response(JSON.stringify([{ id: 'asset-1', success: true, visibility: currentVisibility }]), { status: 200 })
      }

      if (url.includes('/albums/')) {
        return new Response(JSON.stringify([{ id: 'asset-1', success: true }]), { status: 200 })
      }

      if (url.includes('/assets/random')) {
        return new Response(JSON.stringify([dummyAsset]), { status: 200 })
      }

      if (url.includes('/search/random')) {
        return new Response(JSON.stringify([dummyAsset]), { status: 200 })
      }

      if (url.includes('/thumbnail')) {
        return new Response('', { status: 200 })
      }

      return new Response(JSON.stringify({}), { status: 200 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds current asset to album and counts as kept', async () => {
    const auth = useAuthStore()
    auth.setConfig('http://immich.example.com', 'api-key', 'Alice')
    const uiStore = useUiStore()

    const immich = useImmich()
    immich.currentAsset.value = dummyAsset

    await immich.keepPhotoToAlbum({ id: 'album-1', albumName: 'Family' })

    expect(uiStore.keptCount).toBe(1)
    const fetchMock = fetch as unknown as Mock
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/albums/album-1/assets'),
      expect.objectContaining({ method: 'PUT' })
    )
  })

  it('archives via visibility and verifies state', async () => {
    const auth = useAuthStore()
    auth.setConfig('http://immich.example.com', 'api-key', 'Alice')

    const immich = useImmich()
    const success = await immich.archiveAsset('asset-1', true)

    expect(success).toBe(true)
    const fetchMock = fetch as unknown as Mock
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/assets'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ ids: ['asset-1'], visibility: 'archive' }),
      })
    )
  })
})
