import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import log from 'electron-log';
import { appdataPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import AddonPhaseTracker from './addon-phase';
import AddonEvents from './addon-events';
import { getStore } from '../store';
import SerialQueue from '../serial-queue';
import killByNameAndPort from './kill-process';
import {
    UpdateInfo,
    checkForUpdate,
    downloadRelease,
} from './release-download';

export default class LiveCaptions {
    private static instance: LiveCaptions;

    private running = false;

    // Updating / starting / running / stopped, with a 'phase' event. Lets
    // the checks tell "not up yet" from "down".
    public readonly phase = new AddonPhaseTracker();

    // Its /api/events stream while running (youtube push, engine, inputs).
    public readonly events = new AddonEvents(
        'live-captions',
        'http://127.0.0.1:3000/api/events',
        this.phase
    );

    // Version of the live-captions build currently launched, surfaced in the tab
    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    // start() and stop() run one at a time (see SerialQueue).
    private queue = new SerialQueue();

    constructor() {
        this.logs = {
            out: log.scope('live-captions.out'),
            err: log.scope('live-captions.err'),
        };
    }

    // The port live-captions serves its UI/API on.
    private static readonly PORT = 3000;

    // Kill EVERY live-captions process, tracked or orphaned, by BOTH image name
    // and by whatever is holding port 3000. The port sweep is the belt-and-
    // suspenders half: even if a process got renamed, wedged, or was spawned by
    // a previous app version, freeing the port guarantees the next start can
    // actually bind. This is why the blank screen kept coming back - a leftover
    // instance held 3000, the new one hit EADDRINUSE, and live-captions swallows
    // that exception and sits there serving nothing.
    private killExisting() {
        killByNameAndPort('live-captions', LiveCaptions.PORT, this.logs.out);
        this.running = false;
        this.process = null;
    }

    // Poll the live-captions HTTP server until it actually answers, so we only
    // report "running" once it's really serving (not just that the process
    // spawned). Returns false if it never comes up within the timeout.
    // eslint-disable-next-line class-methods-use-this
    private async waitForServer(timeoutMs = 12000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(
                    `http://127.0.0.1:${LiveCaptions.PORT}/`,
                    { signal: AbortSignal.timeout(1500) }
                );
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

    /*
     * Starts the live-captions process
     */
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

        this.phase.set('updating');

        // Update check + download is best-effort: if we're offline (e.g. at a
        // venue) or the download fails, fall back to the newest local exe
        // (live-captions-<version>.exe in userData) rather than throwing and
        // leaving live-captions down.
        const baseUrl = getStore().get('liveCaptionsDownloadBase');
        const update = await this.checkForUpdate();
        let currentVersion = update.current;
        if (update.updateAvailable) {
            this.logs.out.log(
                `Found new version of live-captions, currently at ${currentVersion}, downloading ${update.latest}`
            );
            try {
                await downloadRelease(baseUrl, 'live-captions', update.latest);
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
                'No live-captions executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

        this.phase.set('starting');
        this.logs.out.log(`Starting live-captions v${currentVersion}`);
        this.currentVersion = currentVersion;

        // Start the live-captions process
        return this.startLiveCaptions(
            path.join(appdataPath, `live-captions-${currentVersion}.exe`)
        );
    }

    // Stop live-captions. Kills EVERY instance (tracked or orphaned), not just
    // the one we spawned, so a lost background child can't keep holding port
    // 3000. This is what the Stop button and the pre-launch cleanup both need.
    // Exit handlers are identity-guarded, so the kill firing exit is harmless.
    public stop(): Promise<boolean> {
        return this.queue.run(async () => {
            this.killExisting();
            this.phase.set('stopped');
            return true;
        });
    }

    // Launch the exe and confirm it's actually serving before reporting running.
    // Retries once (with a fresh port sweep) if the server doesn't come up, so
    // the Restart button can recover from a wedged/orphaned prior instance.
    private async startLiveCaptions(exePath: string): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            // Always start from a clean slate: no tracked process, port free.
            this.killExisting();

            // Start the live-captions process directly (NO shell wrapper).
            // shell:true meant `this.process` was a cmd.exe wrapper, so kill()
            // took down the wrapper and orphaned the real exe on port 3000.
            const child = spawn(exePath, ['--skip-update-check'], {
                // Run by AV Assistant: its settings hide what AV Assistant does.
                env: { ...process.env, FIMAV_MANAGED: '1' },
            });
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            // Identity-guarded: an OLD child exiting must not clobber the state
            // of a NEWer one started on retry.
            child.on('exit', (code: number | null, signal: string | null) => {
                this.logs.out.log(
                    `Live-captions exited (code ${code ?? 'null'}, signal ${
                        signal ?? 'none'
                    })`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                    // Exited after it was up: down. During start, the
                    // retry loop decides.
                    if (this.phase.get() === 'running')
                        this.phase.set('stopped');
                }
            });
            child.on('error', (err) => {
                this.logs.err.error(
                    `Live-captions failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            // Only report running once the server actually answers on :3000.
            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                this.logs.out.log(
                    `Live-captions is serving on port ${LiveCaptions.PORT}`
                );
                return true;
            }

            this.logs.err.error(
                `Live-captions did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        // Both attempts failed; leave it stopped and honest so the tab shows a
        // Start button and the log carries the reason.
        this.killExisting();
        return false;
    }

    // Whether the live-captions process is currently running
    public isRunning(): boolean {
        return this.running;
    }

    // Updating or starting: not running yet, but on its way.
    public getPhase() {
        return this.phase.get();
    }

    // Version string of the launched live-captions build
    public getVersion(): string {
        return this.currentVersion;
    }

    // Check GitHub for a newer live-captions without downloading it.
    public checkForUpdate(): Promise<UpdateInfo> {
        return checkForUpdate(
            'live-captions',
            getStore().get('liveCaptionsDownloadBase'),
            this.logs.err
        );
    }

    public static get Instance(): LiveCaptions {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
