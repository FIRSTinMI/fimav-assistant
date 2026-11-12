import http from 'http';
import { networkInterfaces } from 'os';
import log from 'electron-log';
import HWPing from '../addons/hw-ping';
import AutoAV from '../addons/autoav';
import LiveCaptions from '../addons/live-captions';
import getVmixBandwidth, { VmixBandwidth } from '../vmixBandwidth';
import { listMatches } from '../recordings/matchStore';
import FtcScorekeeper from '../addons/ftc-scorekeeper';
import YoutubeUploaderAddon from '../addons/upload-helper';
import AudienceDisplayAddon from '../addons/audience-display';
import {
    companionUrl,
    CUSTOM_AD_URL,
    readCustomAd,
    readFmsAutomation,
} from '../bitfocus';
import { getStore } from '../store';
import Checks from '../checks/engine';

// Read-only status API on the LAN, one endpoint per subsystem, for Companion
// or anything else on the cart network to poll. No auth by design: every
// response is status only and nothing here changes state.
export const STATUS_API_PORT = 7780;

// vMix status is built inside register-events (it owns the stream-key
// validation state), so it is passed in rather than rebuilt here.
export type StatusApiSources = {
    vmixStatus: () => Promise<{
        reachable: boolean;
        recording: boolean;
        streaming: boolean;
        [key: string]: unknown;
    }>;
};

const sleep = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

// The first bandwidth read after a quiet period has no baseline and reports
// warming with no streams; read once more past the cache window for a real
// answer.
async function bandwidth(): Promise<VmixBandwidth> {
    const bw = await getVmixBandwidth();
    if (!bw.warming) return bw;
    await sleep(2100);
    return getVmixBandwidth();
}

// GET a local JSON endpoint, or null when it does not answer.
async function getJson(url: string): Promise<any> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

function localIpv4() {
    return Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
        (addrs ?? [])
            .filter((a) => a.family === 'IPv4' && !a.internal)
            .map((a) => ({ interface: name, address: a.address }))
    );
}

