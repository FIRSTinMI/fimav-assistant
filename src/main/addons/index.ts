import { differenceInDays, parse } from 'date-fns';
import fs from 'fs';
import path from 'path';
import glob from 'glob';
import log from 'electron-log';
import AutoAV from './autoav';
import LiveCaptions from './live-captions';
import { logsPath } from '../util';
import HWPing from './hw-ping';

export default class Addons {
    private liveCaptions: LiveCaptions = LiveCaptions.Instance;

    private AutoAV: AutoAV = AutoAV.Instance;

    private HWPing: HWPing = HWPing.Instance;

    public init(): Addons {
        this.restartAll();
        return this;
    }

    // Kill all addons
    public stop() {
        this.liveCaptions.stop();
        this.AutoAV.stop();
        this.HWPing.stop();
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

    // Restart HWPing
    public restartHWPing() {
        this.HWPing.stop();
        this.HWPing.start();
    }

    // Restart all
    public restartAll() {
        log.info('📦 Addons Starting...');

        // Stop autoav
        this.AutoAV.stop();

        // Stop hwping
        this.HWPing.stop();

        // Manage logs
        Addons.manageLogs();

        // Setup live captions (live-captions handles killing the old thread)
        this.liveCaptions.start();

        // Start autoav
        this.AutoAV.start();

        // Start hwping
        this.HWPing.start();
    }

    // Manage the logs, removing old and moving old copies to a new folder
    private static manageLogs() {
        // Make a log folder if it doesn't exist
        if (!fs.existsSync(logsPath)) {
            fs.mkdirSync(logsPath);
        }

        // Get folders in the logs directory
        const folders = fs.readdirSync(logsPath);

        // Folder names are timestamps, filter unparsable timestamps
        const filteredFolders = folders.filter((f: string) => {
            return Addons.parseTimestamp(f) !== null;
        });

        // Sort the folders by date. Since they use epoch time, we can use the timestamp for sorting
        const sortedFolders = filteredFolders.sort((a, b) => {
            return parseInt(a, 10) - parseInt(b, 10);
        });

        // Delete any folders that are older than 7 days
        const now = new Date();
        sortedFolders.forEach((f: string) => {
            const date = Addons.parseTimestamp(f) as Date; // nulls already filtered out
            if (differenceInDays(date, now) > 7) {
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

    private static parseTimestamp(t: string): Date | null {
        if (Number.isNaN(parseInt(t, 10))) return null;
        try {
            return parse(t, 'T', new Date());
        } catch {
            return null;
        }
    }
}
