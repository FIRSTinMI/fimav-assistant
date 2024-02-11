import fs from 'fs';
import path from 'path';
import glob from 'glob';
import log, { LogFunctions } from 'electron-log';
import AutoAV from './autoav';
import LiveCaptions from './live-captions';
import { logsPath } from '../util';

export default class Addons {
    private liveCaptions: LiveCaptions = LiveCaptions.Instance;

    private AutoAV: AutoAV = AutoAV.Instance;

    public init(): Addons {
        this.restartAll();
        return this;
    }

    // Kill all addons
    public stop() {
        this.liveCaptions.stop();
        this.AutoAV.stop();
    }

    // Restart live captions
    public async restartLiveCaptions() {
        // Stop live captions
        await this.liveCaptions.stop();

        // Start live captions
        await this.liveCaptions.start();
    }

    // Restart AutoAV
    public restartAutoAV() {
        // Kill the old thread
        this.AutoAV.stop();

        // Start a new thread
        this.AutoAV.start();
    }

    // Restart all
    public restartAll() {
        log.info('📦 Addons Starting...');

        // Stop autoav
        this.AutoAV.stop();

        // Manage logs
        this.manageLogs();

        // Setup live captions (live-captions handles killing the old thread)
        this.liveCaptions.start();

        // Start autoav
        this.AutoAV.start();
    }

    // Manage the logs, removing old and moving old copies to a new folder
    private manageLogs() {
        // Make a log folder if it doesn't exist
        if (!fs.existsSync(logsPath)) {
            fs.mkdirSync(logsPath);
        }

        // Get folders in the logs directory
        const folders = fs.readdirSync(logsPath);

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
                fs.rmdirSync(path.join(logsPath, f), { recursive: true });
            }
        });

        // Move the current logs to a timestamped folder
        const folderName = Date.now().toString();
        fs.mkdirSync(path.join(logsPath, folderName));

        // Find all *.log files in the logs directory
        const files = glob.sync(path.join(logsPath, '*.log'));

        // Move each file to the new folder
        files.forEach((f) => {
            fs.renameSync(f, path.join(logsPath, folderName, path.basename(f)));
        });
    }
}

export type AddonLoggers = {
    out: LogFunctions;
    err: LogFunctions;
};