export default function startStatusApi(sources: StatusApiSources) {
    const routes: Record<string, () => Promise<unknown> | unknown> = {
        // Checks (menu bar): every check's state, detail, fix, docs link.
        checks: () => Checks.Instance.list(),
        // What the checks read: vMix stream/recorder settings, Windows audio,
        // X-Air routing, Live Captions YouTube push. No stream keys.
        sources: () => Checks.Instance.sources(),
        network: () => ({
            ...HWPing.Instance.currentStatus,
            interfaces: localIpv4(),
        }),
        vmix: async () => {
            const { reachable, recording, streaming } =
                await sources.vmixStatus();
            return { reachable, recording, streaming };
        },
        stream: async () => {
            const [status, bw] = await Promise.all([
                sources.vmixStatus(),
                bandwidth(),
            ]);
            return {
                streaming: status.streaming,
                currentEvent: status.currentEvent,
                keysSetForEvent: status.keysSetForEvent,
                streamKeys: status.streamKeys,
                // Only the verdict: the key lists are live stream keys.
                keyValidation: (() => {
                    const kv = status.keyValidation as
                        | { checked: boolean; match: boolean | null }
                        | undefined;
                    return kv ? { checked: kv.checked, match: kv.match } : null;
                })(),
                bandwidthSupported: bw.supported,
                // Stream keys stay off the LAN: drop the rtmp URL.
                streams: bw.streams.map(({ rtmpUrl: _rtmpUrl, ...s }) => s),
            };
        },
        autoav: () => {
            const status = AutoAV.Instance.getStatus();
            return {
                ...status,
                matches: listMatches(status.saveFolder).slice(0, 20),
            };
        },
        captions: () => ({
            running: LiveCaptions.Instance.isRunning(),
            phase: LiveCaptions.Instance.getPhase(),
            version: LiveCaptions.Instance.getVersion(),
        }),
        // FTC Live scorekeeper connection and the FTC recorder.
        ftc: () => ({
            ...FtcScorekeeper.Instance.getStatus(),
            recorder: AutoAV.Instance.ftcRecorderSummary(),
        }),
        // YouTube uploader: state and queue counts only. Its settings hold
        // the TBA secret and TOA key, so nothing else is passed through.
        upload: async () => {
            const running = YoutubeUploaderAddon.Instance.isRunning();
            const base = `http://127.0.0.1:${YoutubeUploaderAddon.PORT}`;
            // The key the uploader is on: any other key starts a second
            // upload manager on the same folder.
            const eventKey = YoutubeUploaderAddon.Instance.eventKey();
            const [health, state] = running
                ? await Promise.all([
                      getJson(`${base}/api/health`),
                      eventKey
                          ? getJson(
                                `${base}/api/upload/state?event_key=${encodeURIComponent(
                                    eventKey
                                )}`
                            )
                          : null,
                  ])
                : [null, null];
            const queue: Record<string, number> = {};
            Object.values<{ status?: string }>(state?.videos ?? {}).forEach(
                (v) => {
                    const k = v?.status ?? 'unknown';
                    queue[k] = (queue[k] ?? 0) + 1;
                }
            );
            return {
                running,
                phase: YoutubeUploaderAddon.Instance.getPhase(),
                version: YoutubeUploaderAddon.Instance.getVersion(),
                program: health?.program ?? null,
                signedIn: health ? !!health.signed_in : null,
                channel: health?.channel_name ?? null,
                watching: health?.watching ?? null,
                queue: state ? queue : null,
            };
        },
        // Custom audience display (FRC off-season).
        display: () => ({
            running: AudienceDisplayAddon.Instance.isRunning(),
            phase: AudienceDisplayAddon.Instance.getPhase(),
            version: AudienceDisplayAddon.Instance.getVersion(),
            selected: AutoAV.Instance.runsCustomAd(),
        }),
        // Companion and which field system presses its buttons.
        companion: async () => {
            let reachable = false;
            try {
                const res = await fetch(`${companionUrl()}/`, {
                    signal: AbortSignal.timeout(2000),
                });
                reachable = res.status < 500;
            } catch {
                reachable = false;
            }
            let triggerSource: 'fms' | 'customAd' | 'ftc' = 'fms';
            if (AutoAV.Instance.isFtc()) triggerSource = 'ftc';
            else if (AutoAV.Instance.runsCustomAd()) triggerSource = 'customAd';
            let automations: boolean | null = null;
            try {
                if (triggerSource === 'ftc') {
                    automations = getStore().get('ftc.automations', true);
                } else if (triggerSource === 'customAd') {
                    automations = (await readCustomAd(CUSTOM_AD_URL)).config
                        .enabled;
                } else {
                    automations = (await readFmsAutomation())
                        .BitfocusIntegrationEnabled;
                }
            } catch {
                automations = null;
            }
            return {
                reachable,
                url: companionUrl(),
                triggerSource,
                automations,
            };
        },
    };

    const all = async () => {
        const entries = await Promise.all(
            Object.entries(routes).map(async ([k, fn]) => [k, await fn()])
        );
        return Object.fromEntries(entries);
    };

    const server = http.createServer(async (req, res) => {
        const send = (code: number, body: unknown) => {
            res.writeHead(code, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
        };

        if (req.method !== 'GET') {
            send(405, { error: 'method not allowed' });
            return;
        }

        const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
        const m = /^\/api\/status(?:\/([a-z]+))?$/.exec(path);
        if (!m) {
            send(404, {
                error: 'not found',
                endpoints: [
                    '/api/status',
                    ...Object.keys(routes).map((k) => `/api/status/${k}`),
                ],
            });
            return;
        }

        let handler: (() => unknown) | null = all;
        if (m[1]) {
            handler = Object.prototype.hasOwnProperty.call(routes, m[1])
                ? routes[m[1]]
                : null;
        }
        if (!handler) {
            send(404, { error: `unknown status "${m[1]}"` });
            return;
        }

        try {
            send(200, await handler());
        } catch (e) {
            log.error(`Status API ${path} failed`, e);
            send(500, { error: (e as Error).message });
        }
    });

    server.on('error', (e) => log.error('Status API server error', e));
    server.listen(STATUS_API_PORT, '0.0.0.0', () =>
        log.info(`Status API listening on :${STATUS_API_PORT}`)
    );
    return server;
}
