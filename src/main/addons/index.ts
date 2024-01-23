import { AUTOAV_BACKGROUND_THREAD_PATH, appdataPath } from "../util";
import { Worker } from 'worker_threads';
import LiveCaptions from './live-captions'
import fs from "fs";
import path from "path";
import glob from "glob";

export default class Addons {

    private liveCaptions: LiveCaptions = LiveCaptions.Instance;
    private AutoAV: Worker | undefined;

    public init(): Addons {
        this.restartAll();
        return this;
    }

    // Restart live captions
    public restartLiveCaptions() {
        this.liveCaptions.restart();
    }

    // Restart AutoAV
    public restartAutoAV() {
        this.AutoAV?.terminate();
        this.AutoAV = new Worker(AUTOAV_BACKGROUND_THREAD_PATH);
        this.AutoAV.stdout.pipe(fs.createWriteStream(path.join(appdataPath, 'logs', 'autoav.out.log')));
        this.AutoAV.stderr.pipe(fs.createWriteStream(path.join(appdataPath, 'logs', 'autoav.err.log')));
    }

    // Restart all
    public restartAll() {
        console.log("📦 Addons Starting...");

        // Manage logs
        this.manageLogs();

        // Setup live captions
        this.liveCaptions.start();

        // Setup autoav background thread calbacks
        this.restartAutoAV();
    }


    // Manage the logs, removing old and moving old copies to a new folder
    private manageLogs() {
        // Make a log folder if it doesn't exist
        if (!fs.existsSync(path.join(appdataPath, 'logs'))) {
            fs.mkdirSync(path.join(appdataPath, 'logs'));
        }

        // Get folders in the logs directory
        const folders = fs.readdirSync(path.join(appdataPath, 'logs'));

        // Folder names are timestamps, filter unparsable timestamps
        const filteredFolders = folders.filter((f: any) => {
            f = parseInt(f); // attempt to parse folder name as int
            return !isNaN(Date.parse(f));
        });

        // Sort the folders by date
        const sortedFolders = filteredFolders.sort((a, b) => {
            return Date.parse(a) - Date.parse(b);
        });

        // Delete any folders that are older than 7 days
        const now = new Date();
        sortedFolders.forEach((f: any) => {
            f = parseInt(f);
            const date = new Date(Date.parse(f));
            const diff = now.getTime() - date.getTime();
            const days = diff / (1000 * 60 * 60 * 24);
            if (days > 7) {
                fs.rmdirSync(path.join(appdataPath, 'logs', f), { recursive: true });
            }
        });

        // Move the current logs to a timestamped folder
        const folderName = Date.now().toString()
        fs.mkdirSync(path.join(appdataPath, 'logs', folderName));

        // Find all *.log files in the logs directory
        const files = glob.sync(path.join(appdataPath, 'logs', '*.log'));

        // Move each file to the new folder
        files.forEach((f) => {
            fs.renameSync(f, path.join(appdataPath, 'logs', folderName, path.basename(f)));
        });
    }

    // Kill all addons
    public stop() {
        this.liveCaptions.stop();
        this.AutoAV?.terminate();
    }

}