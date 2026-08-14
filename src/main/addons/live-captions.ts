import path from 'path';
import fs from 'fs';
import { finished } from 'stream/promises';
import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import glob from 'glob';
import log from 'electron-log';
import { Readable } from 'node:stream';
import { appdataPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import { getStore } from '../store';

export default class LiveCaptions {
    private static instance: LiveCaptions;

    private running = false;

    // Version of the live-captions build currently launched, surfaced in the tab
    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

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
        // 1) Kill by image name. The taskkill /FI "IMAGENAME eq name*.exe"
        // wildcard filter is rejected on some Win11 builds ("search filter
        // cannot be recognized"), so enumerate with tasklist and kill by PID.
        try {
            const tl = execSync('tasklist /fo csv /nh').toString();
            tl.split(/\r?\n/).forEach((line) => {
                const m = /^"(live-captions[^"]*\.exe)","(\d+)"/i.exec(
                    line.trim()
                );
                if (m) {
                    try {
                        execSync(`taskkill /F /T /PID ${m[2]}`, {
                            stdio: 'ignore',
                        });
                    } catch {
                        // already gone
                    }
                }
            });
        } catch {
            // tasklist unavailable (non-Windows dev box) - ignore.
        }

        // 2) Kill whatever is still LISTENING on the port, whatever it's called.
        try {
            const out = execSync('netstat -ano -p tcp').toString();
            const pids = new Set<string>();
            out.split(/\r?\n/).forEach((line) => {
                if (
                    line.includes(`:${LiveCaptions.PORT} `) ||
                    line.includes(`:${LiveCaptions.PORT}\t`)
                ) {
                    const cols = line.trim().split(/\s+/);
                    const pid = cols[cols.length - 1];
                    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
                }
            });
            pids.forEach((pid) => {
                try {
                    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
                    this.logs.out.log(
                        `Freed port ${LiveCaptions.PORT} (killed PID ${pid})`
                    );
                } catch {
                    // ignore
                }
            });
        } catch {
            // netstat unavailable (non-Windows dev box) - ignore.
        }

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
    public async start(): Promise<boolean> {
        this.killExisting();

        // Check if the live-captions.exe exists
        const liveCaptionsPath = path.join(appdataPath, 'live-captions-*.exe');
        const found = glob.sync(liveCaptionsPath);

        // Current version of live-captions
        let currentVersion = '0.0.0';
        found.forEach((file) => {
            const version = file.split('-').pop()?.split('.exe')[0] ?? '0.0.0';
            if (version > currentVersion) {
                currentVersion = version;
            }
        });

        // Update check + download is best-effort: if we're offline (e.g. at a
        // venue) or the download fails, fall back to the newest local exe rather
        // than throwing and leaving live-captions down.
        try {
            const baseUrl = getStore().get('liveCaptionsDownloadBase');
            const res = await fetch(`${baseUrl}/latest`, {
                signal: AbortSignal.timeout(8000),
            });
            // "/latest" forwards to the newest release URL; extract its version.
            const latestVersion = res.url.split('/').pop()?.slice(1) || '0.0.0';

            if (latestVersion > currentVersion) {
                this.logs.out.log(
                    `Found new version of live-captions, currently at ${currentVersion}, downloading ${latestVersion}`
                );
                const target = path.join(
                    appdataPath,
                    `live-captions-${latestVersion}.exe`
                );
                const stream = fs.createWriteStream(target);
                const { body } = await fetch(
                    `${baseUrl}/download/v${latestVersion}/live-captions-${latestVersion}.exe`
                );
                if (body === null)
                    throw new Error('Failed to download live-captions');
                // @ts-ignore
                await finished(Readable.fromWeb(body).pipe(stream));
                currentVersion = latestVersion;
            }
        } catch (e) {
            this.logs.err.warn(
                `Update check failed, using local v${currentVersion}`,
                e
            );
        }

        if (currentVersion === '0.0.0') {
            this.logs.err.error(
                'No live-captions executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

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
        return new Promise<boolean>((resolve) => {
            this.killExisting();
            resolve(true);
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
            const child = spawn(exePath, ['--skip-update-check']);
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            // Identity-guarded: an OLD child exiting must not clobber the state
            // of a NEWer one started on retry.
            child.on(
                'exit',
                (code: number | null, signal: string | null) => {
                    this.logs.out.log(
                        `Live-captions exited (code ${code ?? 'null'}, signal ${
                            signal ?? 'none'
                        })`
                    );
                    if (this.process === child) {
                        this.running = false;
                        this.process = null;
                    }
                }
            );
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
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''}`
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

    // Version string of the launched live-captions build
    public getVersion(): string {
        return this.currentVersion;
    }

    // Check GitHub for a newer live-captions without downloading it.
    public async checkForUpdate(): Promise<{
        current: string;
        latest: string;
        updateAvailable: boolean;
    }> {
        const found = glob.sync(path.join(appdataPath, 'live-captions-*.exe'));
        let current = '0.0.0';
        found.forEach((file) => {
            const v = file.split('-').pop()?.split('.exe')[0] ?? '0.0.0';
            if (v > current) current = v;
        });
        let latest = current;
        try {
            const baseUrl = getStore().get('liveCaptionsDownloadBase');
            const res = await fetch(`${baseUrl}/latest`, {
                signal: AbortSignal.timeout(8000),
            });
            latest = res.url.split('/').pop()?.slice(1) || current;
        } catch (e) {
            this.logs.err.warn('Update check failed', e);
        }
        return { current, latest, updateAvailable: latest > current };
    }

    public static get Instance(): LiveCaptions {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
