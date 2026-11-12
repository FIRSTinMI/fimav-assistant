import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import log from 'electron-log';
import { appdataPath } from '../util';
import { AddonLoggers } from './addon-loggers';
import AddonPhaseTracker from './addon-phase';
import AddonEvents from './addon-events';
import { getStore } from '../store';
import AutoAV from './autoav';
import FtcScorekeeper from './ftc-scorekeeper';
import SerialQueue from '../serial-queue';
import killByNameAndPort from './kill-process';
import { checkForUpdate, downloadRelease } from './release-download';

// YoutubeUploaderAddon spawns and supervises the youtube-tba-upload process, which
// uploads recorded match videos to YouTube and submits the URLs to The Blue
// Alliance. It shares the fimav-matches.json manifest with FIM-AV in the
// recording folder (see recordings/matchStore.ts). This mirrors LiveCaptions:
// a lazy singleton, a tracked child with an identity-guarded exit handler, a
// killExisting sweep by image name and by port, and a readiness poll before
// reporting running.
//
// The uploader is NOT bundled with the app. Exactly like LiveCaptions, start()
// downloads the versioned Windows .exe (youtube-tba-upload-<version>.exe) from
// the youtube-tba-upload GitHub releases into the app's userData dir, keeps the
// newest one, and auto-updates on launch. Offline (e.g. at a venue) it falls
// back to the newest local copy, and stays stopped only if none was ever
// downloaded.
export default class YoutubeUploaderAddon {
    private static instance: YoutubeUploaderAddon;

    private running = false;

    // Updating / starting / running / stopped, with a 'phase' event.
    public readonly phase = new AddonPhaseTracker();

    // Its /api/events stream while running (sign-in, queue, uploads, quota,
    // what it watches). Also emits 'key' when the applied event key moves,
    // and 'target' when the uploader starts or moves to a new folder or
    // program, i.e. whenever it needs this app's upload settings.
    public readonly events = new AddonEvents(
        'youtube-tba-upload',
        'http://127.0.0.1:8807/api/events',
        this.phase
    );

    private currentVersion = '0.0.0';

    private process: ChildProcessWithoutNullStreams | null = null;

    private logs: AddonLoggers;

    private queue = new SerialQueue();

    constructor() {
        this.logs = {
            out: log.scope('youtube-uploader.out'),
            err: log.scope('youtube-uploader.err'),
        };
    }

    // The port the uploader serves its HTTP API on (matches the Go -listen
    // default and the Upload tab's fetch base).
    public static readonly PORT = 8807;

    // FMS + TBA base URLs the uploader needs (Go defaults; passed explicitly so
    // the spawn is self-documenting). FMS is the same field controller AutoAV
    // talks to; TBA is the public trusted-submission endpoint.
    private static readonly FMS_URL = 'http://10.0.100.5';

    private static readonly TBA_URL = 'https://www.thebluealliance.com';

    // Kill every youtube-tba-upload process, tracked or orphaned, by BOTH image
    // name and whatever is LISTENING on port 8807 - the same belt-and-
    // suspenders sweep LiveCaptions uses, so a wedged prior instance can't keep
    // the port and block the next start.
    private killExisting() {
        killByNameAndPort(
            'youtube-tba-upload',
            YoutubeUploaderAddon.PORT,
            this.logs.out
        );
        this.running = false;
        this.process = null;
    }

