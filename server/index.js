import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { pipeline, env as transformersEnv, RawImage } from '@xenova/transformers';
import { QdrantClient } from '@qdrant/js-client-rest';

// Disable telemetry, cache models locally
transformersEnv.useBrowserCache = false;
transformersEnv.localModelPath = path.join(process.cwd(), 'models');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DATA_DIR = process.env.APP_DATA_DIR || __dirname;
const LOG_FILE = path.join(APP_DATA_DIR, 'swiparr.log');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

console.log('[System] App Version 1.2.0 Starting...');

// Serve static frontend
app.use(express.static(path.join(__dirname, '../dist')));

// ---- Health Check ----
app.get('/api/ping', async (req, res) => {
    const target = req.headers['x-target-host'];
    let detail = 'No target provided';
    if (target) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const check = await fetch(target, { signal: controller.signal }).catch(e => ({ ok: false, statusText: e.message }));
            clearTimeout(timeout);
            detail = (check && check.ok) ? 'Connected' : `Failed: ${(check && check.statusText) || 'Timeout'}`;
        } catch (e) { detail = `Error: ${e.message}`; }
    }
    res.json({ status: 'ok', version: '1.2.0-diagnostic', immich: detail });
});

// ---- Transparent Proxy for Immich API (to avoid CORS/Mixed Content) ----
app.all('/api/immich-proxy/*', async (req, res) => {
    try {
        const targetHost = req.headers['x-target-host'] || req.query.host;
        const apiKey = req.headers['x-api-key'] || req.query.key;
        
        if (!targetHost) {
            console.warn('[Proxy] Missing x-target-host header');
            return res.status(400).json({ error: 'Missing x-target-host header' });
        }
        
        // Extract the sub-path after /api/immich-proxy/
        const endpoint = req.params[0] || '';
        
        // --- CLEAN QUERY PARAMS ---
        // We need to strip 'key' and 'host' so they aren't forwarded to Immich
        const urlObj = new URL(req.url, 'http://localhost');
        const queryParams = urlObj.searchParams;
        queryParams.delete('key');
        queryParams.delete('host');
        const finalQuery = queryParams.toString();
        
        const normalizedTarget = targetHost.endsWith('/') ? targetHost.slice(0, -1) : targetHost;
        const url = `${normalizedTarget}/api/${endpoint}${finalQuery ? '?' + finalQuery : ''}`;
        
        console.log(`[Proxy] Forwarding ${req.method} to: ${url}`);
        
        const options = {
            method: req.method,
            headers: {
                'x-api-key': apiKey,
                'User-Agent': 'Swipar-Proxy/1.2.4',
                'Accept': '*/*',
            }
        };
        
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body) {
            options.body = JSON.stringify(req.body);
            options.headers['Content-Type'] = 'application/json';
        }
        
        const resp = await fetch(url, options);
        console.log(`[Proxy] Target: ${url} | Status: ${resp.status} | Type: ${resp.headers.get('content-type')}`);
        
        if (resp.status >= 400) {
            console.error(`[Proxy] FAILURE from Immich: ${resp.status} ${resp.statusText}`);
        }

        // Forward status and essential headers
        res.status(resp.status);
        const contentType = resp.headers.get('content-type');
        
        // IMPORTANT: Do NOT forward content-length. Node's fetch often decompresses 
        // the body, making the original content-length incorrect.
        if (contentType) res.set('Content-Type', contentType);

        // Serve binary data via buffer
        const arrayBuffer = await resp.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        res.send(buffer);
    } catch (e) {
        console.error('[Proxy] CRITICAL ERROR:', e.message);
        res.status(500).json({ error: e.message || 'Internal Proxy Error' });
    }
});

// ---- Qdrant setup ----
const qdrant = new QdrantClient({ host: process.env.QDRANT_HOST || 'qdrant', port: 6333 });
const COLLECTION_NAME = 'immich_swipe_vectors';
let qdrantReady = false;
let qdrantInitPromise = null;
let autoArchiveTask = null;
let qualityModelCache = null;
const TRIAGE_BATCH_DEFAULT = 60;
const TRIAGE_BATCH_MIN = 12;
const TRIAGE_BATCH_MAX = 250;
const TRIAGE_CONCURRENCY = 4;
const MIN_TRAINING_POINTS = 5;
const SCORE_SEARCH_LIMIT = 128;
const SCORE_NEIGHBOR_COUNT = 24;
const SCORE_PRIOR_REBALANCE_EXPONENT = 0.5;
const SCORE_NEIGHBOR_RANGE_MIN = 0.015;
const SCORE_NEIGHBOR_RANGE_MAX = 0.12;
const SCORE_QUALITY_WEIGHT = 0.28;
const QUALITY_PENALTY_FLOOR = 0.42;
const QUALITY_SAMPLE_TARGET = 256;
const QUALITY_FEATURE_VERSION = 1;
const QUALITY_MODEL_MIN_POINTS = 20;
const QUALITY_MODEL_POINT_LIMIT = 50000;
const ARCHIVE_REQUEST_CHUNK_SIZE = 25;
const ALBUM_ADD_CHUNK_SIZE = 25;
const LOG_TAIL_LINE_LIMIT = 200;
const REVIEW_CANDIDATE_TARGET_DEFAULT = 12;
const REVIEW_CANDIDATE_TARGET_MIN = 4;
const REVIEW_CANDIDATE_TARGET_MAX = 40;
const REVIEW_CANDIDATE_SCAN_BATCH_SIZE = 40;
const REVIEW_CANDIDATE_SCAN_BATCH_MIN = 10;
const REVIEW_CANDIDATE_SCAN_BATCH_MAX = 80;
const REVIEW_CANDIDATE_SCAN_BATCHES_DEFAULT = 4;
const REVIEW_CANDIDATE_SCAN_BATCHES_MIN = 1;
const REVIEW_CANDIDATE_SCAN_BATCHES_MAX = 10;
const REVIEW_CANDIDATE_MIN_SCORE_DEFAULT = 0.2;
const REVIEW_CANDIDATE_MAX_SCORE_DEFAULT = 0.5;
const AUTO_ARCHIVE_MIN_POINTS = MIN_TRAINING_POINTS;
const MANUAL_SOURCE = 'manual';
const AUTO_ARCHIVE_CRON_DEFAULT = '0 * * * *';
const AUTO_ARCHIVE_SCAN_BATCH_SIZE = 40;
const AUTO_ARCHIVE_SCAN_BATCH_MIN = 10;
const AUTO_ARCHIVE_SCAN_BATCH_MAX = 250;
const AUTO_ARCHIVE_BATCHES_PER_RUN = 3;
const AUTO_ARCHIVE_SCAN_BATCHES_MIN = 1;
const AUTO_ARCHIVE_SCAN_BATCHES_MAX = 10;
const AUTO_ARCHIVE_ARCHIVE_BATCH_SIZE = 25;
const AUTO_ARCHIVE_ARCHIVE_BATCH_MIN = 1;
const AUTO_ARCHIVE_ARCHIVE_BATCH_MAX = 100;
const AUTO_ARCHIVE_CONFIDENCE_THRESHOLD = 0.2;
const ARCHIVED_ALBUM_NAME = 'archived';
const ARCHIVE_VISIBILITY = 'archive';
const TIMELINE_VISIBILITY = 'timeline';

