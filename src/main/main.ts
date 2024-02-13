import path from 'path';
import { app, BrowserWindow, shell, ipcMain, globalShortcut } from 'electron';
import log from 'electron-log';
import MenuBuilder from './window_components/menu'; // eslint-disable-line import/no-cycle
import {
    RESOURCES_PATH,
    getAssetPath,
    logsPath,
    resolveHtmlPath,
    isDebug as isDebugFn
} from './util';
import registerAllEvents from './register-events';
import { getStore } from './store';
import setupSignalR from './window_components/signalR';
import buildTray from './window_components/tray';
import { startAutoUpdate } from './updates/update';
import createAlertsWindow from './window_components/alertsWindow';
import Addons from './addons';

log.transports.file.resolvePath = (variables, message) => {
    const scope =
        typeof message?.scope === 'string'
            ? message.scope
            : message?.scope?.label;
    let fileName = scope ?? variables.fileName ?? 'main';
    if (!fileName.endsWith('.log')) fileName += '.log';
    return path.join(logsPath, fileName);
};

class AppUpdater {
    constructor() {
        log.transports.file.level = 'info';
    }
}

let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;
const isDebug = isDebugFn();

// Addons
const addons = new Addons().init();

if (process.env.NODE_ENV === 'production') {
    const sourceMapSupport = require('source-map-support');
    sourceMapSupport.install();
    // setup auto update
    startAutoUpdate();
}

if (isDebug) {
    require('electron-debug')({ showDevTools: false });
}

const installExtensions = async () => {
    const installer = require('electron-devtools-installer');
    const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
    const extensions: string[] = [];

    return installer
        .default(
            extensions.map((name) => installer[name]),
            forceDownload
        )
        .catch(log.error);
};

/** Create the main window */
const createWindow = async () => {
    if (isDebug) {
        await installExtensions();
    }

    mainWindow = new BrowserWindow({
        show: false,
        width: 1024,
        height: 728,
        icon: getAssetPath('icon.png'),
        webPreferences: {
            preload: app.isPackaged
                ? path.join(__dirname, 'preload.js')
                : path.join(__dirname, '../../.erb/dll/preload.js'),
        },
    });

    mainWindow.loadURL(resolveHtmlPath('index.html'));

    mainWindow.on('ready-to-show', () => {
        if (!mainWindow) {
            throw new Error('"mainWindow" is not defined');
        }
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.on('minimize', (event: any) => {
        event.preventDefault();
        mainWindow?.hide();
    });

    mainWindow.on('close', (event) => {
        if (!appIsQuitting) {
            event.preventDefault();
            mainWindow?.hide();
            return false;
        }
        mainWindow?.destroy();

        return true;
    });

    const menuBuilder = new MenuBuilder(mainWindow, addons);
    menuBuilder.buildMenu();

    // Open urls in the user's browser
    mainWindow.webContents.setWindowOpenHandler((edata) => {
        shell.openExternal(edata.url);
        return { action: 'deny' };
    });

    // Remove this if your app does not use auto updates
    // eslint-disable-next-line
    new AppUpdater();
};

// eslint-disable-next-line import/prefer-default-export
export const quitApp = () => {
    appIsQuitting = true;
    addons.stop();
    app.quit();
}

/**
 * Add event listeners...
 */
app.on('window-all-closed', () => {
    // app.quit();
});

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) {
    // This is a second instance, we only want one at a time
    if (isDebug)
        log.error(
            'Tried to open another instance while the old one was still open. New changes will not be reflected.'
        );
    app.quit();
} else {
    app.on('second-instance', () => {
        if (isDebug)
            log.error(
                'Tried to open another instance while the old one was still open. New changes will not be reflected.'
            );
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        } else {
            createWindow();
        }
    });

    app.whenReady()
        .then(async () => {
            const store = getStore();

            // TODO: Currently the API key is set manually by opening the config.json file
            if (store.get('apiKey')) {
                try {
                    await setupSignalR(store, createAlertsWindow);
                } catch { } // eslint-disable-line no-empty
            }

            // Create the main window
            await createWindow();

            // Register all the event handlers (Must be done AFTER setupSignalR is called and AFTER window is created)
            registerAllEvents(mainWindow);

            // Register Shortcuts
            if (isDebug) {
                // Ctrl + Q to quit
                globalShortcut.register('CommandOrControl+Q', () => {
                    quitApp();
                });
            }

            // Register Tray Icon
            buildTray(mainWindow, RESOURCES_PATH, app.getVersion());

            app.on('activate', () => {
                // On macOS it's common to re-create a window in the app when the
                // dock icon is clicked and there are no other windows open.
                if (mainWindow === null) createWindow();
            });

            return undefined;
        })
        .catch(log.error);
}