    // Poll /api/health until the uploader actually answers, so we only report
    // running once it's serving. Also captures the reported version.
    private async waitForServer(timeoutMs = 15000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const res = await fetch(
                    `http://127.0.0.1:${YoutubeUploaderAddon.PORT}/api/health`,
                    { signal: AbortSignal.timeout(1500) }
                );
                if (res.ok) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        const body = await res.json();
                        if (body?.version) this.currentVersion = body.version;
                    } catch {
                        // health answered but no version - fine
                    }
                    return true;
                }
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

    // The recording folder the uploader watches = the event folder AutoAV is
    // currently filing videos into. A new event is a new folder, so the uploader
    // is restarted (restart()) when it changes.
    // eslint-disable-next-line class-methods-use-this
    private videoDir(): string | null {
        return AutoAV.Instance.getStatus().saveFolder;
    }

    // Start the uploader. Downloads/updates the versioned exe from GitHub
    // releases (best-effort, offline-tolerant) exactly like LiveCaptions, then
    // launches the newest local copy. Returns false (and stays stopped) when
    // there is no recording folder yet, or no exe was ever downloaded.
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

        // Match-video uploads: FRC off-season, when turned on in Settings.
        if (!AutoAV.Instance.runsUploader()) {
            this.logs.out.log('Match video upload not in use; uploader off');
            this.running = false;
            return false;
        }

        const videoDir = this.videoDir();
        if (!videoDir) {
            this.logs.out.log(
                'No recording folder yet; YouTube uploader will start once an event folder is known'
            );
            this.running = false;
            return false;
        }

        // Update check + download is best-effort: offline at a venue we fall
        // back to the newest local exe (youtube-tba-upload-<version>.exe in
        // userData) rather than leaving the uploader down.
        this.phase.set('updating');
        const baseUrl = getStore().get('youtubeUploaderDownloadBase');
        const update = await checkForUpdate(
            'youtube-tba-upload',
            baseUrl,
            this.logs.err
        );
        let currentVersion = update.current;
        if (update.updateAvailable) {
            this.logs.out.log(
                `New YouTube uploader available, currently ${currentVersion}, downloading ${update.latest}`
            );
            try {
                await downloadRelease(
                    baseUrl,
                    'youtube-tba-upload',
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
                'No YouTube uploader executable available (never downloaded and offline)'
            );
            this.running = false;
            return false;
        }

        this.phase.set('starting');
        this.currentVersion = currentVersion;
        return this.launch(
            path.join(appdataPath, `youtube-tba-upload-${currentVersion}.exe`),
            videoDir
        );
    }

    // Launch the exe and confirm it's serving before reporting running. Retries
    // once (with a fresh port sweep) so Restart can recover a wedged instance.
    private async launch(exePath: string, videoDir: string): Promise<boolean> {
        const args = [
            '-video-dir',
            videoDir,
            '-listen',
            `127.0.0.1:${YoutubeUploaderAddon.PORT}`,
            '-fms-url',
            YoutubeUploaderAddon.FMS_URL,
            '-tba-url',
            YoutubeUploaderAddon.TBA_URL,
        ];
        // FTC: scores come from the FTC Live scorekeeper and video links go
        // to The Orange Alliance instead of TBA.
        if (AutoAV.Instance.isFtc()) {
            const { address } = FtcScorekeeper.Instance.getStatus();
            args.push('-program', 'ftc');
            if (address) args.push('-ftc-url', `http://${address}`);
        }

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            this.killExisting();

            // Start directly (NO shell wrapper) so this.process is the real exe
            // and kill() takes it down rather than a cmd.exe shell.
            const child = spawn(exePath, args, {
                // Run by AV Assistant: its own page shows the folder and
                // event read-only.
                env: { ...process.env, FIMAV_MANAGED: '1' },
            });
            this.process = child;
            child.stdout.on('data', (d) => this.logs.out.info(d.toString()));
            child.stderr.on('data', (d) => this.logs.err.error(d.toString()));
            // Identity-guarded: an OLD child exiting must not clobber a NEWer
            // one started on retry.
            child.on('exit', (code: number | null, signal: string | null) => {
                this.logs.out.log(
                    `YouTube uploader exited (code ${code ?? 'null'}, signal ${
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
                    `YouTube uploader failed to start: ${err.message}`
                );
                if (this.process === child) {
                    this.running = false;
                    this.process = null;
                }
            });

            this.logs.out.log(
                `Starting YouTube uploader, watching ${videoDir}`
            );

            // eslint-disable-next-line no-await-in-loop
            const up = await this.waitForServer();
            if (up && this.process === child && !child.killed) {
                this.running = true;
                // A fresh uploader has no manager yet; the first request makes
                // one for this key, in this folder.
                this.appliedKey = '';
                this.setAppliedKey(AutoAV.Instance.uploadEventKey());
                this.appliedDir = videoDir;
                this.appliedProgram = AutoAV.Instance.isFtc() ? 'ftc' : 'frc';
                this.logs.out.log(
                    `YouTube uploader is serving on port ${YoutubeUploaderAddon.PORT} (v${this.currentVersion})`
                );
                // A fresh process holds only its built-in templates: the
                // host sends its own (see 'target').
                this.events.emit('target');
                return true;
            }

            this.logs.err.error(
                `YouTube uploader did not come up on attempt ${attempt}${
                    attempt < 2 ? ' - retrying after a clean port sweep' : ''
                }`
            );
        }

        this.killExisting();
        return false;
    }

    // Stop the uploader cleanly: ask it to shut down (closes the browser and
    // checkpoints the WAL), then fall back to the kill sweep on timeout. Exit
    // handlers are identity-guarded, so the fallback kill is harmless.
    public stop(): Promise<boolean> {
        this.cancelRetries();
        return this.queue.run(async () => {
            const ok = await this.doStop();
            this.phase.set('stopped');
            return ok;
        });
    }

    private async doStop(): Promise<boolean> {
        try {
            await fetch(
                `http://127.0.0.1:${YoutubeUploaderAddon.PORT}/api/shutdown`,
                {
                    method: 'POST',
                    signal: AbortSignal.timeout(5000),
                }
            );
            // Give it a moment to exit on its own before the sweep.
            await new Promise((resolve) => {
                setTimeout(resolve, 800);
            });
        } catch {
            // not reachable / already down - the sweep below handles it
        }
        this.killExisting();
        return true;
    }

    // POST to the uploader's live control routes. Throws on a refusal.
    private static async control(route: string, body: unknown) {
        const rsp = await fetch(
            `http://127.0.0.1:${YoutubeUploaderAddon.PORT}/api/control/${route}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(5000),
            }
        );
        const out = (await rsp.json().catch(() => null)) as {
            ok?: boolean;
            error?: string;
        } | null;
        if (!rsp.ok || !out?.ok)
            throw new Error(out?.error ?? `HTTP ${rsp.status}`);
    }

    // The event key the running uploader is on. Every request to the uploader
    // names it, and the uploader starts a separate scan-and-upload manager
    // for any key it has not seen, so all callers must send this one: the
    // key last accepted, not a newly typed one the uploader has not switched
    // to yet (two managers on one folder upload every match twice).
    private appliedKey = '';

    // The folder the running uploader was last pointed at, so a status change
    // that only changes the key can switch it without a restart.
    private appliedDir = '';

    private setAppliedKey(key: string) {
        if (!key || key === this.appliedKey) return;
        this.appliedKey = key;
        // The Upload tab sends this key on every request; tell it at once.
        this.events.emit('key', key);
    }

    public eventKey(): string {
        // Latched the first time a key exists while the uploader runs: from
        // then on only an accepted switch moves it.
        if (!this.appliedKey && this.running) {
            this.setAppliedKey(AutoAV.Instance.uploadEventKey());
        }
        return this.appliedKey || AutoAV.Instance.uploadEventKey();
    }

    // The program the running uploader was last pointed at.
    private appliedProgram = '';

    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Bumped by every new switch request and by stop(): a retry chain from an
    // older request (or from before a stop) ends instead of switching later
    // with stale settings.
    private retryGen = 0;

    private cancelRetries() {
        this.retryGen += 1;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    // Switch to the current key without restarting: while an upload is
    // running the uploader refuses the switch, so try again every 20 s until
    // it takes (a restart would kill that upload and leave a Studio draft),
    // then run onApplied. A newer request replaces an older pending one; a
    // stopped uploader ends the chain (a new start picks up the key itself).
    public retargetWhenIdle(onApplied: () => void) {
        this.cancelRetries();
        const gen = this.retryGen;
        const attempt = () => {
            this.retarget({ restartIfRefused: false })
                .then((ok) => {
                    if (gen !== this.retryGen) return ok;
                    if (ok) {
                        onApplied();
                    } else if (this.phase.get() === 'running') {
                        this.retryTimer = setTimeout(attempt, 20000);
                    }
                    return ok;
                })
                .catch((e) => this.logs.err.warn('Uploader switch failed', e));
        };
        attempt();
    }

    // For the status listener: a change of event key alone (same folder and
    // program, uploader running) waits out a running upload; a new folder or
    // program is a full retarget as before.
    public retargetForStatus(onKeyApplied: () => void): Promise<boolean> {
        const program = AutoAV.Instance.isFtc() ? 'ftc' : 'frc';
        if (
            this.phase.get() === 'running' &&
            this.appliedDir &&
            this.videoDir() === this.appliedDir &&
            program === this.appliedProgram
        ) {
            this.retargetWhenIdle(onKeyApplied);
            return Promise.resolve(true);
        }
        return this.retarget();
    }

    // Point a running uploader at the current event folder, event and
    // program without restarting it. One not running is started; a refused
    // switch (409: an upload in the old folder is still running) restarts,
    // unless restartIfRefused is false.
    public async retarget(
        opts: { restartIfRefused?: boolean } = {}
    ): Promise<boolean> {
        const restartIfRefused = opts.restartIfRefused ?? true;
        const videoDir = this.videoDir();
        if (this.phase.get() === 'running' && videoDir) {
            const ftc = AutoAV.Instance.isFtc();
            const { address } = FtcScorekeeper.Instance.getStatus();
            const key = AutoAV.Instance.uploadEventKey();
            try {
                await YoutubeUploaderAddon.control('event', {
                    videoDir,
                    eventKey: key || undefined,
                    program: ftc ? 'ftc' : 'frc',
                    ftcUrl: ftc && address ? `http://${address}` : undefined,
                });
                // A new folder or program is a new event config in the
                // uploader. A key-only switch is pushed by its caller, which
                // carries the playlist across.
                const moved =
                    videoDir !== this.appliedDir ||
                    (ftc ? 'ftc' : 'frc') !== this.appliedProgram;
                this.setAppliedKey(key);
                this.appliedDir = videoDir;
                this.appliedProgram = AutoAV.Instance.isFtc() ? 'ftc' : 'frc';
                this.logs.out.log(
                    `YouTube uploader now watching ${videoDir} (${this.eventKey()})`
                );
                if (moved) this.events.emit('target');
                return true;
            } catch (e) {
                if (!restartIfRefused) {
                    this.logs.out.log(
                        `Uploader busy, switch later: ${(e as Error).message}`
                    );
                    return false;
                }
                this.logs.err.warn('Live switch refused, restarting', e);
            }
        } else if (!restartIfRefused) {
            // Not running: nothing to switch. Never start it from here (a
            // saved key in-season would start an uploader nobody asked for).
            return false;
        }
        return this.start();
    }

    // A match video is final: tell the uploader now rather than waiting for
    // its folder scan. Best effort; the scan still picks it up.
    public videoReady(filePath: string) {
        if (this.phase.get() !== 'running') return;
        YoutubeUploaderAddon.control('video', { path: filePath }).catch((e) =>
            this.logs.out.log(`Video ready not taken: ${(e as Error).message}`)
        );
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

    public static get Instance(): YoutubeUploaderAddon {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
