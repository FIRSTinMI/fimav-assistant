import { IpcMain } from 'electron';
import log from 'electron-log';
import HWCheck from './events/HWCheck';
import Alerts from './events/Alerts';
import { dismissAlert } from './window_components/signalR';
import { getAlertsWindow } from './window_components/alertsWindow';

// Use this file to register all events. For uniformity, all events should send their response as <event-name>-response

export default function registerAllEvents(ipc: IpcMain) {
    ipc.on('hwcheck', async (event) => {
        const out = await HWCheck();
        event.reply('hwcheck-response', out);
    });

    ipc.on('alerts:getAlerts', (event) => {
        const alerts = Alerts();
        event.reply('alerts:alerts', alerts);
    });

    ipc.on('alerts:dismissAlert', (_, arg) => {
        log.info('Dismissing alert');
        dismissAlert(arg[0] as string);
    });

    ipc.on('alerts:closeWindow', () => {
        log.info('Closing alerts window');
        getAlertsWindow()?.close();
    });
}
