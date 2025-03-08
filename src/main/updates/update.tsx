import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import AutoAV from 'main/addons/autoav';

// eslint-disable-next-line no-undef
let canRestartInterval: NodeJS.Timer | undefined;
export function startAutoUpdate() {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // Handle update-downloaded event
    autoUpdater.on('update-downloaded', () => {
        if (!restartIfNotRecording() && !canRestartInterval) {
            canRestartInterval = setInterval(() => {
                if (restartIfNotRecording() && canRestartInterval) {
                    // Shouldn't matter because we're about to quit, but just in case
                    clearInterval(canRestartInterval);
                    canRestartInterval = undefined;
                }
            }, 60 * 1000);
        }
    });

    setInterval(() => {
        autoUpdater.checkForUpdates();
    }, 10 * 60 * 1000);
}

function restartIfNotRecording(): boolean {
    if (AutoAV.Instance.weAreRecording) return false;
    
    autoUpdater.quitAndInstall();
    return true;
}

export function updateNow() {
    autoUpdater.checkForUpdates();
}
