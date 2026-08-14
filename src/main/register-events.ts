import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'fs';
import log from 'electron-log';
import HWPingResponse, { IpConfigState } from 'models/HWPingResponse';
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
import LiveCaptions from './addons/live-captions';
import getVmixBandwidth, { streamKeyFromUrl } from './vmixBandwidth';
import { AutoAVStatus } from '../models/AutoAVStatus';
import { MatchRecord } from '../models/MatchRecord';
import { listMatches } from './recordings/matchStore';
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
        invokeLog(
            `Starting ${!all ? `stream ${streamNumber}` : 'all streams'}`
        );

        // Start the stream
        VmixService.Instance.StartStream(streamNumber)
            .then(() => {
                invokeLog(
                    `${!all ? `Stream ${streamNumber}` : 'All streams'} started`
                );
                return null;
            })
            .catch((err) => {
                log.error(`Failed to start stream`, err);
                invokeLog(
                    `Failed to start ${
                        !all ? `stream ${streamNumber}` : 'all streams'
                    }`,
                    {
                        severity: EquipmentLogType.Error,
                        category: EquipmentLogCategory.General,
                        extraInfo: err,
                    }
                );
            });
    });

    // Listen for stream start/stop events
    registerListener('StopStream', (streamNumber?: number) => {
        const all = streamNumber === undefined;
        invokeLog(
            `Stopping ${!all ? `stream ${streamNumber}` : 'all streams'}`
        );

        // Start the stream
        VmixService.Instance.StopStream(streamNumber)
            .then(() => {
                invokeLog(
                    `${!all ? `Stream ${streamNumber}` : 'All streams'} stopped`
                );
                return null;
            })
            .catch((err) => {
                log.error(`Failed to stop stream`, err);
                invokeLog(
                    `Failed to stop ${
                        !all ? `stream ${streamNumber}` : 'all streams'
                    }`,
                    {
                        severity: EquipmentLogType.Error,
                        category: EquipmentLogCategory.General,
                        extraInfo: err,
                    }
                );
            });
    });

    // Push the YouTube caption ingestion URL into live-captions. YouTube's HTTP
    // caption ingestion uses cid=<stream key>, so we can build it straight from
    // the RTMP stream key and configure live-captions over its tRPC API
    // (httpBatchLink, no transformer → body is {"0": <input>}).
    async function pushYouTubeCaptions(streams: any[]) {
        const yt = streams.find((s) =>
            /youtube/i.test(s?.rtmpUrl ?? '')
        );
        const key = yt?.rtmpKey || streamKeyFromUrl(yt?.rtmpUrl ?? '');
        if (!key) return;
        const url = `http://upload.youtube.com/closedcaption?cid=${key}`;
        const post = (proc: string, input: unknown) =>
            fetch(`http://127.0.0.1:3000/trpc/${proc}?batch=1`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ '0': input }),
                signal: AbortSignal.timeout(5000),
            });
        try {
            await post('youtubeCaptions.setUrl', { url });
            await post('youtubeCaptions.setEnabled', { enabled: true });
            invokeLog('Pushed YouTube caption URL to live-captions');
        } catch (e) {
            log.error('Failed to push YouTube caption URL', e);
        }
    }

    // #region vMix stream-key validation state
    // When true, the next inbound StreamInfo is a read-only validation poll and
    // must NOT be pushed to vMix (so a comparison poll never re-writes live keys
    // mid-stream). Set right before a poll's invoke('GetStreamInfo').
    let suppressStreamPush = false;
    let suppressResetTimer: ReturnType<typeof setTimeout> | null = null;
    // Latest key comparison, surfaced in the vMix tab.
    let keyValidation: {
        checked: boolean;
        match: boolean | null;
        cloudKeys: string[];
        runningKeys: string[];
    } = { checked: false, match: null, cloudKeys: [], runningKeys: [] };

    // Compare the admin hub's current keys to what ffmpeg is actually streaming.
    async function computeKeyValidation(cloudKeys: string[]) {
        const bw = await getVmixBandwidth();
        const runningKeys = Array.from(
            new Set(
                bw.streams
                    .map((s) => streamKeyFromUrl(s.rtmpUrl))
                    .filter(Boolean)
            )
        );
        const cloud = Array.from(new Set(cloudKeys.filter(Boolean)));
        // Only a real verdict when we have both sides. Match = every running key
        // is present in the cloud set (vMix streaming with a current key).
        let match: boolean | null = null;
        if (cloud.length > 0 && runningKeys.length > 0) {
            match = runningKeys.every((k) => cloud.includes(k));
        }
        keyValidation = { checked: true, match, cloudKeys: cloud, runningKeys };
        const s = await buildVmixStatus();
        window?.webContents.send('vmix:status', s);
    }

    // Listen for stream info from the admin hub. Two paths: a normal push (the
    // Set Stream Keys action) writes the keys into vMix; a validation poll
    // (suppressStreamPush) only compares them, never writing.
    registerListener('StreamInfo', (info) => {
        const streams = (info as any[]) ?? [];
        if (suppressStreamPush) {
            suppressStreamPush = false;
            if (suppressResetTimer) {
                clearTimeout(suppressResetTimer);
                suppressResetTimer = null;
            }
            const cloudKeys = streams
                .map((s: any) => s.rtmpKey ?? streamKeyFromUrl(s.rtmpUrl ?? ''))
                .filter(Boolean);
            computeKeyValidation(cloudKeys).catch((e) =>
                log.error('Key validation failed', e)
            );
            return;
        }

        VmixService.Instance.SetStreamInfo(info as any)
            .then(() => {
                invokeLog(`Stream info updated`);
                // Record that we set stream keys for the current event, so the
                // vMix tab can show "keys set for <event>" (vMix can't be read
                // back for this).
                const ev = AutoAV.Instance.getStatus().currentEvent;
                store.set('vmixStreamKeys', {
                    eventCode: ev?.code ?? '',
                    eventName: ev?.name ?? 'Unknown Event',
                    setAt: Date.now(),
                });
                // Also configure live-captions' YouTube caption push from the
                // same key (cid == stream key).
                pushYouTubeCaptions((info as any[]) ?? []);
                buildVmixStatus()
                    .then((s) => window?.webContents.send('vmix:status', s))
                    .catch(() => {});
                return null;
            })
            .catch((err) => {
                log.error(`Failed to update stream info`, err);
                invokeLog(`Failed to update stream info`, {
                    severity: EquipmentLogType.Error,
                    category: EquipmentLogCategory.General,
                    extraInfo: err,
                });
            });
    });
    // #endregion vMix stream-key validation state

    registerListener('GetVmixConfig', async () => {
        const resp = await VmixService.Instance.GetBase();
        return JSON.stringify(resp);
    });

    // #region vMix tab

    // Build the vMix tab status: live reachability/recording/streaming from a
    // single GetBase call, plus whether stream keys were set for THIS event.
    async function buildVmixStatus() {
        let reachable = false;
        let recording = false;
        let streaming = false;
        try {
            const parsed = await VmixService.Instance.GetBase();
            reachable = !!parsed?.vmix;
            recording = parsed?.vmix?.recording?.['#text'] === 'True';
            const s = parsed?.vmix?.streaming;
            const sText = typeof s === 'object' ? s?.['#text'] : s;
            streaming = sText === 'True' || sText === true;
        } catch {
            reachable = false;
        }

        const {currentEvent} = AutoAV.Instance.getStatus();
        const keys = store.get('vmixStreamKeys');
        // Only count keys as "set for this event" if the recorded event matches
        // the one running now (by code when available, else name).
        const keysSetForEvent =
            !!keys &&
            !!currentEvent &&
            (currentEvent.code
                ? keys.eventCode === currentEvent.code
                : keys.eventName === currentEvent.name);

        return {
            reachable,
            recording,
            streaming,
            currentEvent,
            streamKeys: keys,
            keysSetForEvent,
            keyValidation,
        };
    }

    ipcMain.on('vmix:getStatus', async (event) => {
        event.reply('vmix:status', await buildVmixStatus());
    });

    // Read-only key validation poll: ask the admin hub for the current keys
    // (handled in the suppressed StreamInfo branch, which compares without
    // pushing to vMix). Safety timer clears the suppress flag if no response.
    ipcMain.on('vmix:pollKeys', () => {
        suppressStreamPush = true;
        if (suppressResetTimer) clearTimeout(suppressResetTimer);
        suppressResetTimer = setTimeout(() => {
            suppressStreamPush = false;
            suppressResetTimer = null;
        }, 10000);
        invoke('GetStreamInfo');
    });

    // Live streaming bandwidth (per-stream ffmpeg bitrate). Polled only while the
    // vMix tab is open, so the PowerShell call costs nothing off-tab.
    ipcMain.on('vmix:getBandwidth', async (event) => {
        event.reply('vmix:bandwidth', await getVmixBandwidth());
    });

    ipcMain.on('vmix:getSettings', (event) => {
        event.reply('vmix:settings', store.get('vmixApi'));
    });

    ipcMain.on('vmix:saveSettings', (event, [vmixApi]) => {
        store.set('vmixApi', vmixApi);
        VmixService.Instance.updateSettings(vmixApi);
        event.reply('vmix:settings', store.get('vmixApi'));
    });

    ipcMain.on('vmix:testConnection', async (event, [vmixApi]) => {
        try {
            const parsed = await new VmixService(vmixApi).GetBase();
            const ok = !!parsed?.vmix;
            event.reply('vmix:testResult', {
                ok,
                message: ok
                    ? 'Connected to vMix'
                    : 'Reached the address but it did not answer as vMix',
            });
        } catch (e) {
            event.reply('vmix:testResult', {
                ok: false,
                message: `Could not reach vMix: ${(e as Error).message}`,
            });
        }
    });

    // Set stream keys: mirrors the old menu action - ask the server for this
    // event's stream info over SignalR, which comes back through the StreamInfo
    // listener above and gets pushed into vMix (and recorded).
    ipcMain.on('vmix:setStreamKeys', (event) => {
        const timeout = setTimeout(() => {
            event.reply('vmix:action', {
                ok: false,
                action: 'setStreamKeys',
                message: 'Timed out asking the server for stream keys',
            });
        }, 10000);
        VmixService.Instance.events.once(
            'streamInfoUpdated',
            async (success: boolean) => {
                clearTimeout(timeout);
                event.reply('vmix:action', {
                    ok: success,
                    action: 'setStreamKeys',
                    message: success
                        ? 'Stream keys set in vMix'
                        : 'Failed to set stream keys - check the logs',
                });
                event.reply('vmix:status', await buildVmixStatus());
            }
        );
        invoke('GetStreamInfo');
    });

    ipcMain.on('vmix:addLiveCaptionsInput', async (event) => {
        try {
            await VmixService.Instance.AddLiveCaptionsInput();
            event.reply('vmix:action', {
                ok: true,
                action: 'addLiveCaptionsInput',
                message: 'Added Live Captions input to vMix',
            });
        } catch (e) {
            event.reply('vmix:action', {
                ok: false,
                action: 'addLiveCaptionsInput',
                message: `Failed: ${(e as Error).message}`,
            });
        }
    });

    ipcMain.on('vmix:addAudienceDisplayInput', async (event) => {
        try {
            await VmixService.Instance.AddAudienceDisplayInput();
            event.reply('vmix:action', {
                ok: true,
                action: 'addAudienceDisplayInput',
                message: 'Added Audience Display input to vMix',
            });
        } catch (e) {
            event.reply('vmix:action', {
                ok: false,
                action: 'addAudienceDisplayInput',
                message: `Failed: ${(e as Error).message}`,
            });
        }
    });

    // Alliance-selection composite: list inputs for the pickers, read/apply the
    // (tunable, saved) geometry that overlays the camera on the base input.
    ipcMain.on('vmix:getInputs', async (event) => {
        try {
            event.reply('vmix:inputs', await VmixService.Instance.GetInputs());
        } catch {
            event.reply('vmix:inputs', []);
        }
    });

    ipcMain.on('vmix:getComposite', (event) => {
        event.reply('vmix:composite', store.get('vmixComposite'));
    });

    ipcMain.on('vmix:applyComposite', async (event, [cfg]) => {
        try {
            await VmixService.Instance.CreateAllianceComposite(
                cfg.fmsKey,
                cfg.cameraKey,
                cfg.zoom,
                cfg.panX,
                cfg.panY
            );
            // Persist the geometry (not the input keys, which vary per session).
            store.set('vmixComposite', {
                layer: cfg.layer,
                zoom: cfg.zoom,
                panX: cfg.panX,
                panY: cfg.panY,
            });
            event.reply('vmix:action', {
                ok: true,
                action: 'applyComposite',
                message: 'Alliance Selection Composite input ready',
            });
        } catch (e) {
            event.reply('vmix:action', {
                ok: false,
                action: 'applyComposite',
                message: `Failed: ${(e as Error).message}`,
            });
        }
    });

    // #endregion vMix tab

    // Register a emitter listener for the hwping response.  Any time the hwping service updates, we'll send the updated list to the renderer
    HWPing.Instance.on('hw-change', (res: HWPingResponse) => {
        window?.webContents.send('hw-change', res);
        window?.webContents.send('backend-status-update', {
            key: 'hw_stats',
            val: res,
        });
        lastHWPing = res;
    });

    // Forward IP config anomaly events to the renderer
    HWPing.Instance.on('ip-config-changed', (res: IpConfigState) => {
        window?.webContents.send('ip-config-changed', res);
    });

    AutoAV.Instance.on('info', (info: string) => {
        window?.webContents.send('backend-status-update', {
            key: 'auto_av_log',
            val: info,
        });
        lastAutoAV = info;
    });

    // Forward structured AutoAV status + match records to the Auto AV tab
    let lastAutoAvStatus: AutoAVStatus = AutoAV.Instance.getStatus();
    AutoAV.Instance.on('status', (status: AutoAVStatus) => {
        lastAutoAvStatus = status;
        window?.webContents.send('autoav:status', status);
    });

    AutoAV.Instance.on('match', (record: MatchRecord) => {
        window?.webContents.send('autoav:match', record);
    });

    // The recorded-match list for the folder the app is currently pointed at,
    // pushed whenever the event folder changes.
    AutoAV.Instance.on('matches', (matches: MatchRecord[]) => {
        window?.webContents.send('autoav:matches', matches);
    });

    // The Auto AV tab requests the full current state on mount
    ipcMain.on('autoav:getState', (event) => {
        event.reply('autoav:status', lastAutoAvStatus);
        event.reply(
            'autoav:matches',
            listMatches(lastAutoAvStatus.saveFolder)
        );
    });

    // Manually cut the dead time out of a recorded match (the Cut button).
    ipcMain.on('autoav:cutMatch', (_event, [folder, id]) => {
        if (typeof folder === 'string' && typeof id === 'string') {
            AutoAV.Instance.queueCut(folder, id);
        }
    });

    // AutoAV addon controls (top control row on the Auto AV tab)
    ipcMain.on('autoav:restart', (event) => {
        AutoAV.Instance.stop();
        AutoAV.Instance.start();
        event.reply('autoav:status', AutoAV.Instance.getStatus());
    });

    ipcMain.on('autoav:stopAddon', (event) => {
        AutoAV.Instance.stop();
        event.reply('autoav:status', AutoAV.Instance.getStatus());
    });

    // Live Captions status + controls for the Live Captions tab
    const liveCaptionsStatus = () => ({
        running: LiveCaptions.Instance.isRunning(),
        version: LiveCaptions.Instance.getVersion(),
    });

    ipcMain.on('liveCaptions:getStatus', (event) => {
        event.reply('liveCaptions:status', liveCaptionsStatus());
    });

    ipcMain.on('liveCaptions:restart', async (event) => {
        try {
            await LiveCaptions.Instance.stop();
            await LiveCaptions.Instance.start();
        } catch (e) {
            log.error('Live-captions restart failed', e);
        }
        event.reply('liveCaptions:status', liveCaptionsStatus());
    });

    ipcMain.on('liveCaptions:stop', async (event) => {
        try {
            await LiveCaptions.Instance.stop();
        } catch (e) {
            log.error('Live-captions stop failed', e);
        }
        event.reply('liveCaptions:status', liveCaptionsStatus());
    });

    // Version click → check GitHub for a newer live-captions build.
    ipcMain.on('liveCaptions:checkUpdate', async (event) => {
        event.reply(
            'liveCaptions:updateInfo',
            await LiveCaptions.Instance.checkForUpdate()
        );
    });

    // Confirmed update: stop, re-start (start() downloads the newest), then
    // reload the vMix Live Captions browser input so it serves the new build.
    ipcMain.on('liveCaptions:update', async (event) => {
        try {
            await LiveCaptions.Instance.stop();
            await LiveCaptions.Instance.start();
            try {
                await VmixService.Instance.ReloadBrowserInput('Live Captions');
            } catch (e) {
                log.warn('Could not reload vMix Live Captions input', e);
            }
        } catch (e) {
            log.error('Live-captions update failed', e);
        }
        event.reply('liveCaptions:status', liveCaptionsStatus());
    });

    // Auto AV settings dialog: naming + save folder (vMix connection now lives
    // in the vMix tab).
    const autoAvSettings = () => ({
        fileNameMode: store.get('autoAv.fileNameMode', 'in-season'),
        eventNameOverride: store.get('autoAv.eventNameOverride', ''),
        saveFolder: store.get('autoAv.saveFolder', ''),
        autoCut: store.get('autoAv.autoCut', false),
    });

    ipcMain.on('autoav:getSettings', (event) => {
        event.reply('autoav:settings', autoAvSettings());
    });

    // Open the current recording folder in Explorer (folder icon on the tab)
    ipcMain.on('autoav:openFolder', () => {
        const folder = AutoAV.Instance.getStatus().saveFolder;
        if (folder) {
            // Create it first if it doesn't exist yet, so the open succeeds even
            // before the first recording lands.
            try {
                if (!fs.existsSync(folder)) {
                    fs.mkdirSync(folder, { recursive: true });
                }
            } catch {
                // best effort
            }
            shell.openPath(folder);
        }
    });

    // Reveal a specific file (e.g. a cut output) in Explorer, selected.
    ipcMain.on('autoav:revealFile', (_event, [filePath]) => {
        if (typeof filePath === 'string' && filePath) {
            shell.showItemInFolder(filePath);
        }
    });

    // Native folder picker for the save-folder field
    ipcMain.on('autoav:pickFolder', async (event) => {
        const win = BrowserWindow.getFocusedWindow() ?? window ?? undefined;
        const result = await (win
            ? dialog.showOpenDialog(win, { properties: ['openDirectory'] })
            : dialog.showOpenDialog({ properties: ['openDirectory'] }));
        if (!result.canceled && result.filePaths[0]) {
            event.reply('autoav:folderPicked', result.filePaths[0]);
        }
    });

    // Persist Auto AV settings and apply them live.
    ipcMain.on('autoav:saveSettings', (event, [settings]) => {
        store.set('autoAv.fileNameMode', settings.fileNameMode);
        store.set('autoAv.eventNameOverride', settings.eventNameOverride ?? '');
        store.set('autoAv.saveFolder', settings.saveFolder ?? '');
        store.set('autoAv.autoCut', !!settings.autoCut);
        AutoAV.Instance.applySettings();
        event.reply('autoav:settings', autoAvSettings());
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
