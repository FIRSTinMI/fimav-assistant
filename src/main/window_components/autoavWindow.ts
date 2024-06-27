import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { getAssetPath, resolveHtmlPath } from '../util';

let autoavWindow: BrowserWindow | null = null;

/** Create the window which shows pending alerts. Note: this window is a singleton */
export default async function createAutoAVWindow() {
    if (autoavWindow != null) return;
    // const display = screen.getPrimaryDisplay();
    // const { width } = display.bounds;
    // const windowWidth = Math.round(width * 0.25);
    autoavWindow = new BrowserWindow({
        show: false,
        // width: windowWidth,
        // height: 400,
        // // Top right of primary screen
        // x: width - windowWidth,
        // y: 0,
        // minimizable: true,
        // closable: true,
        // maximizable: false,
        // fullscreenable: false,
        // alwaysOnTop: true,
        title: 'AutoAV',
        icon: getAssetPath('icon.png'),
        webPreferences: {
            preload: app.isPackaged
                ? path.join(__dirname, 'preload.js')
                : path.join(__dirname, '../../../.erb/dll/preload.js'),
        },
    });

    autoavWindow.loadURL(resolveHtmlPath('index.html', '/autoav/'));

    autoavWindow.on('ready-to-show', () => {
        if (!autoavWindow) {
            throw new Error('"autoavWindow" is not defined');
        }
        autoavWindow.show();
    });

    autoavWindow.on('closed', () => {
        autoavWindow = null;
    });
}

const getAutoAVWindow = () => autoavWindow;

export { getAutoAVWindow };
