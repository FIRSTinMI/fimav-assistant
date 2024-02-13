import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

export function startAutoUpdate() {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // Handle update-downloaded event
    autoUpdater.on('update-downloaded', () => {
        // Yolo I guess 🤷‍♀️
        autoUpdater.quitAndInstall();
    });

    setInterval(() => {
        autoUpdater.checkForUpdates();
    }, 10 * 60 * 1000);
}

export function updateNow() {
    autoUpdater.checkForUpdates();
}