function logEvent(level, scope, message, details = null) {
    const timestamp = new Date().toISOString();
    const serializedDetails = details ? ` ${JSON.stringify(details)}` : '';
    const line = `[${timestamp}] [${level}] [${scope}] ${message}${serializedDetails}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf-8');
    } catch (error) {
        console.warn('[Logging] Failed to write log file:', error.message);
    }
}

async function ensureQdrantReady() {
    if (qdrantReady) {
        return true;
    }
    if (!qdrantInitPromise) {
        qdrantInitPromise = setupQdrant().finally(() => {
            qdrantInitPromise = null;
        });
    }
    await qdrantInitPromise;
    return qdrantReady;
}

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results.filter(Boolean);
}

async function setupQdrant() {
    try {
        const collections = await qdrant.getCollections();
        const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
        if (!exists) {
            await qdrant.createCollection(COLLECTION_NAME, {
                vectors: { size: 512, distance: 'Cosine' },
            });
            console.log(`[Qdrant] Created collection: ${COLLECTION_NAME}`);
        } else {
            console.log(`[Qdrant] Collection ${COLLECTION_NAME} already exists.`);
        }
        qdrantReady = true;
    } catch (e) {
        console.warn('[Qdrant] WARNING: Failed to initialize. Backend will respond with errors for vector operations:', e.message);
        qdrantReady = false;
    }
}

// ---- CLIP Model ----
let extractor = null;

async function initModel() {
    if (!extractor) {
        console.log('[Model] Loading Xenova/clip-vit-base-patch32 …');
        extractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
        console.log('[Model] Ready.');
    }
    return extractor;
}

function clamp01(value) {
    return Math.min(Math.max(value, 0), 1);
}

function normalizeRange(value, min, max) {
    if (value <= min) return 0;
    if (value >= max) return 1;
    return (value - min) / (max - min);
}

/**
 * Download an image from Immich and convert it to a RawImage.
 */
async function fetchAnalysisImage(imageUrl, apiKey) {
    const resp = await fetch(imageUrl, {
        headers: { 'x-api-key': apiKey, 'Accept': 'application/octet-stream' },
    });
    if (!resp.ok) throw new Error(`Fetch failed ${resp.status} for ${imageUrl}`);
    const buffer = Buffer.from(await resp.arrayBuffer());

    const blob = new Blob([buffer], { type: resp.headers.get('content-type') || 'image/jpeg' });
    const image = await RawImage.fromBlob(blob);

    return image.rgba();
}

/**
 * Run CLIP on a decoded RawImage.
 * Returns a 512-dim Float32 array.
 */
async function extractEmbeddingFromImage(image) {
    const ext = await initModel();
    const output = await ext(image, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

function analyzeImageQuality(image, asset = null) {
    const width = Number(image?.width || 0);
    const height = Number(image?.height || 0);
    const data = image?.data;
    if (!width || !height || !data?.length) {
        return {
            overall: 0.5,
            blur: 0.5,
            exposure: 0.5,
            noise: 0.5,
            screenshot: 1,
            meanLuma: 0.5,
            darkClip: 0,
            brightClip: 0,
            edgeDensity: 0,
            lowSaturation: 0,
            laplacianVariance: 0,
            noiseResidual: 0,
            reasons: [],
        };
    }

    const sampleStep = Math.max(1, Math.ceil(Math.max(width, height) / QUALITY_SAMPLE_TARGET));
    const sampledWidth = Math.ceil(width / sampleStep);
    const sampledHeight = Math.ceil(height / sampleStep);
    const luma = new Float32Array(sampledWidth * sampledHeight);
    let lumaSum = 0;
    let darkClipCount = 0;
    let brightClipCount = 0;
    let lowSaturationCount = 0;

    for (let sampleY = 0; sampleY < sampledHeight; sampleY += 1) {
        const y = Math.min(height - 1, sampleY * sampleStep);
        for (let sampleX = 0; sampleX < sampledWidth; sampleX += 1) {
            const x = Math.min(width - 1, sampleX * sampleStep);
            const pixelOffset = (y * width + x) * 4;
            const red = data[pixelOffset] / 255;
            const green = data[pixelOffset + 1] / 255;
            const blue = data[pixelOffset + 2] / 255;
            const maxChannel = Math.max(red, green, blue);
            const minChannel = Math.min(red, green, blue);
            const saturation = maxChannel === 0 ? 0 : (maxChannel - minChannel) / maxChannel;
            const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
            const sampleIndex = (sampleY * sampledWidth) + sampleX;
            luma[sampleIndex] = luminance;
            lumaSum += luminance;
            if (luminance < 0.08) darkClipCount += 1;
            if (luminance > 0.92) brightClipCount += 1;
            if (saturation < 0.12) lowSaturationCount += 1;
        }
    }

    const totalSamples = luma.length;
    const meanLuma = totalSamples > 0 ? lumaSum / totalSamples : 0.5;
    const darkClip = totalSamples > 0 ? darkClipCount / totalSamples : 0;
    const brightClip = totalSamples > 0 ? brightClipCount / totalSamples : 0;
    const lowSaturation = totalSamples > 0 ? lowSaturationCount / totalSamples : 0;

    let laplacianSum = 0;
    let laplacianSumSq = 0;
    let edgeCount = 0;
    let interiorCount = 0;
    let noiseResidualSum = 0;
    let noiseResidualCount = 0;

    for (let sampleY = 1; sampleY < sampledHeight - 1; sampleY += 1) {
        for (let sampleX = 1; sampleX < sampledWidth - 1; sampleX += 1) {
            const index = (sampleY * sampledWidth) + sampleX;
            const center = luma[index];
            const up = luma[index - sampledWidth];
            const down = luma[index + sampledWidth];
            const left = luma[index - 1];
            const right = luma[index + 1];
            const laplacian = up + down + left + right - (4 * center);
            laplacianSum += laplacian;
            laplacianSumSq += laplacian * laplacian;
            interiorCount += 1;

            const gradient = Math.abs(right - left) + Math.abs(down - up);
            if (gradient > 0.16) {
                edgeCount += 1;
            }

            if (gradient < 0.12) {
                noiseResidualSum += Math.abs(center - ((up + down + left + right) * 0.25));
                noiseResidualCount += 1;
            }
        }
    }

    const laplacianMean = interiorCount > 0 ? laplacianSum / interiorCount : 0;
    const laplacianVariance = interiorCount > 0
        ? Math.max(0, (laplacianSumSq / interiorCount) - (laplacianMean * laplacianMean))
        : 0;
    const edgeDensity = interiorCount > 0 ? edgeCount / interiorCount : 0;
    const noiseResidual = noiseResidualCount > 0 ? noiseResidualSum / noiseResidualCount : 0;

    const blur = clamp01(normalizeRange(laplacianVariance, 0.0015, 0.018));
    const exposurePenalty = Math.max(
        normalizeRange(Math.abs(meanLuma - 0.5), 0.12, 0.32),
        normalizeRange(darkClip, 0.18, 0.55),
        normalizeRange(brightClip, 0.18, 0.55),
    );
    const exposure = 1 - clamp01(exposurePenalty);
    const noise = 1 - clamp01(normalizeRange(noiseResidual, 0.035, 0.11));

    const filename = String(asset?.originalFileName || '');
    const screenshotByName = /(screenshot|screen[ _-]?shot|schirmfoto|capture d[' ]ecran|截屏|スクリーンショット)/i.test(filename);
    const screenshotByVisuals = clamp01(normalizeRange(edgeDensity, 0.16, 0.34))
        * clamp01(normalizeRange(lowSaturation, 0.48, 0.85));
    const screenshotLikelihood = screenshotByName ? 0.98 : screenshotByVisuals;
    const screenshot = 1 - clamp01(screenshotLikelihood);

    const reasons = [];
    if (blur < 0.38) reasons.push('blur');
    if (exposure < 0.38) reasons.push(darkClip >= brightClip ? 'underexposed' : 'overexposed');
    if (noise < 0.38) reasons.push('grainy');
    if (screenshotLikelihood > 0.7) reasons.push('screenshot');

    const overall = clamp01(
        (blur * 0.36)
        + (exposure * 0.28)
        + (noise * 0.24)
        + (screenshot * 0.12)
    );

    return {
        overall,
        blur,
        exposure,
        noise,
        screenshot,
        meanLuma,
        darkClip,
        brightClip,
        edgeDensity,
        lowSaturation,
        laplacianVariance,
        noiseResidual,
        reasons,
    };
}

function getAssetDimensions(asset, image) {
    const width = Number(asset?.width || asset?.exifInfo?.exifImageWidth || image?.width || 0);
    const height = Number(asset?.height || asset?.exifInfo?.exifImageHeight || image?.height || 0);
    return { width, height, maxDimension: Math.max(width, height) };
}

function getCaptureYear(asset) {
    const raw = asset?.localDateTime || asset?.fileCreatedAt || asset?.updatedAt || null;
    if (!raw) return null;
    const year = new Date(raw).getUTCFullYear();
    return Number.isFinite(year) ? year : null;
}

function inferQualityProfile(signals, asset, image) {
    if ((1 - signals.screenshot) > 0.65) {
        return 'screenshot';
    }

    const captureYear = getCaptureYear(asset);
    const { maxDimension } = getAssetDimensions(asset, image);
    if ((captureYear && captureYear < 2012) || maxDimension < 1800) {
        return 'legacy';
    }

    return 'modern';
}

function buildQualityFeaturePayload(signals, asset, image) {
    const { width, height, maxDimension } = getAssetDimensions(asset, image);
    const captureYear = getCaptureYear(asset);
    const profile = inferQualityProfile(signals, asset, image);
    const aspectRatio = width > 0 && height > 0 ? width / height : 1;

    return {
        version: QUALITY_FEATURE_VERSION,
        profile,
        values: {
            blur: clamp01(signals.blur),
            exposure: clamp01(signals.exposure),
            noise: clamp01(signals.noise),
            screenshot: clamp01(signals.screenshot),
            lowSaturation: clamp01(1 - signals.lowSaturation),
            edgeDensity: clamp01(signals.edgeDensity),
            resolution: clamp01(normalizeRange(maxDimension, 1000, 4000)),
            portraitBias: clamp01(Math.abs(Math.log(aspectRatio || 1)) / 1.2),
            captureEra: captureYear ? clamp01(normalizeRange(captureYear, 2000, 2024)) : 0.5,
        },
    };
}

function getQualityFeatureVector(qualityFeatures) {
    if (!qualityFeatures || qualityFeatures.version !== QUALITY_FEATURE_VERSION) {
        return null;
    }

    const values = qualityFeatures.values || {};
    return [
        clamp01(values.blur ?? 0.5),
        clamp01(values.exposure ?? 0.5),
        clamp01(values.noise ?? 0.5),
        clamp01(values.screenshot ?? 0.5),
        clamp01(values.lowSaturation ?? 0.5),
        clamp01(values.edgeDensity ?? 0.5),
        clamp01(values.resolution ?? 0.5),
        clamp01(values.portraitBias ?? 0.5),
        clamp01(values.captureEra ?? 0.5),
    ];
}

function createEmptyQualityBucket() {
    return {
        keepCount: 0,
        badCount: 0,
        keepSums: null,
        badSums: null,
    };
}

function accumulateQualityVector(bucket, vector, isKeep) {
    const sumKey = isKeep ? 'keepSums' : 'badSums';
    const countKey = isKeep ? 'keepCount' : 'badCount';
    if (!bucket[sumKey]) {
        bucket[sumKey] = new Array(vector.length).fill(0);
    }
    vector.forEach((value, index) => {
        bucket[sumKey][index] += value;
    });
    bucket[countKey] += 1;
}

function finalizeQualityBucket(bucket) {
    if (!bucket.keepCount || !bucket.badCount || !bucket.keepSums || !bucket.badSums) {
        return null;
    }

    const keepMean = bucket.keepSums.map((value) => value / bucket.keepCount);
    const badMean = bucket.badSums.map((value) => value / bucket.badCount);
    const weights = keepMean.map((value, index) => Math.abs(value - badMean[index]));
    const separation = weights.reduce((sum, value) => sum + value, 0) / weights.length;
    const support = Math.min(1, Math.sqrt((bucket.keepCount + bucket.badCount) / QUALITY_MODEL_MIN_POINTS));
    const strength = clamp01(separation * 1.8) * Math.min(0.85, Math.max(0.2, support));

    return {
        keepMean,
        badMean,
        weights,
        strength,
        support,
        pointCount: bucket.keepCount + bucket.badCount,
    };
}

async function getAllManualPoints() {
    const manualPoints = [];
    let offset = undefined;

    while (manualPoints.length < QUALITY_MODEL_POINT_LIMIT) {
        const response = await qdrant.scroll(COLLECTION_NAME, {
            limit: 1000,
            offset,
            with_payload: true,
        });
        const points = Array.isArray(response?.points) ? response.points : [];
        if (points.length === 0) {
            break;
        }

        manualPoints.push(...points.filter(isManualTrainingPoint));
        if (!response.next_page_offset) {
            break;
        }
        offset = response.next_page_offset;
    }

    return manualPoints;
}

function buildAdaptiveQualityModel(manualPoints) {
    const globalBucket = createEmptyQualityBucket();
    const buckets = new Map();
    let featurePointCount = 0;
    let keepCount = 0;
    let badCount = 0;

    for (const point of manualPoints) {
        if (point?.payload?.isKeep) {
            keepCount += 1;
        } else {
            badCount += 1;
        }

        const vector = getQualityFeatureVector(point?.payload?.qualityFeatures);
        if (!vector) {
            continue;
        }

        featurePointCount += 1;
        const profile = point?.payload?.qualityFeatures?.profile || 'global';
        if (!buckets.has(profile)) {
            buckets.set(profile, createEmptyQualityBucket());
        }
        accumulateQualityVector(globalBucket, vector, Boolean(point?.payload?.isKeep));
        accumulateQualityVector(buckets.get(profile), vector, Boolean(point?.payload?.isKeep));
    }

    const models = new Map();
    const globalModel = finalizeQualityBucket(globalBucket);
    if (globalModel) {
        models.set('global', globalModel);
    }

    for (const [profile, bucket] of buckets.entries()) {
        const model = finalizeQualityBucket(bucket);
        if (model) {
            models.set(profile, model);
        }
    }

    return {
        featurePointCount,
        keepCount,
        badCount,
        totalCount: manualPoints.length,
        models,
    };
}

function getPointId(point) {
    return String(point?.id || '');
}

async function backfillQualityFeatures({ manualPoints, immichBase, apiKey, limit = QUALITY_MODEL_MIN_POINTS }) {
    const candidates = manualPoints
        .filter((point) => !getQualityFeatureVector(point?.payload?.qualityFeatures))
        .slice(0, limit);

    if (candidates.length === 0) {
        return 0;
    }

    let updatedCount = 0;
    await mapWithConcurrency(candidates, 2, async (point) => {
        const assetId = getPointId(point);
        if (!assetId) {
            return null;
        }

        try {
            const assetDetails = await fetchAssetDetails(immichBase, apiKey, assetId).catch(() => null);
            const thumbUrl = `${immichBase}/api/assets/${assetId}/thumbnail?size=preview`;
            const image = await fetchAnalysisImage(thumbUrl, apiKey);
            const signals = analyzeImageQuality(image, assetDetails);
            const qualityFeatures = buildQualityFeaturePayload(signals, assetDetails, image);
            await qdrant.setPayload(COLLECTION_NAME, {
                wait: true,
                points: [assetId],
                payload: { qualityFeatures },
            });
            point.payload = {
                ...(point.payload || {}),
                qualityFeatures,
            };
            updatedCount += 1;
            return true;
        } catch (error) {
            logEvent('WARN', 'QualityBackfill', 'Failed to backfill quality features', { assetId, error: error.message });
            return null;
        }
    });

    if (updatedCount > 0) {
        qualityModelCache = null;
        logEvent('INFO', 'QualityBackfill', 'Backfilled quality features for manual labels', { updatedCount });
    }

    return updatedCount;
}

function scoreQualityFromModel(model, qualityFeatures) {
    const vector = getQualityFeatureVector(qualityFeatures);
    if (!model || !vector) {
        return null;
    }

    const profileModel = model.models.get(qualityFeatures.profile) || model.models.get('global');
    if (!profileModel) {
        return null;
    }

    let keepDistance = 0;
    let badDistance = 0;
    for (let index = 0; index < vector.length; index += 1) {
        const weight = Math.max(profileModel.weights[index], 0.05);
        keepDistance += weight * ((vector[index] - profileModel.keepMean[index]) ** 2);
        badDistance += weight * ((vector[index] - profileModel.badMean[index]) ** 2);
    }

    const totalDistance = keepDistance + badDistance;
    const score = totalDistance > 0 ? clamp01(badDistance / totalDistance) : 0.5;

    return {
        score,
        strength: profileModel.strength,
        support: profileModel.support,
        pointCount: profileModel.pointCount,
        profile: qualityFeatures.profile,
    };
}

function scoreFromNeighbors(searchRes, trainingModel = null) {
    const neighbors = searchRes.slice(0, SCORE_NEIGHBOR_COUNT);
    if (neighbors.length === 0) {
        return { score: 0.5, confidence: 0 };
    }

    const similarities = neighbors.map((point) => Math.max(0, Number(point?.score) || 0));
    const minSimilarity = Math.min(...similarities);
    const maxSimilarity = Math.max(...similarities);
    const similarityRange = maxSimilarity - minSimilarity;
    let keepWeight = 0;
    let badWeight = 0;

    for (let index = 0; index < neighbors.length; index += 1) {
        const point = neighbors[index];
        const similarity = similarities[index];
        const normalizedSimilarity = similarityRange > 0.000001
            ? (similarity - minSimilarity) / similarityRange
            : 0.5;
        const rankWeight = 1 - (index / (neighbors.length + 1));
        const weight = Math.max(0.05, (0.35 + (normalizedSimilarity * 0.65)) * rankWeight);
        if (weight === 0) {
            continue;
        }

        if (point.payload?.isKeep) {
            keepWeight += weight;
        } else {
            badWeight += weight;
        }
    }

    const totalWeight = keepWeight + badWeight;
    if (totalWeight === 0) {
        return { score: 0.5, confidence: 0 };
    }

    const keepPrior = trainingModel?.totalCount
        ? Math.max(0.05, trainingModel.keepCount / trainingModel.totalCount)
        : 0.5;
    const badPrior = trainingModel?.totalCount
        ? Math.max(0.05, trainingModel.badCount / trainingModel.totalCount)
        : 0.5;
    const rebalancedKeep = keepWeight / Math.pow(keepPrior, SCORE_PRIOR_REBALANCE_EXPONENT);
    const rebalancedBad = badWeight / Math.pow(badPrior, SCORE_PRIOR_REBALANCE_EXPONENT);
    const rebalancedTotal = rebalancedKeep + rebalancedBad;
    const posterior = rebalancedTotal > 0 ? rebalancedKeep / rebalancedTotal : 0.5;
    const rangeConfidence = clamp01(normalizeRange(similarityRange, SCORE_NEIGHBOR_RANGE_MIN, SCORE_NEIGHBOR_RANGE_MAX));
    const localAgreement = totalWeight > 0 ? Math.abs(keepWeight - badWeight) / totalWeight : 0;
    const confidence = clamp01(0.2 + (rangeConfidence * 0.45) + (localAgreement * 0.35));

    return {
        score: clamp01(0.5 + ((posterior - 0.5) * confidence)),
        confidence,
    };
}

function isManualTrainingPoint(point) {
    return !point?.payload?.source || point.payload.source === MANUAL_SOURCE;
}

async function getTrainingStats() {
    const manualPoints = await getAllManualPoints();
    const good = manualPoints.filter(point => point.payload.isKeep).length;
    const bad = manualPoints.filter(point => !point.payload.isKeep).length;
    const qualityPoints = manualPoints.filter((point) => getQualityFeatureVector(point?.payload?.qualityFeatures)).length;
    return {
        total: manualPoints.length,
        good,
        bad,
        qualityPoints,
    };
}

async function getAdaptiveQualityModel({ immichBase = null, apiKey = null } = {}) {
    if (qualityModelCache) {
        return qualityModelCache;
    }

    const manualPoints = await getAllManualPoints();
    const model = buildAdaptiveQualityModel(manualPoints);
    qualityModelCache = model;
    return model;
}

function combineScores({ clipScore, qualityScore, qualityPenaltyStrength, hasTraining }) {
    if (!hasTraining) {
        return qualityScore;
    }

    const strength = clamp01(Math.max(QUALITY_PENALTY_FLOOR, qualityPenaltyStrength));
    const penalty = (1 - qualityScore) * (0.25 + (0.75 * strength));
    return clamp01(clipScore - penalty);
}

function getQualityPenaltyStrength({ learnedQuality, heuristicQualityScore, signals }) {
    let strength = learnedQuality?.strength ?? SCORE_QUALITY_WEIGHT;
    strength = Math.max(strength, QUALITY_PENALTY_FLOOR);
    strength += Math.max(0, 0.55 - heuristicQualityScore) * 0.45;
    strength += Math.min(0.24, (signals?.reasons?.length ?? 0) * 0.06);
    if (signals?.reasons?.includes('screenshot')) {
        strength += 0.06;
    }
    return clamp01(strength);
}

async function scoreAssets({ assets, immichBase, apiKey, hasTraining }) {
    const adaptiveQualityModel = hasTraining ? await getAdaptiveQualityModel({ immichBase, apiKey }) : null;

    return mapWithConcurrency(
        assets.filter(asset => asset.type === 'IMAGE' && !asset.isArchived && !asset.isTrashed && asset.visibility !== ARCHIVE_VISIBILITY),
        TRIAGE_CONCURRENCY,
        async (asset) => {
            try {
                const thumbUrl = `${immichBase}/api/assets/${asset.id}/thumbnail?size=preview`;
                const image = await fetchAnalysisImage(thumbUrl, apiKey);
                const signals = analyzeImageQuality(image, asset);
                const qualityFeatures = buildQualityFeaturePayload(signals, asset, image);
                const learnedQuality = scoreQualityFromModel(adaptiveQualityModel, qualityFeatures);
                const heuristicQualityScore = signals.overall;
                const qualityScore = learnedQuality?.score ?? heuristicQualityScore;
                const qualityPenaltyStrength = getQualityPenaltyStrength({
                    learnedQuality,
                    heuristicQualityScore,
                    signals,
                });

                let clipScore = 0.5;
                let clipConfidence = 0;
                if (hasTraining) {
                    const embedding = await extractEmbeddingFromImage(image);
                    const searchRes = await qdrant.search(COLLECTION_NAME, {
                        vector: embedding,
                        limit: SCORE_SEARCH_LIMIT,
                        with_payload: true,
                    });
                    const clipResult = scoreFromNeighbors(searchRes.filter(isManualTrainingPoint), adaptiveQualityModel);
                    clipScore = clipResult.score;
                    clipConfidence = clipResult.confidence;
                }

                const score = combineScores({ clipScore, qualityScore, qualityPenaltyStrength, hasTraining });

                return {
                    asset,
                    score,
                    clipScore,
                    clipConfidence,
                    qualityScore,
                    qualityHeuristicScore: heuristicQualityScore,
                    qualityPenaltyStrength,
                    qualityProfile: qualityFeatures.profile,
                    qualityTrainingPoints: adaptiveQualityModel?.featurePointCount ?? 0,
                    signals,
                    imgUrl: thumbUrl,
                };
            } catch (e) {
                console.error(`[Scoring] Skipping asset ${asset.id}:`, e.message);
                return null;
            }
        }
    );
}

function chunkItems(items, chunkSize) {
    const chunks = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function fetchRandomTimelineAssets(immichBase, headers, size) {
    return fetch(`${immichBase}/api/search/random`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ size, visibility: TIMELINE_VISIBILITY }),
    });
}

function sanitizeSettings(raw = {}) {
    const cronExpression = typeof raw.autoArchiveCronExpression === 'string'
        ? raw.autoArchiveCronExpression.trim()
        : AUTO_ARCHIVE_CRON_DEFAULT;
    const reviewCandidateMinScore = clampNumber(raw.reviewCandidateMinScore, 0, 1, REVIEW_CANDIDATE_MIN_SCORE_DEFAULT);
    const reviewCandidateMaxScore = clampNumber(raw.reviewCandidateMaxScore, reviewCandidateMinScore, 1, REVIEW_CANDIDATE_MAX_SCORE_DEFAULT);

    return {
        autoArchive: Boolean(raw.autoArchive),
        autoArchiveConfidenceThreshold: clampNumber(raw.autoArchiveConfidenceThreshold, 0, 1, AUTO_ARCHIVE_CONFIDENCE_THRESHOLD),
        autoArchiveBatchSize: clampInteger(raw.autoArchiveBatchSize, AUTO_ARCHIVE_ARCHIVE_BATCH_MIN, AUTO_ARCHIVE_ARCHIVE_BATCH_MAX, AUTO_ARCHIVE_ARCHIVE_BATCH_SIZE),
        autoArchiveScanBatchSize: clampInteger(raw.autoArchiveScanBatchSize, AUTO_ARCHIVE_SCAN_BATCH_MIN, AUTO_ARCHIVE_SCAN_BATCH_MAX, AUTO_ARCHIVE_SCAN_BATCH_SIZE),
        autoArchiveScanBatchesPerRun: clampInteger(raw.autoArchiveScanBatchesPerRun, AUTO_ARCHIVE_SCAN_BATCHES_MIN, AUTO_ARCHIVE_SCAN_BATCHES_MAX, AUTO_ARCHIVE_BATCHES_PER_RUN),
        autoArchiveCronExpression: cron.validate(cronExpression) ? cronExpression : AUTO_ARCHIVE_CRON_DEFAULT,
        reviewCandidateMinScore,
        reviewCandidateMaxScore,
        triageBatchSize: clampInteger(raw.triageBatchSize, TRIAGE_BATCH_MIN, TRIAGE_BATCH_MAX, TRIAGE_BATCH_DEFAULT),
    };
}

async function fetchAssetDetails(immichBase, apiKey, assetId) {
    const response = await fetch(`${immichBase}/api/assets/${assetId}`, {
        headers: {
            'x-api-key': apiKey,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Immich asset lookup failed for ${assetId}: ${response.status}`);
    }

    return response.json();
}

