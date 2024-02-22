import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import HWPingResponse from 'models/HWPingResponse';
import HWCheck from './events/HWCheck';
import Alerts from './events/Alerts';
import { dismissAlert, invoke, registerListener } from './window_components/signalR';
import { getAlertsWindow } from './window_components/alertsWindow';
import HWPing from './addons/hw-ping';

// Use this file to register all events. For uniformity, all events should send their response as <event-name>-response

export default function registerAllEvents(window: BrowserWindow | null) {
    ipcMain.on('hwcheck', async (event) => {
        const out = await HWCheck();
        event.reply('hwcheck-response', out);
    });

    ipcMain.on('event-info', async () => {
        invoke('GetEvents');
    });

    ipcMain.on('hw-status', (event) => {
        event.reply('hw-change', HWPing.Instance.currentStatus);
    })

    // Register a SignalR listener for the Events response.  Any time an event is updated, we'll send the updated list to the renderer
    registerListener('Events', (events) => {
        window?.webContents.send('new-event-info', events);
    });

    // Register a emitter listener for the hwping response.  Any time the hwping service updates, we'll send the updated list to the renderer
    HWPing.Instance.on('hw-change', (res: HWPingResponse) => {
        window?.webContents.send('hw-change', res);
    });

    ipcMain.on('alerts:getAlerts', (event) => {
        const alerts = Alerts();
        event.reply('alerts:alerts', alerts);
    });

    ipcMain.on('alerts:dismissAlert', (_, arg) => {
        log.info('Dismissing alert');
        dismissAlert(arg[0] as string);
    });

    ipcMain.on('alerts:closeWindow', () => {
        log.info('Closing alerts window');
        getAlertsWindow()?.close();
    });
}
