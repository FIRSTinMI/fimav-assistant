import {
    Menu,
    shell,
    BrowserWindow,
    MenuItemConstructorOptions,
    app,
} from 'electron';
import Addons from 'main/addons';
import { updateNow } from '../updates/update';
import { isDebug, logsPath } from '../util';
import createAlertsWindow, { getAlertsWindow } from './alertsWindow';
import { platform } from 'os';
import { quitApp } from '../main';

interface DarwinMenuItemConstructorOptions extends MenuItemConstructorOptions {
    selector?: string;
    submenu?: DarwinMenuItemConstructorOptions[] | Menu;
}

export default class MenuBuilder {
    mainWindow: BrowserWindow;

    addons: Addons;

    constructor(mainWindow: BrowserWindow, addons: Addons) {
        this.mainWindow = mainWindow;
        this.addons = addons;
    }

    buildMenu(): Menu {
        const isDev =
            process.env.NODE_ENV === 'development' ||
            process.env.DEBUG_PROD === 'true';

        const template = this.buildDefaultTemplate(isDev);

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);

        return menu;
    }

    buildDefaultTemplate(dev: boolean) {
        const that = this;
        const templateDefault: MenuItemConstructorOptions[] = [];
        
        if (platform() === 'darwin') {
            templateDefault.push({
                label: 'FiM AV Assistant',
                role: 'appMenu',
                submenu: [
                    {
                        label: 'About FiM AV Assistant',
                        role: 'about',
                    },
                    ...(dev ? [{
                        label: 'Quit',
                        click() {
                            quitApp();
                        }
                    }] : [])
                ],
            });
        }

        templateDefault.push(...[
            {
                label: 'Alerts',
                submenu: [
                    {
                        label: 'View Alerts',
                        click() {
                            const alertsWindow = getAlertsWindow();
                            if (alertsWindow) {
                                alertsWindow.show();
                            } else {
                                createAlertsWindow();
                            }
                        }
                    }
                ]
            },
            {
                label: 'Addons',
                submenu: [
                    {
                        label: 'Live Captions',
                        submenu: [
                            {
                                label: 'Restart',
                                click() {
                                    that.addons.restartLiveCaptions();
                                },
                            },
                            {
                                label: 'Settings',
                                click() {
                                    MenuBuilder.openLiveCapSettings();
                                },
                            },
                            {
                                label: 'About',
                                click() {
                                    MenuBuilder.openLiveCapSettings('about');
                                },
                            },
                        ],
                    },
                    {
                        label: 'AutoAV',
                        submenu: [
                            {
                                label: 'Restart',
                                click() {
                                    that.addons.restartAutoAV();
                                },
                            },
                        ],
                    },
                    {
                        label: 'Restart All',
                        click() {
                            that.addons.restartAll();
                        },
                    },
                ],
            },
            {
                label: 'About',
                submenu: [
                    {
                        label: 'FIRST in Michigan',
                        click() {
                            shell.openExternal(
                                'https://www.firstinmichigan.org'
                            );
                        },
                    },
                    {
                        label: 'View Logs',
                        click() {
                            shell.openPath(logsPath);
                        },
                    },
                    {
                        label: 'Check for Updates (app may restart)',
                        click() {
                            updateNow();
                        },
                    },
                ],
            },
        ]);

        if (dev) {
            templateDefault.push({
                label: 'Debug',
                submenu: [
                    {
                        label: 'Reload',
                        accelerator: 'CommandOrControl+R',
                        click: () => {
                            BrowserWindow.getFocusedWindow()?.webContents.reload();
                        },
                    },
                    {
                        label: 'Toggle Developer Tools',
                        accelerator: 'Alt+CommandOrControl+I',
                        click: () => {
                            BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools();
                        },
                    },
                ],
            });
        }

        return templateDefault;
    }

    static openLiveCapSettings(submenu: string = '') {
        const window = new BrowserWindow({
            width: 1200,
            height: 800,
            alwaysOnTop: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            title: 'Live Captions',
            webPreferences: {
                // preload: `Array.from(document.getElementsByClassName("tabs")).forEach(c => c.remove())`
            },
        });
        window.loadURL(`http://localhost:3000/settings.html#${submenu}`);
        window.show();
    }
}
