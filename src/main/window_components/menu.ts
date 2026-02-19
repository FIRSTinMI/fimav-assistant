/* eslint-disable import/order */
import {
    Menu,
    shell,
    BrowserWindow,
    MenuItemConstructorOptions,
    dialog,
    clipboard,
} from 'electron';
import Addons from 'main/addons';
import { platform } from 'os';
import { updateNow } from '../updates/update';
import { isDebug, logsPath } from '../util';
import createAlertsWindow, { getAlertsWindow } from './alertsWindow';
import { quitApp } from '../main'; // eslint-disable-line import/no-cycle
import VmixService from '../../services/VmixService';
import AutoAV from '../addons/autoav';
import { invoke } from './signalR';

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
                    label: 'vMix',
                    submenu: [
                        {
                            label: 'Set Stream Keys',
                            click: async () => {
                                // Set a timeout for the stream keys, if we don't get a response in 10 seconds, show a message box
                                const timeout = setTimeout(() => {
                                    dialog.showMessageBox({
                                        message:
                                            'Failed to set stream keys: Timed out',
                                        title: 'vMix Streaming',
                                        type: 'info',
                                    });
                                }, 10000);

                                VmixService.Instance.events.once(
                                    'streamInfoUpdated',
                                    (success: boolean) => {
                                        // Clear the timeout
                                        clearTimeout(timeout);

                                        // Show a message
                                        dialog.showMessageBox({
                                            message: success
                                                ? 'Successfully set vMix streaming locations'
                                                : 'Failed to set streaming locations. Check the log for more details.',
                                            title: 'vMix Streaming',
                                            type: 'info',
                                        });
                                    }
                                );

                                // This will trigger SignalR to send us the stream info, which is being listened for in register-events.ts
                                invoke('GetStreamInfo');
                            },
                        },
                        {
                            label: 'Add Live Captions input',
                            click() {
                                MenuBuilder.addLiveCapInput();
                            },
                        },
                        {
                            label: 'Add Audience Display (Web) input',
                            click() {
                                MenuBuilder.addAudienceDisplayWebInput();
                            },
                        },
                        ...(dev
                            ? ([
                                  {
                                      label: 'Start Recording (Dev)',
                                      click() {
                                          AutoAV.Instance.devStartRecording();
                                      },
                                  },
                                  {
                                      label: 'Stop Recording (Dev)',
                                      click() {
                                          AutoAV.Instance.devStopRecording();
                                      },
                                  },
                              ] as MenuItemConstructorOptions[])
                            : []),
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
            alwaysOnTop: false,
            resizable: false,
            minimizable: true,
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
        try {
            // Add input to vMix
            await VmixService.Instance.AddBrowserInput(
                'http://127.0.0.1:3000/'
            );

            // Get inputs
            const parsed = await VmixService.Instance.GetBase();

            // Find the input we just added
            let found = false;
            parsed.vmix.inputs.input.forEach(async (input: any) => {
                if (
                    !found &&
                    input.type === 'Browser' &&
                    input.title === 'Browser 127.0.0.1'
                ) {
                    // Rename it
                    await VmixService.Instance.RenameInput(
                        input.key,
                        'Live Captions'
                    );
                    found = true;
                }
            });
        } catch (err) {
            // Sadness
            dialog.showErrorBox('Failed', 'Unable to communicate with vMix');
        }
    }

    static async addAudienceDisplayWebInput() {
        try {
            // Add input to vMix
            await VmixService.Instance.AddBrowserInput(
                'http://10.0.100.5/AudienceDisplay'
            );

            // Get inputs
            const parsed = await VmixService.Instance.GetBase();

            // Find the input we just added
            let found = false;
            parsed.vmix.inputs.input.forEach(async (input: any) => {
                if (
                    !found &&
                    input.type === 'Browser' &&
                    input.title === 'Browser 10.0.100.5'
                ) {
                    // Rename it
                    await VmixService.Instance.RenameInput(
                        input.key,
                        'Audience Display'
                    );
                    await VmixService.Instance.SetInputAudioAlwaysOn(input.key);

                    const result = await dialog.showMessageBox({
                        title: 'Additional Action Required',
                        message:
                            'Input created. Click "copy" to copy necessary CSS, then right click the input, go to properties, and paste.',
                        type: 'info',
                        buttons: ['Copy', 'Skip'],
                        defaultId: 0,
                    });

                    if (result.response === 0) {
                        clipboard.writeText('body {background: transparent;}');
                    }

                    found = true;
                }
            });
        } catch (err) {
            // Sadness
            dialog.showErrorBox('Failed', 'Unable to communicate with vMix');
        }
    }
}
