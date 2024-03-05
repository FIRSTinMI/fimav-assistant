import {
    Menu,
    shell,
    BrowserWindow,
    MenuItemConstructorOptions,
} from 'electron';
import Addons from 'main/addons';
import { platform } from 'os';
import { updateNow } from '../updates/update';
import { isDebug, logsPath } from '../util';
import createAlertsWindow, { getAlertsWindow } from './alertsWindow';
import { quitApp } from '../main'; // eslint-disable-line import/no-cycle
import VmixService from '../../services/VmixService';
import { XMLParser } from 'fast-xml-parser';

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
        const template = this.buildDefaultTemplate(isDebug());

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
                    ...(dev
                        ? ([
                              {
                                  label: 'Quit',
                                  role: 'quit',
                                  click() {
                                      quitApp();
                                  },
                              },
                          ] as MenuItemConstructorOptions[])
                        : []),
                ],
            });
        }

        templateDefault.push(
            ...([
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
                            },
                        },
                    ],
                },
                {
                    label: 'Addons',
                    submenu: [
                        {
                            label: 'Live Captions',
                            submenu: [
                                {
                                    label: 'Add input to vMix',
                                    click() {
                                        MenuBuilder.addLiveCapInput();
                                    },
                                },
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
                                        MenuBuilder.openLiveCapSettings(
                                            'about'
                                        );
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
                        {
                            label: 'Quit',
                            accelerator: 'CommandOrControl+Alt+Shift+X',
                            visible: false,
                            click() {
                                quitApp();
                            },
                        },
                    ],
                },
            ] as MenuItemConstructorOptions[])
        );

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

    static async addLiveCapInput() {
        const service = new VmixService({
            baseUrl: 'http://127.0.0.1:8000/api',
            username: 'user',
            password: 'pass',
        });

        try {
            // Add input to vMix
            await service.AddBrowserInput('http://127.0.0.1:3000/');

            // Get inputs
            const inputs = await service.GetInputs();

            // Inputs is XML, parse it
            const parsed = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: '',
            }).parse(inputs);

            // Find the input we just added
            for (let input of parsed.vmix.inputs.input) {
                console.log(input);
                if (
                    input.type === 'Browser' &&
                    input.title === 'Browser 127.0.0.1'
                ) {
                    // Rename it
                    await service.RenameInput(input.key, 'Live Captions');
                    break;
                }
            }
        } catch (err) {
            // Sadness
            console.error(err);
        }
    }
}