async function archiveAssetBatch(immichBase, headers, assetIds) {
    const response = await fetch(`${immichBase}/api/assets`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: assetIds, visibility: ARCHIVE_VISIBILITY }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Immich archive request failed (${response.status}): ${errorText}`);
    }
}

async function ensureArchivedAlbum(immichBase, apiKey) {
    const headers = {
        'x-api-key': apiKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };

    const response = await fetch(`${immichBase}/api/albums`, { headers });
    if (!response.ok) {
        throw new Error(`Immich album lookup failed: ${response.status}`);
    }

    const albums = await response.json();
    const existingAlbum = albums.find((album) => String(album.albumName || '').toLowerCase() === ARCHIVED_ALBUM_NAME);
    if (existingAlbum) {
        return existingAlbum;
    }

    const createResponse = await fetch(`${immichBase}/api/albums`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ albumName: ARCHIVED_ALBUM_NAME }),
    });

    if (!createResponse.ok) {
        throw new Error(`Immich album creation failed: ${createResponse.status}`);
    }

    return createResponse.json();
}

async function addAssetsToAlbum(immichBase, apiKey, albumId, assetIds) {
    const addedIds = [];
    const failedItems = [];

    for (const batchIds of chunkItems(assetIds, ALBUM_ADD_CHUNK_SIZE)) {
        const response = await fetch(`${immichBase}/api/albums/${albumId}/assets`, {
            method: 'PUT',
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ids: batchIds }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            failedItems.push(...batchIds.map((id) => ({ id, errorMessage: errorText || `HTTP ${response.status}` })));
            logEvent('ERROR', 'Album', 'Chunk add failed', { albumId, count: batchIds.length, status: response.status, errorText });
            continue;
        }

        const results = await response.json().catch(() => []);
        const statuses = Array.isArray(results) ? results : [];
        if (statuses.length === 0) {
            addedIds.push(...batchIds);
            continue;
        }

        for (const item of statuses) {
            if (item?.success) {
                addedIds.push(item.id);
                continue;
            }

            const errorMessage = item?.errorMessage || item?.error || 'Unknown album add error';
            if (/already|exists|duplicate/i.test(String(errorMessage))) {
                addedIds.push(item.id);
                continue;
            }

            failedItems.push({ id: item?.id || 'unknown', errorMessage });
        }
    }

    if (failedItems.length > 0) {
        logEvent('WARN', 'Album', 'Some assets failed to add to archived album', {
            albumId,
            failedCount: failedItems.length,
            sample: failedItems.slice(0, 5),
        });
    }

    return { addedIds, failedItems };
}

async function archiveAssetsWithVerification({ immichBase, headers, apiKey, assetIds, chunkSize }) {
    const verifiedArchivedIds = [];

    for (const batchIds of chunkItems(assetIds, chunkSize)) {
        logEvent('INFO', 'Archive', 'Submitting archive batch', { count: batchIds.length });
        await archiveAssetBatch(immichBase, headers, batchIds);

        for (const assetId of batchIds) {
            try {
                const details = await fetchAssetDetails(immichBase, apiKey, assetId);
                if (details.isArchived || details.visibility === ARCHIVE_VISIBILITY) {
                    verifiedArchivedIds.push(assetId);
                    continue;
                }

                await archiveAssetBatch(immichBase, headers, [assetId]);
                const retriedDetails = await fetchAssetDetails(immichBase, apiKey, assetId);
                if (retriedDetails.isArchived || retriedDetails.visibility === ARCHIVE_VISIBILITY) {
                    verifiedArchivedIds.push(assetId);
                } else {
                    logEvent('WARN', 'Archive', 'Asset did not verify as archived after retry', { assetId });
                }
            } catch (error) {
                logEvent('WARN', 'Archive', 'Verification failed', { assetId, error: error.message });
            }
        }
    }

    return verifiedArchivedIds;
}

// ---- API Routes ----

/**
 * POST /api/swipe
 * Body: { assetId, immichUrl, apiKey, isKeep }
 */
app.post('/api/swipe', async (req, res) => {
    try {
        const { assetId, immichUrl, apiKey, isKeep, source = MANUAL_SOURCE } = req.body;
        if (!assetId || !immichUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing assetId, immichUrl, or apiKey' });
        }
        if (source !== MANUAL_SOURCE) {
            return res.status(400).json({ error: 'Only manual training writes are accepted' });
        }

        if (!await ensureQdrantReady()) {
            console.warn('[Swipe] Qdrant not ready, storing placeholder');
            return res.json({ success: true, warning: 'Qdrant not ready' });
        }

        const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
        const assetDetails = await fetchAssetDetails(immichBase, apiKey, assetId).catch(() => null);
        const thumbUrl = `${immichBase}/api/assets/${assetId}/thumbnail?size=preview`;
        const image = await fetchAnalysisImage(thumbUrl, apiKey);
        const signals = analyzeImageQuality(image, assetDetails);
        const qualityFeatures = buildQualityFeaturePayload(signals, assetDetails, image);
        const embedding = await extractEmbeddingFromImage(image);

        await qdrant.upsert(COLLECTION_NAME, {
            wait: true,
            points: [{
                id: assetId,          // Qdrant JS client supports UUID strings
                vector: embedding,
                payload: {
                    isKeep,
                    source: MANUAL_SOURCE,
                    trainedAt: new Date().toISOString(),
                    qualityFeatures,
                },
            }],
        });
        qualityModelCache = null;
        res.json({ success: true });
    } catch (e) {
        console.error('[Swipe] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/triage
 * Headers: x-target-host, x-api-key
 * Returns scored asset list sorted worst-first.
 */
app.get('/api/triage', async (req, res) => {
    try {
        const immichUrl = req.headers['x-target-host'];
        const apiKey = req.headers['x-api-key'];
        const requestedCount = Number.parseInt(String(req.query.count ?? appSettings.triageBatchSize ?? TRIAGE_BATCH_DEFAULT), 10);
        const batchSize = Math.min(Math.max(Number.isNaN(requestedCount) ? TRIAGE_BATCH_DEFAULT : requestedCount, 1), TRIAGE_BATCH_MAX);
        if (!immichUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing x-target-host or x-api-key headers' });
        }

        const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
        const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };
        const qdrantAvailable = await ensureQdrantReady();
        if (!qdrantAvailable) {
            console.warn('[Triage] Qdrant not ready, falling back to heuristic-only scoring');
        }

        // 1. Fetch a bounded random sample from Immich
        const randResp = await fetchRandomTimelineAssets(immichBase, headers, batchSize);
        if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
        const assets = await randResp.json();

        // 2. Check how much training data we have
        let hasTraining = false;
        if (qdrantAvailable) {
            try {
                const trainingStats = await getTrainingStats();
                hasTraining = trainingStats.total >= MIN_TRAINING_POINTS;
            } catch (_) { /* collection might not exist yet */ }
        }

        // 3. Score candidate images with limited concurrency
        const scoredAssets = await scoreAssets({ assets, immichBase, apiKey, hasTraining });

        res.json(scoredAssets.sort((a, b) => a.score - b.score));
    } catch (e) {
        console.error('[Triage] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/review-candidates', async (req, res) => {
    try {
        const immichUrl = req.headers['x-target-host'];
        const apiKey = req.headers['x-api-key'];
        const requestedCount = Number.parseInt(String(req.query.count ?? REVIEW_CANDIDATE_TARGET_DEFAULT), 10);
        const requestedScanBatchSize = Number.parseInt(String(req.query.scanBatchSize ?? REVIEW_CANDIDATE_SCAN_BATCH_SIZE), 10);
        const requestedScanBatches = Number.parseInt(String(req.query.scanBatches ?? REVIEW_CANDIDATE_SCAN_BATCHES_DEFAULT), 10);
        const minScore = clampNumber(req.query.minScore, 0, 1, appSettings.reviewCandidateMinScore ?? REVIEW_CANDIDATE_MIN_SCORE_DEFAULT);
        const maxScore = clampNumber(req.query.maxScore, minScore, 1, appSettings.reviewCandidateMaxScore ?? REVIEW_CANDIDATE_MAX_SCORE_DEFAULT);
        const targetCount = clampInteger(requestedCount, REVIEW_CANDIDATE_TARGET_MIN, REVIEW_CANDIDATE_TARGET_MAX, REVIEW_CANDIDATE_TARGET_DEFAULT);
        const scanBatchSize = clampInteger(requestedScanBatchSize, REVIEW_CANDIDATE_SCAN_BATCH_MIN, REVIEW_CANDIDATE_SCAN_BATCH_MAX, REVIEW_CANDIDATE_SCAN_BATCH_SIZE);
        const scanBatches = clampInteger(requestedScanBatches, REVIEW_CANDIDATE_SCAN_BATCHES_MIN, REVIEW_CANDIDATE_SCAN_BATCHES_MAX, REVIEW_CANDIDATE_SCAN_BATCHES_DEFAULT);

        if (!immichUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing x-target-host or x-api-key headers' });
        }

        const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
        const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };
        let hasTraining = false;

        if (await ensureQdrantReady()) {
            try {
                const trainingStats = await getTrainingStats();
                hasTraining = trainingStats.total >= MIN_TRAINING_POINTS;
            } catch (_) {
                hasTraining = false;
            }
        }

        if (!hasTraining) {
            return res.json([]);
        }

        const candidateMap = new Map();
        for (let batchIndex = 0; batchIndex < scanBatches; batchIndex += 1) {
            const randResp = await fetchRandomTimelineAssets(immichBase, headers, scanBatchSize);
            if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
            const assets = await randResp.json();
            for (const asset of assets) {
                if (asset.type === 'IMAGE' && !asset.isTrashed && asset.visibility !== ARCHIVE_VISIBILITY && !asset.isArchived) {
                    candidateMap.set(asset.id, asset);
                }
            }
        }

        const scoredAssets = await scoreAssets({
            assets: Array.from(candidateMap.values()),
            immichBase,
            apiKey,
            hasTraining: true,
        });

        const candidates = scoredAssets
            .filter((item) => item.score >= minScore && item.score <= maxScore)
            .sort((left, right) => Math.abs(left.score - 0.5) - Math.abs(right.score - 0.5))
            .slice(0, targetCount);

        res.json(candidates);
    } catch (e) {
        console.error('[ReviewCandidates] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/triage/apply', async (req, res) => {
    try {
        const { immichUrl, apiKey, assetIds } = req.body || {};
        if (!immichUrl || !apiKey) {
            return res.status(400).json({ error: 'Missing immichUrl or apiKey' });
        }
        if (!Array.isArray(assetIds)) {
            return res.status(400).json({ error: 'assetIds must be an array' });
        }

        const normalizedAssetIds = [...new Set(assetIds.filter((id) => typeof id === 'string' && id.length > 0))];
        if (normalizedAssetIds.length === 0) {
            return res.json({ success: true, archivedCount: 0, archivedIds: [] });
        }

        const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
        const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };
        logEvent('INFO', 'TriageApply', 'Applying manual triage archive batch', { requestedCount: normalizedAssetIds.length });
        const verifiedArchivedIds = await archiveAssetsWithVerification({
            immichBase,
            headers,
            apiKey,
            assetIds: normalizedAssetIds,
            chunkSize: Math.min(ARCHIVE_REQUEST_CHUNK_SIZE, AUTO_ARCHIVE_ARCHIVE_BATCH_MAX),
        });

        let albumAddFailedCount = 0;

        if (verifiedArchivedIds.length > 0) {
            const archivedAlbum = await ensureArchivedAlbum(immichBase, apiKey);
            const albumResult = await addAssetsToAlbum(immichBase, apiKey, archivedAlbum.id, verifiedArchivedIds);
            albumAddFailedCount = albumResult.failedItems.length;
        }

        logEvent('INFO', 'TriageApply', 'Manual triage archive completed', {
            requestedCount: normalizedAssetIds.length,
            archivedCount: verifiedArchivedIds.length,
            albumAddFailedCount,
        });

        res.json({
            success: true,
            archivedCount: verifiedArchivedIds.length,
            archivedIds: verifiedArchivedIds,
            requestedCount: normalizedAssetIds.length,
            albumAddFailedCount,
        });
    } catch (e) {
        logEvent('ERROR', 'TriageApply', 'Manual triage archive failed', { error: e.message });
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/stats
 * Returns count of good/bad points in the collection.
 */
app.get('/api/stats', async (_req, res) => {
    try {
        await ensureQdrantReady();
        res.json(await getTrainingStats());
    } catch (e) {
        res.json({ total: 0, good: 0, bad: 0 });
    }
});

// ---- Settings persistence ----
const SETTINGS_FILE = path.join(APP_DATA_DIR, 'settings.json');
let appSettings = sanitizeSettings();

fs.mkdirSync(APP_DATA_DIR, { recursive: true });

function scheduleAutoArchiveTask() {
    if (autoArchiveTask) {
        autoArchiveTask.stop();
        if (typeof autoArchiveTask.destroy === 'function') {
            autoArchiveTask.destroy();
        }
    }

    autoArchiveTask = cron.schedule(appSettings.autoArchiveCronExpression, async () => {
        try {
            await runAutoArchive();
        } catch (e) {
            console.error('[Cron] Scheduled run failed:', e.message);
        }
    });

    console.log(`[Cron] Scheduled auto-archive with '${appSettings.autoArchiveCronExpression}'.`);
}

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            appSettings = sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')));
            console.log('[Settings] Loaded:', appSettings);
        }
    } catch (e) {
        console.warn('[Settings] Load failed:', e.message);
    }
}
loadSettings();
scheduleAutoArchiveTask();

app.get('/api/settings', (req, res) => {
    res.json(appSettings);
});

app.get('/api/logs', (_req, res) => {
    try {
        if (!fs.existsSync(LOG_FILE)) {
            return res.json({ lines: [] });
        }

        const contents = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = contents.split('\n').filter(Boolean).slice(-LOG_TAIL_LINE_LIMIT);
        res.json({ lines });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/settings', (req, res) => {
    appSettings = sanitizeSettings({ ...appSettings, ...req.body });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
    scheduleAutoArchiveTask();
    res.json({ success: true, settings: appSettings });
});

// SPA fallback — must be AFTER api routes
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Update the proxy route definition to use the wildcard capture
const proxyRoute = app._router.stack.find(s => s.route && s.route.path === '/api/immich-proxy/*');
if (proxyRoute) {
    // This is a hacky way to do it in Express without re-declaring, 
    // but cleaner to just use the right syntax in the first place.
}
// I will just re-write the route registration properly in the first chunk instead.

// ---- Background Cron Archiver ----
const IMMICH_URL = process.env.AUTO_ARCHIVE_IMMICH_URL || process.env.VITE_SERVER_URL || null;
const API_KEY = process.env.AUTO_ARCHIVE_API_KEY || process.env.VITE_USER_1_API_KEY || null;

async function runAutoArchive(options = {}) {
    const { force = false, dryRun = false } = options;

    if (!force && !appSettings.autoArchive) {
        return { skipped: true, reason: 'disabled' };
    }
    if (!IMMICH_URL || !API_KEY) {
        console.log('[Cron] Skipping: VITE_SERVER_URL or VITE_USER_1_API_KEY not set.');
        return { skipped: true, reason: 'missing-env' };
    }

    try {
        if (!await ensureQdrantReady()) {
            console.log('[Cron] Skipping: Qdrant is not ready.');
            return { skipped: true, reason: 'qdrant-not-ready' };
        }
        const trainingStats = await getTrainingStats();
        if (trainingStats.total < AUTO_ARCHIVE_MIN_POINTS) {
            console.log(`[Cron] Skipping: Only ${trainingStats.total} vectors in Qdrant (need ≥${AUTO_ARCHIVE_MIN_POINTS}).`);
            return { skipped: true, reason: 'not-enough-vectors', vectorCount: trainingStats.total };
        }

        const immichBase = IMMICH_URL.endsWith('/') ? IMMICH_URL.slice(0, -1) : IMMICH_URL;
        const headers = { 'x-api-key': API_KEY, 'Accept': 'application/json' };

        const candidateMap = new Map();
        const scanBatchSize = Number(appSettings.autoArchiveScanBatchSize ?? AUTO_ARCHIVE_SCAN_BATCH_SIZE);
        const scanBatchesPerRun = Number(appSettings.autoArchiveScanBatchesPerRun ?? AUTO_ARCHIVE_BATCHES_PER_RUN);
        logEvent('INFO', 'Cron', 'Starting auto-archive run', {
            dryRun,
            threshold: Number(appSettings.autoArchiveConfidenceThreshold ?? AUTO_ARCHIVE_CONFIDENCE_THRESHOLD),
            scanBatchSize,
            scanBatchesPerRun,
        });
        for (let batchIndex = 0; batchIndex < scanBatchesPerRun; batchIndex += 1) {
            const randResp = await fetchRandomTimelineAssets(immichBase, headers, scanBatchSize);
            if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
            const assets = await randResp.json();
            for (const asset of assets) {
                if (asset.type === 'IMAGE' && !asset.isTrashed && asset.visibility !== ARCHIVE_VISIBILITY && !asset.isArchived) {
                    candidateMap.set(asset.id, asset);
                }
            }
        }

        const scoredAssets = await scoreAssets({
            assets: Array.from(candidateMap.values()),
            immichBase,
            apiKey: API_KEY,
            hasTraining: true,
        });

        const threshold = Number(appSettings.autoArchiveConfidenceThreshold ?? AUTO_ARCHIVE_CONFIDENCE_THRESHOLD);
        const maxArchiveCount = Number(appSettings.autoArchiveBatchSize ?? AUTO_ARCHIVE_ARCHIVE_BATCH_SIZE);
        const badAssetIds = scoredAssets
            .filter(item => item.score <= threshold)
            .sort((left, right) => left.score - right.score)
            .slice(0, maxArchiveCount)
            .map(item => item.asset.id);

        logEvent('INFO', 'Cron', 'Auto-archive scoring completed', {
            scannedCount: candidateMap.size,
            threshold,
            candidateBelowThreshold: badAssetIds.length,
            lowestScores: scoredAssets.slice().sort((left, right) => left.score - right.score).slice(0, 5).map((item) => ({ id: item.asset.id, score: item.score })),
        });

        if (badAssetIds.length > 0) {
            if (dryRun) {
                logEvent('INFO', 'Cron', 'Dry run selected archive candidates', { count: badAssetIds.length });
            } else {
                logEvent('INFO', 'Cron', 'Archiving candidates', { count: badAssetIds.length });
                const verifiedArchivedIds = await archiveAssetsWithVerification({
                    immichBase,
                    headers,
                    apiKey: API_KEY,
                    assetIds: badAssetIds,
                    chunkSize: Math.min(ARCHIVE_REQUEST_CHUNK_SIZE, maxArchiveCount),
                });
                let albumAddFailedCount = 0;
                if (verifiedArchivedIds.length > 0) {
                    const archivedAlbum = await ensureArchivedAlbum(immichBase, API_KEY);
                    const albumResult = await addAssetsToAlbum(immichBase, API_KEY, archivedAlbum.id, verifiedArchivedIds);
                    albumAddFailedCount = albumResult.failedItems.length;
                }
                logEvent('INFO', 'Cron', 'Auto-archive completed', {
                    verifiedArchivedCount: verifiedArchivedIds.length,
                    albumAddFailedCount,
                });
                return {
                    skipped: false,
                    archivedCount: verifiedArchivedIds.length,
                    archivedIds: verifiedArchivedIds,
                    threshold,
                    scannedCount: candidateMap.size,
                    albumAddFailedCount,
                };
            }
            return {
                skipped: false,
                archivedCount: badAssetIds.length,
                archivedIds: badAssetIds,
                threshold,
                scannedCount: candidateMap.size,
            };
        } else {
            logEvent('INFO', 'Cron', 'No archive candidates below threshold', { threshold, scannedCount: candidateMap.size });
            return { skipped: false, archivedCount: 0, archivedIds: [], threshold, scannedCount: candidateMap.size };
        }
    } catch (e) {
        logEvent('ERROR', 'Cron', 'Auto-archive run failed', { error: e.message });
        throw e;
    }
}

app.post('/api/auto-archive/run', async (req, res) => {
    try {
        const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
        const result = await runAutoArchive({ force: true, dryRun });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- Boot ----
const PORT = process.env.PORT || 80;

async function boot() {
    await setupQdrant();
    // Pre-warm model on startup so first request isn't slow
    await initModel().catch(e => console.warn('[Model] Pre-warm failed:', e.message));
    app.listen(PORT, () => {
        console.log(`[Server] Listening on port ${PORT}`);
    });
}

boot();
