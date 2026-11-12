import { differenceInDays, parse } from 'date-fns';
import fs from 'fs';
import path from 'path';
import glob from 'glob';
import log from 'electron-log';
import AutoAV from './autoav';
import LiveCaptions from './live-captions';
import YoutubeUploaderAddon from './upload-helper';
import AudienceDisplayAddon from './audience-display';
import FtcScorekeeper from './ftc-scorekeeper';
import { logsPath } from '../util';
import { killRunningFfmpeg } from '../cutMatch';
import HWPing from './hw-ping';

export default class Addons {
    private liveCaptions: LiveCaptions = LiveCaptions.Instance;

    private AutoAV: AutoAV = AutoAV.Instance;

    private HWPing: HWPing = HWPing.Instance;

    private youtubeUploader: YoutubeUploaderAddon =
        YoutubeUploaderAddon.Instance;

    private audienceDisplay: AudienceDisplayAddon =
        AudienceDisplayAddon.Instance;

    private ftcScorekeeper: FtcScorekeeper = FtcScorekeeper.Instance;

    public init(): Addons {
        this.restartAll();
        return this;
    }

    // Kill all addons. Resolves once the child-process addons have stopped,
    // so a quit can wait for the uploader to close its browser and exit.
    public async stop(): Promise<void> {
        this.AutoAV.stop();
        // Only here, on quit: AutoAV.stop() also runs for an FMS reconnect,
        // where a running cut must carry on.
        killRunningFfmpeg();
        this.HWPing.stop();
        this.ftcScorekeeper.stop();
        await Promise.all([
            this.liveCaptions.stop(),
            this.youtubeUploader.stop(),
            this.audienceDisplay.stop(),
        ]);
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

        // Start the YouTube uploader (no-ops until an event folder is known;
        // the Upload tab's Start/Restart re-resolves it once recording begins)
        this.youtubeUploader.start();

        // Start the custom audience display (off-season only; start() refuses
        // in-season and the season change in register-events flips it)
        this.audienceDisplay.start();

        // Connect to the FTC Live scorekeeper if one is set
        this.ftcScorekeeper.start();
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
