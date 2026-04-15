import { defineStore } from 'pinia';
import { useAuthStore } from '@/stores/auth';

export const useAiStore = defineStore('aiStore', () => {
    const authStore = useAuthStore();

    function getBackendUrl() {
        return window.location.origin;
    }

    function getImmichCredentials() {
        return {
            immichUrl: authStore.immichBaseUrl,
            apiKey: authStore.apiKey,
        };
    }

    /**
     * Record a single swipe decision. Fire-and-forget for UI speed.
     */
    async function trainOnAsset(assetId: string | null, isGood: boolean) {
        if (!assetId) return;
        try {
            const { immichUrl, apiKey } = getImmichCredentials();
            if (!immichUrl || !apiKey) return;

            fetch(getBackendUrl() + '/api/swipe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assetId, immichUrl, apiKey, isKeep: isGood, source: 'manual' }),
            });
        } catch (e) {
            console.error('[AI] Swipe error:', e);
        }
    }

    /**
     * Submit a batch of triage decisions.
     */
    async function trainOnBatch(items: { asset: { id: string }; selected: boolean }[]) {
        const { immichUrl, apiKey } = getImmichCredentials();
        if (!immichUrl || !apiKey) return;
        try {
            for (const item of items) {
                await fetch(getBackendUrl() + '/api/swipe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        assetId: item.asset.id,
                        immichUrl,
                        apiKey,
                        isKeep: !item.selected, // selected = bad in Triage UI
                        source: 'manual',
                    }),
                });
            }
        } catch (e) {
            console.error('[AI] Batch error:', e);
        }
    }

    async function applyTriageBatch(items: { asset: { id: string }; selected: boolean }[]) {
        const { immichUrl, apiKey } = getImmichCredentials();
        if (!immichUrl || !apiKey) {
            return { archivedCount: 0, archivedIds: [] };
        }

        const assetIds = items
            .filter((item) => item.selected)
            .map((item) => item.asset.id);

        const resp = await fetch(getBackendUrl() + '/api/triage/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ immichUrl, apiKey, assetIds }),
        });

        if (!resp.ok) {
            throw new Error('Failed to apply triage archive batch.');
        }

        return await resp.json();
    }

    /**
     * Fetch 250 scored assets from the backend triage endpoint.
     */
    async function fetchTriageBatch(count?: number) {
        const { immichUrl, apiKey } = getImmichCredentials();
        const query = typeof count === 'number' ? `?count=${count}` : '';
        const resp = await fetch(`${getBackendUrl()}/api/triage${query}`, {
            headers: {
                'x-target-host': immichUrl,
                'x-api-key': apiKey,
            },
        });
        if (!resp.ok) throw new Error('Failed to fetch triage batch.');
        return await resp.json();
    }

    async function fetchStats() {
        const resp = await fetch(getBackendUrl() + '/api/stats');
        if (!resp.ok) throw new Error('Failed to fetch training stats.');
        return await resp.json();
    }

    async function fetchSettings() {
        const resp = await fetch(getBackendUrl() + '/api/settings');
        if (!resp.ok) throw new Error('Failed to fetch app settings.');
        return await resp.json();
    }

    async function saveSettings(settings: Record<string, unknown>) {
        const resp = await fetch(getBackendUrl() + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        if (!resp.ok) throw new Error('Failed to save app settings.');
        return await resp.json();
    }

    async function runAutoArchive(dryRun: boolean = false) {
        const resp = await fetch(`${getBackendUrl()}/api/auto-archive/run${dryRun ? '?dryRun=true' : ''}`, {
            method: 'POST',
        });
        if (!resp.ok) throw new Error('Failed to run auto-archive.');
        return await resp.json();
    }

    return { trainOnAsset, trainOnBatch, applyTriageBatch, fetchTriageBatch, fetchStats, fetchSettings, saveSettings, runAutoArchive };
});
