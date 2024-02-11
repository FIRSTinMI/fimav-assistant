import path from "path";
import fs from "fs";
import { finished } from 'stream/promises';
import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import glob from 'glob';
import log from "electron-log";
import { Readable } from "node:stream";
import { appdataPath } from "../util";
import { AddonLoggers } from ".";
import { getStore } from "../store";

export default class LiveCaptions {

    private static _instance: LiveCaptions;
    private running = false;
    private process: ChildProcessWithoutNullStreams | null = null;
    private logs: AddonLoggers;

    constructor() {
        this.logs = {
            out: log.scope("live-captions.out"),
            err: log.scope("live-captions.err")
        }
    }

    // Kill any existing live-captions processes
    private killExisting() {
        try {
            // Find any exiting live-captions processes and kill them
            const out = execSync('wmic process get processid,name | find "live-captions"').toString() // outputs "<process name>                    <pid>"
            const lines = out.split('\n');
            if (lines.length > 1) {
                const split = lines[0].trim().split(' ')
                const pid = split[split.length - 1];
                this.logs.out.log(`Found existing live-captions process (PID ${pid}), killing it`);
                execSync(`taskkill /pid ${pid} /f /t`);
            }
            this.running = false;
            this.process = null;
        } catch {
            // Ignore any errors
        }
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
            const version = file.split('-').pop()?.split('.exe')[0] ?? "0.0.0";
            if (version > currentVersion) {
                currentVersion = version;
            }
        });

        const baseUrl = getStore().get('liveCaptionsDownloadBase');

        // If it doesn't exist, download it from Github
        const res = await fetch(`${baseUrl}/latest`)

        // Fetching "/latest" from github forwards to the latest release URL, which we can then extract the version from the response URL.
        const latestVersion = res.url.split('/').pop()?.slice(1) || '0.0.0';

        // If the latest version is greater than the current version, download the latest version
        if (latestVersion > currentVersion) {
            this.logs.out.log(`Found new version of live-captions, currently at ${currentVersion}, downloading ${latestVersion}`);

            // Create write stream
            const stream = fs.createWriteStream(path.join(appdataPath, `live-captions-${latestVersion}.exe`));

            // Download the live-captions executable
            const { body } = await fetch(`${baseUrl}/download/v${latestVersion}/live-captions-${latestVersion}.exe`);

            // Check if the download was successful
            if (body === null) throw new Error('Failed to download live-captions');

            // @ts-ignore
            await finished(Readable.fromWeb(body).pipe(stream));

            // Update current version
            currentVersion = latestVersion;
        }

        this.logs.out.log(`Starting live-captions v${currentVersion}`)

        // Start the live-captions process
        return this.startLiveCaptions(path.join(appdataPath, `live-captions-${currentVersion}.exe`));

    }

    // Stop the live-captions process
    public stop(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            if (!this.running || !this.process || this.process.killed) {
                resolve(true);
                return;
            }

            // Remove the exit listener
            this.process.off('exit', this.onExit.bind(this));

            // Kill the live-captions process
            this.process.kill();

            // Set running to false
            this.running = false;

            // Resolve the promise
            resolve(true);
        });
    }

    // Run the live-captions process from a path
    private startLiveCaptions(exePath: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            if (this.running || (this.process && !this.process.killed)) {
                resolve(true);
                return;
            }

            // Start the live-captions process
            this.process = spawn(exePath, [], { shell: true });

            // Log the stdout and stderr to files
            this.process.stdout.on('data', (data) => {
                this.logs.out.info(data);
            });
            this.process.stdout.on('data', (data) => {
                this.logs.err.error(data);
            });

            this.process.on('exit', this.onExit.bind(this));
        });
    }

    private onExit(err: any) {
        this.logs.out.log('Live-captions exited with code', err.code);
        this.running = false;
    }

    public static get Instance(): LiveCaptions {
        return this._instance || (this._instance = new this());
    }
}