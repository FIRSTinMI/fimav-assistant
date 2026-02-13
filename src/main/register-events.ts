import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import HWPingResponse from 'models/HWPingResponse';
import { EquipmentLogCategory, EquipmentLogType } from '../models/EquipmentLog';
import VmixService from '../services/VmixService';
import HWCheck, { enableDhcp } from './events/HWCheck';
import Alerts from './events/Alerts';
import {
    dismissAlert,
    invoke,
    invokeLog,
    registerListener,
} from './window_components/signalR';
import { getAlertsWindow } from './window_components/alertsWindow';
import HWPing from './addons/hw-ping';
import { getStore } from './store';
import Event from '../models/Event';
import AutoAV from './addons/autoav';
import { StaticIpInfo } from '../models/HWCheckResponse';
import { getCurrentEvent } from './util';

// Use this file to register all events. For uniformity, all events should send their response as <event-name>-response

export default function registerAllEvents(window: BrowserWindow | null) {
    const store = getStore();

    // Track the last responses
    let lastHWPing: HWPingResponse = HWPing.Instance.currentStatus;
    let lastAutoAV: string | null = null;

    ipcMain.on('hwcheck', async (event) => {
        const out = await HWCheck();
        event.reply('hwcheck-response', out);
    });

    ipcMain.on('event-info', async () => {
        invoke('GetEvents');
    });

    ipcMain.on('hw-status', (event) => {
        event.reply('hw-change', HWPing.Instance.currentStatus);
    });

    ipcMain.on('steps:set', (_, [step]) => {
        store.set('currentStep', step);
        if (store.get('stepsStartedAt') === 0) {
            store.set('stepsStartedAt', new Date().getTime());
        }
        invokeLog(`Wizard: moved to step ${step}`);
    });

    ipcMain.on('steps:get', (event) => {
        // This is the step that we'll reply with
        let stepToReply = 0;

        // Get the step start date
        const lastStart = store.get('stepsStartedAt');

        // If we don't have a date key (I.E. it's 0), we haven't started the steps yet
        if (!lastStart) {
            stepToReply = 0;
        } else {
            // Convert to date
            const startDate = new Date(lastStart);

            // If today is Monday, and the start date is not today, reset the steps
            const startDayOfWeek: number = startDate.getDay();

            // Calculate the number of days needed to reach the next Monday
            const daysUntilMonday =
                startDayOfWeek === 1 ? 7 : (8 - startDayOfWeek) % 7;

            // Create a new date object by adding the days until Monday to the startDate
            const nextMonday = new Date(startDate);
            nextMonday.setDate(startDate.getDate() + daysUntilMonday);
            nextMonday.setHours(0, 0, 0, 0);

            // Calculate if a Monday has passed since startDate
            const mondayHasPassed: boolean =
                new Date().getTime() > nextMonday.getTime();

            // Calculate if the startDate is today (this should be redudnant, but it's here for safety)
            const startDateIsToday =
                startDate.toDateString() === new Date().toDateString();

            if (mondayHasPassed && !startDateIsToday) {
                store.set('stepsStartedAt', 0);
                store.set('currentStep', 0);
                stepToReply = 0;
            } else {
                // Otherwise, we're clear to continue where we left off.  If we don't have a step, we'll start at 0
                const step = store.get('currentStep');
                if (step) {
                    stepToReply = step;
                } else {
                    stepToReply = 0;
                }
            }
        }

        // Reply with the step
        event.reply('steps:get', stepToReply);
    });

    // Register a SignalR listener for the Events response.  Any time an event is updated, we'll send the updated list to the renderer
    registerListener('Events', async (events: Event[]) => {
        window?.webContents.send('new-event-info', events);

        // Find the event that is current running (date is between start and end)
        const currentEvent = await getCurrentEvent(events);
        AutoAV.Instance.setEvent(currentEvent);

        // TODO: Handle ending the current event and starting the next if the computer is never rebooted
    });

    // Listen for stream start/stop events
    registerListener('StartStream', (streamNumber?: number) => {
        const all = streamNumber === undefined;
        invokeLog(`Starting ${!all ? `stream ${streamNumber}` : 'all streams'}`);

        // Start the stream
        VmixService.Instance.StartStream(streamNumber).then(() => {
            invokeLog(`${!all ? `Stream ${streamNumber}` : 'All streams'} started`);
            return null;
        }).catch((err) => {
            log.error(`Failed to start stream`, err);
            invokeLog(`Failed to start ${!all ? `stream ${streamNumber}` : 'all streams'}`, {
                severity: EquipmentLogType.Error,
                category: EquipmentLogCategory.General,
                extraInfo: err
            });
        });
    });

    // Listen for stream start/stop events
    registerListener('StopStream', (streamNumber?: number) => {
        const all = streamNumber === undefined;
        invokeLog(`Stopping ${!all ? `stream ${streamNumber}` : 'all streams'}`);

        // Start the stream
        VmixService.Instance.StopStream(streamNumber).then(() => {
            invokeLog(`${!all ? `Stream ${streamNumber}` : 'All streams'} stopped`);
            return null;
        }).catch((err) => {
            log.error(`Failed to stop stream`, err);
            invokeLog(`Failed to stop ${!all ? `stream ${streamNumber}` : 'all streams'}`, {
                severity: EquipmentLogType.Error,
                category: EquipmentLogCategory.General,
                extraInfo: err
            });
        });
    });

    // Listen for stream start/stop events
    registerListener('StreamInfo', (info) => {
        VmixService.Instance.SetStreamInfo(info as any).then(() => {
            invokeLog(`Stream info updated`);
            return null;
        }).catch((err) => {
            log.error(`Failed to update stream info`, err);
            invokeLog(`Failed to update stream info`, {
                severity: EquipmentLogType.Error,
                category: EquipmentLogCategory.General,
                extraInfo: err
            });
        });
    });
    
    registerListener('GetVmixConfig', async () => {
        const resp = await VmixService.Instance.GetBase();
        return JSON.stringify(resp);
    });

    // Register a emitter listener for the hwping response.  Any time the hwping service updates, we'll send the updated list to the renderer
    HWPing.Instance.on('hw-change', (res: HWPingResponse) => {
        window?.webContents.send('hw-change', res);
        window?.webContents.send('backend-status-update', {
            key: 'hw_stats',
            val: res,
        });
        lastHWPing = res;
    });

    AutoAV.Instance.on('info', (info: string) => {
        window?.webContents.send('backend-status-update', {
            key: 'auto_av_log',
            val: info,
        });
        lastAutoAV = info;
    });

    // Register a listener for the backend status.  Any time the renderer sends this event, we'll send the current status of the backend
    ipcMain.on('backend-status', (event) => {
        event.reply('backend-status-update', {
            key: 'auto_av_log',
            val: lastAutoAV,
        });
        event.reply('backend-status-update', {
            key: 'hw_stats',
            val: lastHWPing,
        });
    });

    ipcMain.on('set-venue-ip-dhcp', async (event, info: StaticIpInfo[]) => {
        event.reply(
            'set-venue-ip-dhcp-response',
            await enableDhcp(info[0].interface)
        );
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
