import os from 'os';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import log from 'electron-log';
import { getStore } from '../store';
import { companionUrl } from '../bitfocus';
import {
    FTC_UPDATE_TYPES,
    FtcScorekeeperStatus,
    FtcTriggerMap,
    FtcUpdate,
    FtcUpdateType,
} from '../../models/Ftc';

// Client for FTC Live, the FTC scoring system, running on the scorekeeping PC.
//
// FTC Live serves a read-only public API (spec at GET /openapi/). FIM-AV uses
// its push stream, websocket /api/v2/stream/?code=<event>, which sends
// {updateTime, updateType, payload:{number, shortName, field}} for MATCH_LOAD,
// MATCH_START, MATCH_ABORT, MATCH_COMMIT, MATCH_POST, SHOW_PREVIEW,
// SHOW_MATCH. REST is only used to find the event (once per
// connect): once a match is loaded FTC Live allows 30 requests per 5 minutes
// per event, shared by every app, so nothing here polls.
//
// The scorekeeper has no fixed address at FTC events, so it is a setting,
// with a scan of this machine's subnets to fill it in.
//
// Each update is also a Bitfocus trigger: the Companion button mapped to
// "<type>:<field>" is pressed, the same job the FMS audience display does for
// FRC (FTC's official display cannot press Companion buttons).
//
// Started and stopped with the other add-ons (see index.ts). It runs no
// process of its own, so it has none of the download, kill sweep or phase
// plumbing: getStatus() and the 'status' event say whether it is connected.

// Ports FTC Live uses: 80 by default, 28080 when 80 is taken (Linux
// launcher), 8080 on a Windows install next to FMS (which holds 80).
const PORTS = [80, 8080, 28080];

const logger = log.scope('ftc');

export default class FtcScorekeeper extends EventEmitter {
    private static instance: FtcScorekeeper;

    private ws: WebSocket | null = null;

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private stopped = true;

    private status: FtcScorekeeperStatus = {
        address: '',
        connected: false,
        eventCode: null,
        eventName: null,
        eventType: null,
        fieldCount: 1,
        lastUpdate: null,
        error: null,
        found: [],
    };

    private scanning: Promise<string[]> | null = null;

    private autoScanTimer: ReturnType<typeof setInterval> | null = null;

    public getStatus(): FtcScorekeeperStatus {
        return { ...this.status };
    }

    private setStatus(patch: Partial<FtcScorekeeperStatus>) {
        this.status = { ...this.status, ...patch };
        this.emit('status', this.getStatus());
    }

    // (Re)connect using the stored address. Safe to call any time; a blank
    // address leaves it stopped.
    public start() {
        this.stop();
        const address = getStore().get('ftc.address', '').trim();
        this.status = { ...this.status, address };
        if (!address) {
            this.setStatus({ connected: false, error: null });
            return;
        }
        this.stopped = false;
        this.connect(address);
    }

