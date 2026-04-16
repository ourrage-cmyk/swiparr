export interface ImmichAsset {
  id: string
  deviceAssetId: string
  ownerId: string
  deviceId: string
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER'
  originalPath: string
  originalFileName: string
  originalMimeType?: string
  thumbhash?: string
  fileCreatedAt: string
  fileModifiedAt: string
  localDateTime: string
  updatedAt: string
  visibility?: 'archive' | 'timeline' | 'hidden' | 'locked'
  isFavorite: boolean
  isArchived: boolean
  isTrashed: boolean
  isOffline: boolean
  hasMetadata: boolean
  duration?: string
  exifInfo?: {
    city?: string
    country?: string
    dateTimeOriginal?: string
    description?: string
    exifImageHeight?: number
    exifImageWidth?: number
    make?: string
    model?: string
  }
}

export interface QualitySignals {
  overall: number
  blur: number
  exposure: number
  noise: number
  screenshot: number
  meanLuma: number
  darkClip: number
  brightClip: number
  edgeDensity: number
  lowSaturation: number
  laplacianVariance: number
  noiseResidual: number
  reasons: string[]
}

export interface ScoredAsset {
  asset: ImmichAsset
  score: number
  clipScore?: number
  qualityScore?: number
  signals?: QualitySignals
  imgUrl?: string
}

export interface ImmichConfig {
  serverUrl: string
  apiKey: string
}

export interface DeleteAssetsRequest {
  ids: string[]
  force?: boolean
}

export interface DeleteAssetsResponse {
  count: number
}

export interface EnvUser {
  name: string
  apiKey: string
}

export interface EnvConfig {
  serverUrl: string
  users: EnvUser[]
}

export interface ImmichAlbum {
  id: string
  albumName: string
  assetCount?: number
  createdAt?: string
  updatedAt?: string
  albumThumbnailAssetId?: string
}

export interface AddAssetsToAlbumRequest {
  ids: string[]
}

export interface MetadataSearchRequest {
  take?: number
  skip?: number
  page?: number
  size?: number
  order?: 'asc' | 'desc'
  visibility?: 'archive' | 'timeline' | 'hidden' | 'locked'
  assetType?: ('IMAGE' | 'VIDEO')[]
}

export interface MetadataSearchResponse {
  items?: ImmichAsset[]
  hasNextPage?: boolean
  count?: number
  nextPage?: string | number | null
  assets?: {
    total?: number
    count?: number
    items: ImmichAsset[]
  }
}
