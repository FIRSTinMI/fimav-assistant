import path from "path";
import fs from "fs";
import { finished } from 'stream/promises';
import { ChildProcessWithoutNullStreams, spawn, execSync } from 'child_process';
import glob from 'glob';
import { Readable } from "node:stream";
import { app } from "electron";
import { appdataPath } from "../util";

export default class LiveCaptions {

    private static _instance: LiveCaptions;
    private running = false;
    private process: ChildProcessWithoutNullStreams | null = null;
    private lastPath: string | null = null;

    // Kill any existing live-captions processes
    private killExisting() {
        try {
            // Find any exiting live-captions processes and kill them
            const out = execSync('wmic process get processid,name | find "live-captions"').toString() // outputs "<process name>                    <pid>"
            const lines = out.split('\n');
            if (lines.length > 1) {
                const split = lines[0].trim().split(' ')
                const pid = split[split.length - 1];
                console.log(`Found existing live-captions process (PID ${pid}), killing it`);
                execSync(`taskkill /pid ${pid} /f /t`);
            }
        } catch {
            // Ignore any errors
        }
    }

    /*
    * Starts the live-captions process
    */
    public start(): Promise<boolean> {
        this.killExisting();

        console.log('Starting live-captions')
        return new Promise<boolean>(async (resolve, reject) => {
            // Check if appdata folder exists and create it if it doesn't
            if (!fs.existsSync(appdataPath)) {
                // Create it if it doesn't
                fs.mkdirSync(appdataPath);
            }

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

            // If it doesn't exist, download it from Github
            const res = await fetch('https://github.com/Filip-Kin/live-captions/releases/latest')

            // Fetching "/latest" from github forwards to the latest release URL, which we can then extract the version from the response URL.
            const latestVersion = res.url.split('/').pop()?.slice(1) || '0.0.0';

            // If the latest version is greater than the current version, download the latest version
            if (latestVersion > currentVersion) {
                console.log(`Found new version of live-captions, currently at ${currentVersion}, downloading ${latestVersion}`);

                // Create write stream
                const stream = fs.createWriteStream(path.join(appdataPath, `live-captions-${latestVersion}.exe`));

                // Download the live-captions executable
                const { body } = await fetch(`https://github.com/Filip-Kin/live-captions/releases/download/v${latestVersion}/live-captions-${latestVersion}.exe`);

                // Check if the download was successful
                if (body === null) throw new Error('Failed to download live-captions');

                // @ts-ignore
                await finished(Readable.fromWeb(body).pipe(stream));

                // Update current version
                currentVersion = latestVersion;
            }

            // Start the live-captions process
            return this.startLiveCaptions(path.join(appdataPath, `live-captions-${currentVersion}.exe`));
        });
    }

    // Stop the live-captions process
    public stop(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            if (!this.running || !this.process || this.process.killed) {
                resolve(true);
                return;
            }

            // Kill the live-captions process
            this.process.kill();

            // Set running to false
            this.running = false;

            // Resolve the promise
            resolve(true);
        });
    }

    // Restart the live-captions process
    public restart(): Promise<boolean> {
        return new Promise<boolean>(async (resolve, reject) => {
            if (this.running || (this.process && !this.process.killed)) {
                await this.stop();
            }

            if (this.lastPath) {
                await this.startLiveCaptions(this.lastPath);
            }

            resolve(true);
        });
    }

    // Run the live-captions process from a path
    private startLiveCaptions(exePath: string): Promise<boolean> {
        // Whether or not to launch a shell with the live-captions process
        const runInShell = !app.isPackaged;

        // Store the last launched exe path
        this.lastPath = exePath;

        return new Promise<boolean>((resolve, reject) => {
            if (this.running || (this.process && !this.process.killed)) {
                resolve(true);
                return;
            }

            // Start the live-captions process
            this.process = spawn(exePath, [], {
                shell: runInShell
            });

            // Log the stdout and stderr to files
            this.process.stdout.pipe(fs.createWriteStream(path.join(appdataPath, 'logs', 'live-captions.out.log')));
            this.process.stderr.pipe(fs.createWriteStream(path.join(appdataPath, 'logs', 'live-captions.err.log')));

            this.process.on('exit', (err) => {
                console.log('Live Captions process exited');
                this.running = false;
            });
        });
    }

    public static get Instance(): LiveCaptions {
        return this._instance || (this._instance = new this());
    }
}