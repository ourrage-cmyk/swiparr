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
const TRIAGE_BATCH_DEFAULT = 60;
const TRIAGE_BATCH_MIN = 12;
const TRIAGE_BATCH_MAX = 250;
const TRIAGE_CONCURRENCY = 4;
const MIN_TRAINING_POINTS = 5;
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

/**
 * Download an image from Immich, convert to a RawImage, then run CLIP.
 * Returns a 512-dim Float32 array.
 */
async function extractEmbeddingFromUrl(imageUrl, apiKey) {
    const resp = await fetch(imageUrl, {
        headers: { 'x-api-key': apiKey, 'Accept': 'application/octet-stream' },
    });
    if (!resp.ok) throw new Error(`Fetch failed ${resp.status} for ${imageUrl}`);
    const buffer = Buffer.from(await resp.arrayBuffer());

    // RawImage.fromBlob works with a Blob; in Node we create one from the buffer
    const blob = new Blob([buffer], { type: resp.headers.get('content-type') || 'image/jpeg' });
    const image = await RawImage.fromBlob(blob);

    const ext = await initModel();
    const output = await ext(image, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

function scoreFromNeighbors(searchRes) {
    const top5 = searchRes.slice(0, 5);
    if (top5.length === 0) {
        return 0.5;
    }
    const nearestBad = top5.filter(p => p.payload && !p.payload.isKeep).length;
    return 1 - (nearestBad / top5.length);
}

function isManualTrainingPoint(point) {
    return !point?.payload?.source || point.payload.source === MANUAL_SOURCE;
}

async function getTrainingStats() {
    const allPoints = await qdrant.scroll(COLLECTION_NAME, {
        limit: 10000,
        with_payload: true,
    });
    const manualPoints = allPoints.points.filter(isManualTrainingPoint);
    const good = manualPoints.filter(point => point.payload.isKeep).length;
    const bad = manualPoints.filter(point => !point.payload.isKeep).length;
    return {
        total: manualPoints.length,
        good,
        bad,
    };
}

async function scoreAssets({ assets, immichBase, apiKey, hasTraining }) {
    return mapWithConcurrency(
        assets.filter(asset => asset.type === 'IMAGE' && !asset.isArchived),
        TRIAGE_CONCURRENCY,
        async (asset) => {
            try {
                const thumbUrl = `${immichBase}/api/assets/${asset.id}/thumbnail?size=preview`;
                const embedding = await extractEmbeddingFromUrl(thumbUrl, apiKey);

                let score = 0.5;
                if (hasTraining) {
                    const searchRes = await qdrant.search(COLLECTION_NAME, {
                        vector: embedding,
                        limit: 50,
                        with_payload: true,
                    });
                    score = scoreFromNeighbors(searchRes.filter(isManualTrainingPoint));
                }

                return {
                    asset,
                    score,
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

function sanitizeSettings(raw = {}) {
    const cronExpression = typeof raw.autoArchiveCronExpression === 'string'
        ? raw.autoArchiveCronExpression.trim()
        : AUTO_ARCHIVE_CRON_DEFAULT;

    return {
        autoArchive: Boolean(raw.autoArchive),
        autoArchiveConfidenceThreshold: clampNumber(raw.autoArchiveConfidenceThreshold, 0, 1, AUTO_ARCHIVE_CONFIDENCE_THRESHOLD),
        autoArchiveBatchSize: clampInteger(raw.autoArchiveBatchSize, AUTO_ARCHIVE_ARCHIVE_BATCH_MIN, AUTO_ARCHIVE_ARCHIVE_BATCH_MAX, AUTO_ARCHIVE_ARCHIVE_BATCH_SIZE),
        autoArchiveScanBatchSize: clampInteger(raw.autoArchiveScanBatchSize, AUTO_ARCHIVE_SCAN_BATCH_MIN, AUTO_ARCHIVE_SCAN_BATCH_MAX, AUTO_ARCHIVE_SCAN_BATCH_SIZE),
        autoArchiveScanBatchesPerRun: clampInteger(raw.autoArchiveScanBatchesPerRun, AUTO_ARCHIVE_SCAN_BATCHES_MIN, AUTO_ARCHIVE_SCAN_BATCHES_MAX, AUTO_ARCHIVE_BATCHES_PER_RUN),
        autoArchiveCronExpression: cron.validate(cronExpression) ? cronExpression : AUTO_ARCHIVE_CRON_DEFAULT,
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
        body: JSON.stringify({ ids: assetIds, isArchived: true }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Immich archive request failed (${response.status}): ${errorText}`);
    }
}

async function archiveAssetsWithVerification({ immichBase, headers, apiKey, assetIds, chunkSize }) {
    const verifiedArchivedIds = [];

    for (const batchIds of chunkItems(assetIds, chunkSize)) {
        await archiveAssetBatch(immichBase, headers, batchIds);

        for (const assetId of batchIds) {
            try {
                const details = await fetchAssetDetails(immichBase, apiKey, assetId);
                if (details.isArchived) {
                    verifiedArchivedIds.push(assetId);
                    continue;
                }

                await archiveAssetBatch(immichBase, headers, [assetId]);
                const retriedDetails = await fetchAssetDetails(immichBase, apiKey, assetId);
                if (retriedDetails.isArchived) {
                    verifiedArchivedIds.push(assetId);
                } else {
                    console.warn(`[Cron] Asset ${assetId} did not verify as archived after retry.`);
                }
            } catch (error) {
                console.warn(`[Cron] Verification failed for ${assetId}: ${error.message}`);
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
        const thumbUrl = `${immichBase}/api/assets/${assetId}/thumbnail?size=preview`;
        const embedding = await extractEmbeddingFromUrl(thumbUrl, apiKey);

        await qdrant.upsert(COLLECTION_NAME, {
            wait: true,
            points: [{
                id: assetId,          // Qdrant JS client supports UUID strings
                vector: embedding,
                payload: {
                    isKeep,
                    source: MANUAL_SOURCE,
                    trainedAt: new Date().toISOString(),
                },
            }],
        });
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

        if (!await ensureQdrantReady()) {
            console.warn('[Triage] Qdrant not ready, returning random unscored assets');
            const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
            const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };
            const randResp = await fetch(`${immichBase}/api/assets/random?count=${batchSize}`, { headers });
            if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
            const assets = await randResp.json();
            const scoredAssets = assets
                .filter(a => a.type === 'IMAGE')
                .map((asset, idx) => ({
                    asset,
                    score: 0.5,
                    imgUrl: `${immichBase}/api/assets/${asset.id}/thumbnail?size=preview`,
                }));
            return res.json(scoredAssets);
        }

        const immichBase = immichUrl.endsWith('/') ? immichUrl.slice(0, -1) : immichUrl;
        const headers = { 'x-api-key': apiKey, 'Accept': 'application/json' };

        // 1. Fetch a bounded random sample from Immich
        const randResp = await fetch(`${immichBase}/api/assets/random?count=${batchSize}`, { headers });
        if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
        const assets = await randResp.json();

        // 2. Check how much training data we have
        let hasTraining = false;
        try {
            const trainingStats = await getTrainingStats();
            hasTraining = trainingStats.total >= MIN_TRAINING_POINTS;
        } catch (_) { /* collection might not exist yet */ }

        // 3. Score candidate images with limited concurrency
        const scoredAssets = await scoreAssets({ assets, immichBase, apiKey, hasTraining });

        res.json(scoredAssets.sort((a, b) => a.score - b.score));
    } catch (e) {
        console.error('[Triage] Error:', e.message);
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
        for (let batchIndex = 0; batchIndex < scanBatchesPerRun; batchIndex += 1) {
            const randResp = await fetch(`${immichBase}/api/assets/random?count=${scanBatchSize}`, { headers });
            if (!randResp.ok) throw new Error('Immich API Error ' + randResp.status);
            const assets = await randResp.json();
            for (const asset of assets) {
                if (asset.type === 'IMAGE' && !asset.isArchived) {
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

        if (badAssetIds.length > 0) {
            if (dryRun) {
                console.log(`[Cron] Dry run selected ${badAssetIds.length} bad assets.`);
            } else {
                console.log(`[Cron] Archiving ${badAssetIds.length} bad assets in batches.`);
                const verifiedArchivedIds = await archiveAssetsWithVerification({
                    immichBase,
                    headers,
                    apiKey: API_KEY,
                    assetIds: badAssetIds,
                    chunkSize: maxArchiveCount,
                });
                console.log(`[Cron] Verified ${verifiedArchivedIds.length} archived assets.`);
                return {
                    skipped: false,
                    archivedCount: verifiedArchivedIds.length,
                    archivedIds: verifiedArchivedIds,
                    threshold,
                    scannedCount: candidateMap.size,
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
            console.log('[Cron] No bad assets found this cycle.');
            return { skipped: false, archivedCount: 0, archivedIds: [], threshold, scannedCount: candidateMap.size };
        }
    } catch (e) {
        console.error('[Cron] Error:', e.message);
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
