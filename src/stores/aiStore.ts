import { defineStore } from 'pinia';
import { useImmich } from '@/composables/useImmich';

export const useAiStore = defineStore('aiStore', () => {
    const immich = useImmich();

    function getBackendUrl() {
        return window.location.origin;
    }

    function getImmichCredentials() {
        const headers = immich.getAuthHeaders();
        return {
            immichUrl: headers['X-Target-Host'],
            apiKey: headers['x-api-key'],
        };
    }

    /**
     * Record a single swipe decision. Fire-and-forget for UI speed.
     */
    async function trainOnAsset(_image: HTMLImageElement | null, isGood: boolean) {
        if (!immich.currentAsset.value) return;
        try {
            const assetId = immich.currentAsset.value.id;
            const { immichUrl, apiKey } = getImmichCredentials();

            fetch(getBackendUrl() + '/api/swipe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assetId, immichUrl, apiKey, isKeep: isGood }),
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
    async function fetchTriageBatch() {
        const { immichUrl, apiKey } = getImmichCredentials();
        const resp = await fetch(getBackendUrl() + '/api/triage', {
            headers: {
                'x-target-host': immichUrl,
                'x-api-key': apiKey,
            },
        });
        if (!resp.ok) throw new Error('Failed to fetch triage batch.');
        return await resp.json();
    }

    return { trainOnAsset, trainOnBatch, fetchTriageBatch };
});
