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

    /**
     * Fetch 250 scored assets from the backend triage endpoint.
     */
    async function fetchTriageBatch(count: number = 60) {
        const { immichUrl, apiKey } = getImmichCredentials();
        const resp = await fetch(`${getBackendUrl()}/api/triage?count=${count}`, {
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

    return { trainOnAsset, trainOnBatch, fetchTriageBatch, fetchStats };
});
