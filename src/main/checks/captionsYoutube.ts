// live-captions' YouTube caption push, over its tRPC API on :3000 (tRPC 11,
// no transformer). YouTube's HTTP caption ingestion is
// http://upload.youtube.com/closedcaption?cid=<stream key>.

const BASE = 'http://127.0.0.1:3000/trpc';

export interface CaptionPushStatus {
    enabled: boolean;
    url: string | null;
    running: boolean;
    lastPushAt: number | null;
    queueDepth: number;
    lastError: string | null;
}

export const captionUrl = (key: string) =>
    `http://upload.youtube.com/closedcaption?cid=${key}`;

export function keyFromCaptionUrl(url: string | null): string | null {
    if (!url) return null;
    const m = /[?&]cid=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
}

async function mutate(proc: string, input: unknown) {
    const rsp = await fetch(`${BASE}/${proc}?batch=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ '0': input }),
        signal: AbortSignal.timeout(5000),
    });
    if (!rsp.ok) throw new Error(`live-captions ${proc}: ${rsp.status}`);
}

export async function setCaptionKey(key: string) {
    await mutate('youtubeCaptions.setUrl', { url: captionUrl(key) });
    await mutate('youtubeCaptions.setEnabled', { enabled: true });
}

export const enableCaptionPush = () =>
    mutate('youtubeCaptions.setEnabled', { enabled: true });
