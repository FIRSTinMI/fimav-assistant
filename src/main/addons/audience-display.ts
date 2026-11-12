import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import log from 'electron-log';
import { appdataPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import AddonPhaseTracker from './addon-phase';
import AddonEvents from './addon-events';
import { getStore } from '../store';
import AutoAV from './autoav';
import SerialQueue from '../serial-queue';
import killByNameAndPort from './kill-process';
import {
    UpdateInfo,
    checkForUpdate,
    downloadRelease,
} from './release-download';

// AudienceDisplayAddon spawns and supervises the custom audience display
// (Filip-Kin/audience-display), the off-season replacement for the FMS
// audience display. Same shape as LiveCaptions and YoutubeUploaderAddon: a
// lazy singleton, a tracked child with an identity-guarded exit handler, a
// killExisting sweep by image name and by port, and a readiness poll before
// reporting running.
//
// The exe is NOT bundled. start() downloads the versioned Windows exe
// (audience-display-<version>.exe) from the GitHub releases into the app's
// userData dir, keeps the newest one, and updates on launch. The exe's own
// auto-update is turned off (AUTO_UPDATE=0) so this addon stays the one thing
// that decides which version runs. It runs only at FRC off-season events with
// "Custom AD" picked in Settings; otherwise start() refuses.
export default class AudienceDisplayAddon {
    private static instance: AudienceDisplayAddon;

    private running = false;

    // Updating / starting / running / stopped, with a 'phase' event.
    public readonly phase = new AddonPhaseTracker();

    // Its /api/events stream while running (profile, FMS, Companion,
    // errors). It picks its profile from the FMS event code itself.
    public readonly events = new AddonEvents(
        'audience-display',
        'http://127.0.0.1:3001/api/events',
        this.phase
    );

    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    private queue = new SerialQueue();

    constructor() {
        this.logs = {
            out: log.scope('audience-display.out'),
            err: log.scope('audience-display.err'),
        };
    }

    // The port the display serves its UI, API and websocket on.
    public static readonly PORT = 3001;

    public static readonly URL = `http://127.0.0.1:${AudienceDisplayAddon.PORT}`;

    private killExisting() {
        killByNameAndPort(
            'audience-display',
            AudienceDisplayAddon.PORT,
            this.logs.out
        );
        this.running = false;
        this.process = null;
    }

    // Poll the display's HTTP server until it answers, so we only report
    // running once it is serving.
    // eslint-disable-next-line class-methods-use-this
    private async waitForServer(timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(`${AudienceDisplayAddon.URL}/`, {
                    signal: AbortSignal.timeout(1500),
                });
                if (res.ok || res.status < 500) return true;
            } catch {
                // not up yet
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
        }
        return false;
    }

    // start() and stop() run one at a time (see SerialQueue).
    public start(): Promise<boolean> {
        this.phase.set('starting');
        return this.queue.run(async () => {
            const ok = await this.doStart();
            this.phase.set(ok ? 'running' : 'stopped');
            return ok;
        });
    }

    private async doStart(): Promise<boolean> {
        this.killExisting();

        // The custom display runs at FRC off-season events when Settings
        // picks it over the official FMS display.
        if (!AutoAV.Instance.runsCustomAd()) {
            this.logs.out.log('Custom audience display not selected; off');
            this.running = false;
            return false;
        }

        // Update check + download is best-effort: offline at a venue we fall
        // back to the newest local exe rather than leaving the display down.
        this.phase.set('updating');
        const baseUrl = getStore().get('audienceDisplayDownloadBase');
        const update = await this.checkForUpdate();
        let currentVersion = update.current;
        if (update.updateAvailable) {
            this.logs.out.log(
                `New audience display available, currently ${currentVersion}, downloading ${update.latest}`
            );
            try {
                await downloadRelease(
                    baseUrl,
                    'audience-display',
                    update.latest
                );
                currentVersion = update.latest;
            } catch (e) {
                this.logs.err.warn(
                    `Update download failed, using local v${currentVersion}`,
                    e
                );
            }
        }

        if (currentVersion === '0.0.0') {
            this.logs.err.error(
                'No audience display executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

        this.phase.set('starting');
        this.currentVersion = currentVersion;
        return this.launch(
            path.join(appdataPath, `audience-display-${currentVersion}.exe`)
        );
    }

    // Launch the exe and confirm it is serving before reporting running.
    // Retries once (with a fresh port sweep) so Restart can recover a wedged
    // instance.
    private async launch(exePath: string): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            this.killExisting();

            // The exe unpacks its UI into ./.temp relative to its working
            // directory, so run it from the userData dir, where the exe lives.
            // Its own auto-update is off: this addon picks the version.
            const child = spawn(exePath, [], {
                cwd: appdataPath,
                // FIMAV_MANAGED: run by AV Assistant, so its root page hides the
                // vMix setup AV Assistant's vMix tab does.
                env: { ...process.env, AUTO_UPDATE: '0', FIMAV_MANAGED: '1' },
            });
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            child.on('exit', (code: number | null, signal: string | null) => {
                this.logs.out.log(
                    `Audience display exited (code ${code ?? 'null'}, signal ${
                        signal ?? 'none'
                    })`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                    // Exited after it was up: down. During start, the retry
                    // loop decides.
                    if (this.phase.get() === 'running')
                        this.phase.set('stopped');
                }
            });
            child.on('error', (err) => {
                this.logs.err.error(
                    `Audience display failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            this.logs.out.log(
                `Starting audience display v${this.currentVersion}`
            );

            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                this.logs.out.log(
                    `Audience display is serving on port ${AudienceDisplayAddon.PORT}`
                );
                return true;
            }

            this.logs.err.error(
                `Audience display did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        this.killExisting();
        return false;
    }

    public stop(): Promise<boolean> {
        return this.queue.run(async () => {
            this.killExisting();
            this.phase.set('stopped');
            return true;
        });
    }

    public getPhase() {
        return this.phase.get();
    }

    public isRunning(): boolean {
        return this.running;
    }

    public getVersion(): string {
        return this.currentVersion;
    }

    // Check GitHub for a newer audience display without downloading it.
    public checkForUpdate(): Promise<UpdateInfo> {
        return checkForUpdate(
            'audience-display',
            getStore().get('audienceDisplayDownloadBase'),
            this.logs.err
        );
    }

    public static get Instance(): AudienceDisplayAddon {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
