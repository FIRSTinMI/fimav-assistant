import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { getAssetPath, resolveHtmlPath } from '../util';

let alertsWindow: BrowserWindow | null = null;

/** Create the window which shows pending alerts. Note: this window is a singleton */
export default async function createAlertsWindow() {
    if (alertsWindow != null) return;
    const display = screen.getPrimaryDisplay();
    const { width } = display.bounds;
    const windowWidth = Math.round(width * 0.25);
    alertsWindow = new BrowserWindow({
        show: false,
        width: windowWidth,
        height: 400,
        // Top right of primary screen
        x: width - windowWidth,
        y: 0,
        minimizable: false,
        closable: true,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        title: 'Alerts',
        icon: getAssetPath('icon.png'),
        webPreferences: {
            preload: app.isPackaged
                ? path.join(__dirname, 'preload.js')
                : path.join(__dirname, '../../../.erb/dll/preload.js'),
        },
    });

    alertsWindow.loadURL(resolveHtmlPath('index.html', '/alerts/'));

    alertsWindow.on('ready-to-show', () => {
        if (!alertsWindow) {
            throw new Error('"alertsWindow" is not defined');
        }
        alertsWindow.show();
    });

    alertsWindow.on('closed', () => {
        alertsWindow = null;
    });
}

const getAlertsWindow = () => alertsWindow;

export { getAlertsWindow };