    public stop() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = null;
        }
        if (this.status.connected) this.setStatus({ connected: false });
    }

    private scheduleReconnect(address: string) {
        if (this.stopped) return;
        this.reconnectTimer = setTimeout(() => this.connect(address), 5000);
    }

    private async connect(address: string) {
        try {
            const base = `http://${address}`;
            const res = await fetch(`${base}/api/v1/events/`, {
                signal: AbortSignal.timeout(4000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const { eventCodes } = (await res.json()) as {
                eventCodes?: string[];
            };
            const wanted = getStore().get('ftc.eventCode', '').trim();
            const code =
                wanted && eventCodes?.includes(wanted)
                    ? wanted
                    : eventCodes?.[0];
            if (!code) throw new Error('No event on the scorekeeper');

            // Event details are a nicety: FTC Live answers 500 here until the
            // event has teams and a schedule, so a failure is not fatal.
            let ev: { name?: string; type?: string; fieldCount?: number } = {};
            try {
                const r = await fetch(`${base}/api/v1/events/${code}/`, {
                    signal: AbortSignal.timeout(4000),
                });
                if (r.ok) ev = await r.json();
            } catch {
                // keep the defaults
            }
            if (this.stopped) return;
            this.setStatus({
                eventCode: code,
                eventName: ev.name ?? code,
                eventType: ev.type ?? null,
                fieldCount: Math.max(1, ev.fieldCount ?? 1),
                error: null,
            });

            const ws = new WebSocket(
                `ws://${address}/api/v2/stream/?code=${encodeURIComponent(
                    code
                )}`
            );
            this.ws = ws;
            ws.on('open', () => {
                logger.info(`Connected to FTC Live ${address} event ${code}`);
                this.setStatus({ connected: true, error: null });
            });
            ws.on('message', (data) => this.onMessage(String(data)));
            ws.on('close', () => {
                if (this.ws !== ws) return;
                this.ws = null;
                this.setStatus({ connected: false });
                this.scheduleReconnect(address);
            });
            ws.on('error', (e) => {
                logger.warn('FTC Live stream error', e.message);
                this.setStatus({ error: e.message });
            });
        } catch (e: any) {
            if (this.stopped) return;
            this.setStatus({
                connected: false,
                error: e?.message ?? String(e),
            });
            this.scheduleReconnect(address);
        }
    }

    private onMessage(raw: string) {
        let msg: any;
        try {
            msg = JSON.parse(raw);
        } catch {
            return; // FTC Live also sends plain keep-alive text
        }
        const type = msg?.updateType as FtcUpdateType | undefined;
        if (!type || !FTC_UPDATE_TYPES.includes(type)) return;
        const update: FtcUpdate = {
            type,
            time: Number(msg.updateTime) || Date.now(),
            number: Number(msg.payload?.number) || 0,
            shortName: String(msg.payload?.shortName ?? ''),
            field: Number(msg.payload?.field) || 1,
            // Only MATCH_POST's payload (ApiV2UpdateMatchResultsPayload) has
            // these; everything else leaves them undefined.
            redScore:
                msg.payload?.redScore !== undefined
                    ? Number(msg.payload.redScore)
                    : undefined,
            blueScore:
                msg.payload?.blueScore !== undefined
                    ? Number(msg.payload.blueScore)
                    : undefined,
        };
        this.setStatus({ lastUpdate: update });
        this.emit('update', update);
        this.pressTrigger(update);
    }

    // Press the Companion button mapped to this update, if FTC automations are
    // on. Fire and forget: a missing Companion never affects the stream.
    // eslint-disable-next-line class-methods-use-this
    private pressTrigger(update: FtcUpdate) {
        if (!getStore().get('ftc.automations', true)) return;
        const triggers = getStore().get('ftc.triggers', {}) as FtcTriggerMap;
        const loc = triggers[`${update.type}:${update.field}`];
        if (!loc) return;
        fetch(
            `${companionUrl()}/api/location/${loc.page}/${loc.row}/${
                loc.column
            }/press`,
            { method: 'POST', signal: AbortSignal.timeout(3000) }
        ).catch((e) =>
            logger.warn(`Companion press for ${update.type} failed`, e.message)
        );
    }

    // Look for a scorekeeper on its own: 10 s after startup (FMS gets a
    // moment to answer first), then every 30 s, while `wanted` says
    // nothing is connected. Each try covers one port, in turn 80, 8080,
    // 28080, then 80 again, so a try is ~254 probes per subnet. One
    // scorekeeper found is saved and connected; several are left for
    // Settings to offer.
    public startAutoScan(wanted: () => boolean) {
        if (this.autoScanTimer) return;
        let next = 0;
        const tick = async () => {
            if (!wanted()) return;
            const port = PORTS[next % PORTS.length];
            next += 1;
            const found = await this.scan([port]);
            const current = getStore().get('ftc.address', '').trim();
            if (found.length === 1 && found[0] !== current && wanted()) {
                logger.info(`Found FTC Live at ${found[0]}`);
                getStore().set('ftc.address', found[0]);
                this.start();
            } else if (found.length > 1) {
                logger.info(`Found several FTC Live: ${found.join(', ')}`);
            }
        };
        setTimeout(
            () => tick().catch((e) => logger.warn('Scan failed', e)),
            10000
        );
        this.autoScanTimer = setInterval(
            () => tick().catch((e) => logger.warn('Scan failed', e)),
            30 * 1000
        );
    }

    // One scan at a time: a Scan click during an automatic scan shares it.
    // With no port given (the Scan button) the ports are tried in order and
    // the scan stops at the first port that finds something.
    public scan(ports?: number[]): Promise<string[]> {
        if (!this.scanning) {
            this.scanning = (async () => {
                // eslint-disable-next-line no-restricted-syntax
                for (const port of ports ?? PORTS) {
                    // eslint-disable-next-line no-await-in-loop
                    const found = await this.scanSubnets(port);
                    if (found.length) return found;
                }
                return [];
            })()
                .then((found) => {
                    this.setStatus({ found });
                    return found;
                })
                .finally(() => {
                    this.scanning = null;
                });
        }
        return this.scanning;
    }

    // Find FTC Live on this machine's subnets on one port: every /24 of a
    // non-internal private IPv4 interface.
    // eslint-disable-next-line class-methods-use-this
    private async scanSubnets(port: number): Promise<string[]> {
        const prefixes = new Set<string>(['127.0.0']);
        Object.values(os.networkInterfaces()).forEach((list) =>
            (list ?? []).forEach((i) => {
                // Private LAN ranges only: not Tailscale (100.64/10), not
                // link-local, nothing public.
                if (
                    i.family === 'IPv4' &&
                    !i.internal &&
                    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
                        i.address
                    )
                ) {
                    prefixes.add(i.address.split('.').slice(0, 3).join('.'));
                }
            })
        );
        const targets: string[] = [];
        prefixes.forEach((p) => {
            const hosts =
                p === '127.0.0'
                    ? [1]
                    : [...Array(254).keys()].map((n) => n + 1);
            hosts.forEach((h) =>
                targets.push(port === 80 ? `${p}.${h}` : `${p}.${h}:${port}`)
            );
        });

        const found: string[] = [];
        let next = 0;
        const worker = async () => {
            while (next < targets.length) {
                const target = targets[next];
                next += 1;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const res = await fetch(
                        `http://${target}/api/v1/version/`,
                        {
                            signal: AbortSignal.timeout(500),
                        }
                    );
                    // eslint-disable-next-line no-await-in-loop
                    const body = res.ok ? await res.json() : null;
                    if (body?.version) found.push(target);
                } catch {
                    // nothing there
                }
            }
        };
        await Promise.all([...Array(128)].map(() => worker()));
        return found;
    }

    public static get Instance(): FtcScorekeeper {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
