import {
    BrowserWindow,
    dialog,
    ipcMain,
    IpcMainEvent,
    Notification,
    shell,
} from 'electron';
import fs from 'fs';
import log from 'electron-log';
import HWPingResponse, { IpConfigState } from 'models/HWPingResponse';
import { EquipmentLogCategory, EquipmentLogType } from '../models/EquipmentLog';
import VmixService from '../services/VmixService';
import HWCheck, { enableDhcp } from './events/HWCheck';
import Checks from './checks/engine';
import LevelWizard from './checks/levelWizard';
import { LEVEL_STEPS_ORDER } from '../models/Levels';
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
import YoutubeUploaderAddon from './addons/upload-helper';
import AudienceDisplayAddon from './addons/audience-display';
import FtcScorekeeper from './ftc/scorekeeper';
import getVmixBandwidth, { streamKeyFromUrl } from './vmixBandwidth';
import { AutoAVStatus } from '../models/AutoAVStatus';
import { MatchRecord } from '../models/MatchRecord';
import isReadyForUpload from './recordings/uploadReady';
import { StaticIpInfo } from '../models/HWCheckResponse';
import { getCurrentEvent } from './util';
import startStatusApi from './api/server';
import {
    clearCompanionButton,
    companionUrl,
    CUSTOM_AD_URL,
    readCompanionLayout,
    readCustomAd,
    readFmsAutomation,
    saveCompanionButton,
    saveCustomAd,
    saveFmsAutomation,
} from './bitfocus';

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
        const yt = streams.find((s) => /youtube/i.test(s?.rtmpUrl ?? ''));
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

        (async () => {
            try {
                await VmixService.Instance.SetStreamInfo(info as any);
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
            } catch (err) {
                log.error(`Failed to update stream info`, err);
                invokeLog(`Failed to update stream info`, {
                    severity: EquipmentLogType.Error,
                    category: EquipmentLogCategory.General,
                    extraInfo: err as object,
                });
                return;
            }
            try {
                window?.webContents.send(
                    'vmix:status',
                    await buildVmixStatus()
                );
            } catch {
                // status refresh is best-effort
            }
        })();
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

        const { currentEvent } = AutoAV.Instance.getStatus();
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
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const onUpdated = async (success: boolean) => {
            clearTimeout(timeout);
            event.reply('vmix:action', {
                ok: success,
                action: 'setStreamKeys',
                message: success
                    ? 'Stream keys set in vMix'
                    : 'Failed to set stream keys - check the logs',
            });
            event.reply('vmix:status', await buildVmixStatus());
        };
        // On timeout the listener goes too, so a late push cannot report
        // success after "Timed out".
        timeout = setTimeout(() => {
            VmixService.Instance.events.off('streamInfoUpdated', onUpdated);
            event.reply('vmix:action', {
                ok: false,
                action: 'setStreamKeys',
                message: 'Timed out asking the server for stream keys',
            });
        }, 10000);
        VmixService.Instance.events.once('streamInfoUpdated', onUpdated);
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

    // The audience display in use: FTC Live's display at FTC events; at FRC
    // events the custom display when it runs (off-season, chosen as the
    // Bitfocus trigger source), otherwise the FMS display.
    const audienceDisplayInput = () => {
        if (AutoAV.Instance.isFtc()) {
            const { address, eventCode } = FtcScorekeeper.Instance.getStatus();
            if (!address || !eventCode) {
                throw new Error('No FTC scorekeeper event');
            }
            // FTC Live's audience display as an overlay: transparent
            // background, score bar at the bottom, all fields, hybrid
            // alliance selection (the list over a camera).
            const options = new URLSearchParams({
                type: 'audience',
                bindToField: 'all',
                scoringBarLocation: 'bottom',
                allianceOrientation: 'standard',
                mute: 'false',
                muteRandomizationResults: 'false',
                inspectionGroupDivision: 'false',
                fieldStyleTimer: 'false',
                overlay: 'true',
                overlayColor: 'transparent',
                allianceSelectionStyle: 'hybrid',
                awardsStyle: 'overlay',
                dualDivisionRankingStyle: 'sideBySide',
                rankingsFontSize: 'larger',
                showMeetRankings: 'false',
                rankingsAllTeams: 'true',
                name: 'Audience',
            });
            return {
                url: `http://${address}/event/${eventCode}/display/?${options}`,
                name: 'Audience Display',
            };
        }
        const customAd = AutoAV.Instance.runsCustomAd();
        return {
            url: customAd
                ? 'http://127.0.0.1:3001/display'
                : 'http://10.0.100.5/AudienceDisplay',
            name: 'FMS',
        };
    };

    ipcMain.on('vmix:addAudienceDisplayInput', async (event) => {
        try {
            const { url, name } = audienceDisplayInput();
            await VmixService.Instance.AddAudienceDisplayInput(url, name);
            event.reply('vmix:action', {
                ok: true,
                action: 'addAudienceDisplayInput',
                message: `Added ${name} input to vMix`,
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

    // Teams at the event, for the Offseason AD composite: the count of FMS's
    // qualification rankings, the same list the display pre-fills from
    // (audience-display getRankings). null when FMS does not answer.
    ipcMain.on('vmix:getTeamCount', async (event) => {
        let count: number | null = null;
        try {
            const rsp = await fetch(
                'http://10.0.100.5/api/v1.0/audience/get/GetQualRankings',
                { signal: AbortSignal.timeout(3000) }
            );
            const list = (await rsp.json()) as { teamNumber?: number }[];
            if (Array.isArray(list))
                count =
                    list.filter((t) => (t?.teamNumber ?? 0) > 0).length || null;
        } catch {
            count = null;
        }
        event.reply('vmix:teamCount', count);
    });

    ipcMain.on('vmix:getComposite', (event) => {
        event.reply('vmix:composite', store.get('vmixComposite'));
    });

    // FTC Live's hybrid alliance selection camera box, measured on FTC Live
    // 8.0 at 1920x1080 (X119 Y357 W912 H513): zoom = W/1920,
    // panX = (centerX-960)/960, panY = (540-centerY)/540.
    const FTC_COMPOSITE = { zoom: 0.475, panX: -0.401, panY: -0.1361 };

    // The Offseason AD's alliance selection camera box, copied from its own
    // vMix camera setup (audience-display packages/server/src/vmix.ts,
    // boxRect): the team grid has one row per 7 teams, which sets where the
    // camera area starts; the box is the 16:9 rectangle centred in it, in the
    // display's 1920x1080 space. Returned as the composite's zoom/pan.
    const customAdComposite = (teamCount: number) => {
        const rankRows = Math.max(1, Math.ceil(Math.max(1, teamCount) / 7));
        const camX = 56;
        const camW = 1158;
        const camY = 232 + 44 * rankRows;
        const camH = 820 - 44 * rankRows;
        const boxW = Math.min(camW, (camH * 16) / 9);
        const cx = camX + camW / 2;
        const cy = camY + camH / 2;
        return {
            zoom: boxW / 1920,
            panX: (cx - 960) / 960,
            panY: (540 - cy) / 540,
        };
    };

    ipcMain.on('vmix:applyComposite', async (event, [cfg]) => {
        try {
            const ftc = AutoAV.Instance.isFtc();
            const customAd = !ftc && AutoAV.Instance.runsCustomAd();
            let geo = cfg;
            if (ftc) geo = FTC_COMPOSITE;
            else if (customAd) geo = customAdComposite(Number(cfg.teamCount));
            await VmixService.Instance.CreateAllianceComposite(
                cfg.fmsKey,
                cfg.cameraKey,
                geo.zoom,
                geo.panX,
                geo.panY
            );
            // Persist the FMS geometry (not the input keys, which vary per
            // session). FTC's is fixed; the Offseason AD's follows the team count.
            if (!ftc && !customAd) {
                store.set('vmixComposite', {
                    layer: cfg.layer,
                    zoom: cfg.zoom,
                    panX: cfg.panX,
                    panY: cfg.panY,
                });
            }
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
        event.reply('autoav:matches', AutoAV.Instance.matches());
    });

    // Manually cut the dead time out of a recorded match (the Cut button).
    ipcMain.on('autoav:cutMatch', (_event, [folder, id]) => {
        // Dead-time cutting: FTC always, FRC off-season only.
        if (!AutoAV.Instance.isFtc() && !AutoAV.Instance.isFrcOffSeason())
            return;
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
        phase: LiveCaptions.Instance.getPhase(),
        version: LiveCaptions.Instance.getVersion(),
    });

    // Pushed on every phase change, so the tab needs no polling.
    LiveCaptions.Instance.phase.on('phase', () =>
        window?.webContents.send('liveCaptions:status', liveCaptionsStatus())
    );

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

    // #region Bitfocus tab

    // Every Bitfocus request answers on one channel with {op, ok, data|error},
    // so the tab can show each failure next to the part it belongs to.
    const bitfocusReply = async (
        event: IpcMainEvent,
        op: string,
        run: () => Promise<unknown>
    ) => {
        try {
            event.reply('bitfocus:result', { op, ok: true, data: await run() });
        } catch (e: any) {
            event.reply('bitfocus:result', {
                op,
                ok: false,
                error: e?.message ?? String(e),
            });
        }
    };

    ipcMain.on('bitfocus:getLayout', (event) =>
        bitfocusReply(event, 'layout', () =>
            readCompanionLayout(companionUrl())
        )
    );

    ipcMain.on('bitfocus:saveButton', (event, [edit]) =>
        bitfocusReply(event, 'saveButton', async () => {
            const url = companionUrl();
            await saveCompanionButton(url, edit);
            return readCompanionLayout(url);
        })
    );

    ipcMain.on('bitfocus:clearButton', (event, [page, row, column]) =>
        bitfocusReply(event, 'clearButton', async () => {
            const url = companionUrl();
            await clearCompanionButton(url, page, row, column);
            return readCompanionLayout(url);
        })
    );

    ipcMain.on('bitfocus:getVmixInputs', (event) =>
        bitfocusReply(event, 'vmixInputs', async () =>
            (await VmixService.Instance.GetInputs()).map((i) => i.title)
        )
    );

    // FTC Live: connection status pushed to the UI, settings, scan, triggers.
    FtcScorekeeper.Instance.on('status', (s) =>
        window?.webContents.send('ftc:status', s)
    );

    const ftcSettings = () => ({
        address: store.get('ftc.address', ''),
        eventCode: store.get('ftc.eventCode', ''),
        automations: store.get('ftc.automations', true),
        triggers: store.get('ftc.triggers', {}),
        matchSeconds: store.get('ftc.matchSeconds', 158),
        tailSeconds: store.get('ftc.tailSeconds', 5),
    });

    ipcMain.on('ftc:getState', (event) => {
        event.reply('ftc:status', FtcScorekeeper.Instance.getStatus());
        event.reply('ftc:settings', ftcSettings());
    });

    // Address / event / automations. A changed address or event reconnects.
    ipcMain.on('ftc:saveSettings', (event, [s]) => {
        const before = ftcSettings();
        if (typeof s?.address === 'string')
            store.set(
                'ftc.address',
                s.address
                    .trim()
                    .replace(/^https?:\/\//, '')
                    .replace(/\/+$/, '')
            );
        if (typeof s?.eventCode === 'string')
            store.set('ftc.eventCode', s.eventCode.trim());
        if (typeof s?.automations === 'boolean')
            store.set('ftc.automations', s.automations);
        if (s?.triggers && typeof s.triggers === 'object')
            store.set('ftc.triggers', s.triggers);
        if (Number.isFinite(s?.matchSeconds) && s.matchSeconds > 0)
            store.set('ftc.matchSeconds', s.matchSeconds);
        if (Number.isFinite(s?.tailSeconds) && s.tailSeconds >= 0)
            store.set('ftc.tailSeconds', s.tailSeconds);
        const after = ftcSettings();
        if (
            before.address !== after.address ||
            before.eventCode !== after.eventCode
        ) {
            FtcScorekeeper.Instance.start();
        }
        event.reply('ftc:settings', after);
    });

    // With neither field system answering, look for a scorekeeper on the
    // network (not when Settings forces FRC).
    FtcScorekeeper.Instance.startAutoScan(() => {
        if (store.get('program', 'auto') === 'frc') return false;
        const st = AutoAV.Instance.getStatus();
        return !st.fmsConnected && !st.ftcConnected;
    });

    ipcMain.on('ftc:scan', async (event) => {
        event.reply('ftc:scanResult', await FtcScorekeeper.Instance.scan());
    });

    ipcMain.on('bitfocus:getFms', (event) =>
        bitfocusReply(event, 'fms', () => readFmsAutomation())
    );

    ipcMain.on('bitfocus:saveFms', (event, [automation]) =>
        bitfocusReply(event, 'fms', () => saveFmsAutomation(automation))
    );

    ipcMain.on('bitfocus:getCustomAd', (event) =>
        bitfocusReply(event, 'customAd', () => readCustomAd(CUSTOM_AD_URL))
    );

    ipcMain.on('bitfocus:saveCustomAd', (event, [config]) =>
        bitfocusReply(event, 'customAd', () =>
            saveCustomAd(CUSTOM_AD_URL, config)
        )
    );

    // The full Companion UI in its own window.
    ipcMain.on('bitfocus:openCompanion', () => {
        const win = new BrowserWindow({
            width: 1400,
            height: 900,
            title: 'Companion',
            autoHideMenuBar: true,
        });
        win.loadURL(companionUrl());
    });

    // #endregion Bitfocus tab

    // #region Upload tab (youtube-tba-upload process)

    // A match video just became final (renamed, cut, or the FTC recorder's
    // file made): tell the uploader at once instead of after its folder
    // scan. Once per record.
    const announcedVideos = new Set<string>();
    AutoAV.Instance.on('match', (rec: MatchRecord) => {
        if (!rec?.filePath || announcedVideos.has(rec.id)) return;
        if (!isReadyForUpload(rec)) return;
        announcedVideos.add(rec.id);
        YoutubeUploaderAddon.Instance.videoReady(rec.filePath);
    });

    // YouTube uploader status + controls for the Upload tab's control row. The
    // event key rides along so the renderer can scope its direct :8807 fetches.
    const uploadStatus = () => ({
        running: YoutubeUploaderAddon.Instance.isRunning(),
        phase: YoutubeUploaderAddon.Instance.getPhase(),
        version: YoutubeUploaderAddon.Instance.getVersion(),
        eventKey: YoutubeUploaderAddon.Instance.eventKey(),
    });
    // Uploader event stream -> Upload tab (sign-in, queue, uploads).
    YoutubeUploaderAddon.Instance.events.on('message', (m) =>
        window?.webContents.send('upload:event', m)
    );
    YoutubeUploaderAddon.Instance.events.on('connection', () =>
        window?.webContents.send('upload:status', uploadStatus())
    );
    YoutubeUploaderAddon.Instance.phase.on('phase', () =>
        window?.webContents.send('upload:status', uploadStatus())
    );
    // The Upload tab names the uploader's key on every request; a switch must
    // reach it at once, or it keeps asking under the old key and the
    // uploader rebuilds the old manager next to the new one.
    YoutubeUploaderAddon.Instance.events.on('key', () =>
        window?.webContents.send('upload:status', uploadStatus())
    );

    // The playlist the uploader has for its current key.
    const readUploaderPlaylist = async (): Promise<{
        id: string;
        name: string;
    }> => {
        const key = YoutubeUploaderAddon.Instance.eventKey();
        if (!key || !YoutubeUploaderAddon.Instance.isRunning())
            return { id: '', name: '' };
        try {
            const res = await fetch(
                `http://127.0.0.1:8807/api/upload/state?event_key=${encodeURIComponent(
                    key
                )}`,
                { signal: AbortSignal.timeout(3000) }
            );
            const st = await res.json();
            return {
                id: st?.config?.playlist_id ?? '',
                name: st?.config?.playlist_name ?? '',
            };
        } catch {
            return { id: '', name: '' };
        }
    };

    // The playlist chosen in a save whose key switch is still waiting on the
    // uploader. One slot: a later save replaces it, and a status-driven switch
    // uses it instead of re-reading (the chosen playlist always wins).
    let pendingPlaylist: { id: string; name: string } | null = null;
    const takePending = (fallback: { id: string; name: string }) => {
        const pl = pendingPlaylist ?? fallback;
        pendingPlaylist = null;
        return pl;
    };

    // Push the stored upload settings to the uploader under the key it is on
    // (any other key starts a second manager on the same folder). Read when it
    // runs, so a pending push sends the newest save.
    const pushUploadConfig = async (playlist: { id: string; name: string }) => {
        const eventKey = YoutubeUploaderAddon.Instance.eventKey();
        if (!eventKey) return;
        const s = store.get('upload');
        const { currentEvent } = AutoAV.Instance.getStatus();
        try {
            await fetch(
                `http://127.0.0.1:8807/api/upload/config?event_key=${encodeURIComponent(
                    eventKey
                )}`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal: AbortSignal.timeout(5000),
                    body: JSON.stringify({
                        event_key: eventKey,
                        event_name: currentEvent?.name ?? '',
                        playlist_id: playlist.id,
                        playlist_name: playlist.name,
                        title_template: s.titleTemplate,
                        description_template: s.descriptionTemplate,
                        thumbnail_path: s.thumbnailPath,
                        visibility: s.visibility,
                        tba_auth_id: s.tbaAuthId,
                        tba_secret: s.tbaSecret,
                        toa_api_key: s.toaApiKey ?? '',
                        toa_event_key: s.toaEventKey ?? '',
                    }),
                }
            );
        } catch (e) {
            log.warn('Could not push upload config to uploader', e);
        }
    };

    // A started uploader, or one moved to a new folder or program, has only
    // its built-in templates and no credentials: send this app's settings,
    // keeping the playlist it has for the event. A switch that carries a
    // playlist (pendingPlaylist) pushes it itself.
    YoutubeUploaderAddon.Instance.events.on('target', async () => {
        if (pendingPlaylist) return;
        const playlist = await readUploaderPlaylist();
        if (pendingPlaylist) return;
        pushUploadConfig(playlist);
    });

    // The uploader and the custom audience display follow the program and
    // the season: both run only at FRC off-season events, the uploader when
    // match video upload is on in Settings, the custom display when Settings
    // picks it. When what an addon should be doing changes, it is started or
    // stopped. At boot the mode is the stored fallback until FMS or the
    // scorekeeper reports, so that change is what starts them.
    // The uploader value carries the program, the folder and the event key: a
    // change is a live switch (POST /api/control/event) on the running
    // uploader. A key alone changing (same folder) waits out a running upload.
    const wanted = () => ({
        uploader: AutoAV.Instance.runsUploader()
            ? `${AutoAV.Instance.getStatus().program}|${
                  AutoAV.Instance.getStatus().saveFolder ?? ''
              }|${AutoAV.Instance.uploadEventKey()}`
            : false,
        display: AutoAV.Instance.runsCustomAd(),
    });
    // running[key] is the value an addon was last started (or stopped) for.
    // It only moves once that start succeeded, so a failed start is tried
    // again on the next status change. applying[key] is the value a start or
    // stop is already working on, so repeated status events while it runs do
    // not queue the same change again.
    type Wanted = ReturnType<typeof wanted>;
    const running: Wanted = wanted();
    const applying: Partial<Wanted> = {};
    // A failed start waits a minute before the same start is tried again, so
    // an offline cart with no exe does not retry on every status event.
    const failed: Partial<
        Record<keyof Wanted, { target: unknown; at: number }>
    > = {};
    AutoAV.Instance.on('status', () => {
        const next = wanted();
        const apply = <K extends keyof Wanted>(
            key: K,
            addon: {
                start(): Promise<boolean>;
                stop(): Promise<boolean>;
                // Switch a running instance without a restart, if it can.
                retarget?(): Promise<boolean>;
            }
        ) => {
            const target = next[key];
            const current = key in applying ? applying[key] : running[key];
            if (target === current) return;
            const lastFail = failed[key];
            if (
                lastFail &&
                lastFail.target === target &&
                Date.now() - lastFail.at < 60000
            )
                return;
            applying[key] = target;
            // start() replaces a running instance, so a changed value
            // (e.g. FRC -> FTC uploader) is a restart. Starts and stops
            // run one at a time inside each addon.
            const settle = (ok: boolean) => {
                if (ok) {
                    running[key] = target;
                    delete failed[key];
                } else {
                    failed[key] = { target, at: Date.now() };
                }
                if (applying[key] === target) delete applying[key];
            };
            let change: Promise<boolean>;
            if (!target) change = addon.stop();
            else if (current && addon.retarget) change = addon.retarget();
            else change = addon.start();
            change
                .then((ok) => {
                    settle(ok);
                    return undefined;
                })
                .catch((e) => {
                    log.error('Addon season change failed', e);
                    settle(false);
                });
        };
        apply('uploader', {
            start: () => YoutubeUploaderAddon.Instance.start(),
            stop: () => YoutubeUploaderAddon.Instance.stop(),
            // A key-only change keeps the event's playlist: read it under the
            // old key, re-send it once the uploader is on the new one (the
            // uploader drops the stored playlist when the key changes).
            retarget: async () => {
                const playlist =
                    pendingPlaylist ?? (await readUploaderPlaylist());
                return YoutubeUploaderAddon.Instance.retargetForStatus(() => {
                    pushUploadConfig(takePending(playlist));
                });
            },
        });
        apply('display', AudienceDisplayAddon.Instance);
    });

    // The uploader starts an event's scan and upload loops on the first
    // request that names the event. Without this, uploads waited until someone
    // opened the Upload tab (its polling was the first request). Asking every
    // 15 s also covers an uploader restart and a new event.
    setInterval(() => {
        const eventKey = YoutubeUploaderAddon.Instance.eventKey();
        if (!eventKey || !YoutubeUploaderAddon.Instance.isRunning()) return;
        fetch(
            `http://127.0.0.1:8807/api/upload/state?event_key=${encodeURIComponent(
                eventKey
            )}`,
            { signal: AbortSignal.timeout(3000) }
        ).catch(() => undefined);
    }, 15000);

    // Global Settings (menu bar): FRC/FTC override, the FRC off-season
    // audience display and FRC off-season match video upload. The FTC
    // scorekeeper address lives on the ftc:* channels.
    const appSettings = () => ({
        program: store.get('program', 'auto'),
        frcAudienceDisplay: store.get('frcAudienceDisplay', 'fms'),
        matchVideoUpload: store.get('matchVideoUpload', false),
        companionPort: store.get('companionPort', 8888),
    });

    // The custom display presses Companion buttons through its own "Local"
    // sink. When the port changes here, point that sink at the new port too,
    // so one setting moves both. The display keeps the address it is given.
    const pointCustomAdAtCompanion = async (oldUrl: string) => {
        if (!AudienceDisplayAddon.Instance.isRunning()) return;
        try {
            const { config } = await readCustomAd(CUSTOM_AD_URL);
            const url = companionUrl();
            if (!config.sinks.some((k) => k.address === oldUrl)) return;
            await saveCustomAd(CUSTOM_AD_URL, {
                ...config,
                sinks: config.sinks.map((k) =>
                    k.address === oldUrl ? { ...k, address: url } : k
                ),
            });
        } catch (e) {
            log.warn('Custom AD Companion address not updated', e);
        }
    };

    ipcMain.on('app:getSettings', (event) => {
        event.reply('app:settings', appSettings());
    });

    ipcMain.on('app:saveSettings', (event, [s]) => {
        if (['auto', 'frc', 'ftc'].includes(s?.program)) {
            store.set('program', s.program);
        }
        if (['fms', 'customAd'].includes(s?.frcAudienceDisplay)) {
            store.set('frcAudienceDisplay', s.frcAudienceDisplay);
        }
        if (typeof s?.matchVideoUpload === 'boolean') {
            store.set('matchVideoUpload', s.matchVideoUpload);
        }
        const port = Number(s?.companionPort);
        if (
            Number.isInteger(port) &&
            port > 0 &&
            port < 65536 &&
            port !== store.get('companionPort', 8888)
        ) {
            const oldUrl = companionUrl();
            store.set('companionPort', port);
            pointCustomAdAtCompanion(oldUrl);
        }
        // Re-emits status, which starts or stops the custom display and the
        // uploader.
        AutoAV.Instance.applySettings();
        event.reply('app:settings', appSettings());
    });

    // The Offseason AD tab opens Settings when the custom display is off.
    // #region Stream and audio checks

    Checks.Instance.on('checks', (results) => {
        window?.webContents.send('checks:list', results);
    });
    // A check that starts failing (and is not ignored): a Windows
    // notification, since FIM-AV is often behind vMix. Clicking it brings
    // FIM-AV forward with the Checks dialog open.
    // Shown notifications are kept referenced until closed or clicked: on
    // Windows a garbage-collected Notification loses its click handler.
    const shownNotes = new Set<Notification>();
    Checks.Instance.on('alert', (r) => {
        if (!Notification.isSupported()) return;
        const n = new Notification({
            title: r.label,
            body: r.detail,
            urgency: r.state === 'critical' ? 'critical' : 'normal',
        });
        n.on('click', () => {
            shownNotes.delete(n);
            if (window?.isMinimized()) window.restore();
            window?.focus();
            window?.webContents.send('app:openChecks');
        });
        n.on('close', () => shownNotes.delete(n));
        shownNotes.add(n);
        n.show();
    });
    ipcMain.on('checks:get', (event) => {
        event.reply('checks:list', Checks.Instance.list());
    });
    ipcMain.on('checks:ignore', (_event, [id]) => {
        if (typeof id === 'string') Checks.Instance.ignore(id);
    });
    // `req` identifies the click, so two clicks on one fix (banner and
    // dialog) each get their own answer.
    ipcMain.on('checks:fix', async (event, [id, req]) => {
        try {
            await Checks.Instance.fix(id);
            event.reply('checks:fixed', { id, req, ok: true });
        } catch (e) {
            log.warn(`checks: fix ${id} failed`, e);
            event.reply('checks:fixed', {
                id,
                req,
                ok: false,
                message: (e as Error).message,
            });
        }
    });
    ipcMain.on('checks:unignore', (_event, [id]) => {
        if (typeof id === 'string') Checks.Instance.unignore(id);
    });
    Checks.Instance.start();

    // #endregion

    // #region vMix / X-Air tab: audio meters and level wizard

    LevelWizard.Instance.on('state', (st) => {
        window?.webContents.send('levels:state', st);
    });
    ipcMain.on('levels:watch', (_event, [on]) => {
        LevelWizard.Instance.watch(!!on);
    });
    ipcMain.on('levels:start', () => {
        LevelWizard.Instance.start().catch((e) =>
            window?.webContents.send('levels:error', (e as Error).message)
        );
    });
    ipcMain.on('levels:go', (_event, [step]) => {
        if (LEVEL_STEPS_ORDER.includes(step)) LevelWizard.Instance.go(step);
    });
    ipcMain.on('levels:fader', (_event, [db]) => {
        // A number, or null for the fader at the bottom (off).
        if (typeof db === 'number') LevelWizard.Instance.fader(db);
        else if (db === null) LevelWizard.Instance.fader(-Infinity);
    });
    ipcMain.on('levels:faderDone', () => {
        LevelWizard.Instance.faderDone();
    });
    ipcMain.on('levels:apply', () => {
        LevelWizard.Instance.apply();
    });
    ipcMain.on('levels:streamLevel', () => {
        LevelWizard.Instance.streamLevel();
    });
    ipcMain.on('levels:undo', () => {
        LevelWizard.Instance.undoLast();
    });
    // Cancel puts back everything the wizard changed; Done keeps it.
    ipcMain.on('levels:close', (_event, [restore]) => {
        LevelWizard.Instance.close(!!restore);
    });

    // #endregion

    ipcMain.on('app:requestOpenSettings', () => {
        window?.webContents.send('app:openSettings');
    });

    // #region Offseason AD tab (custom audience display)

    const audienceDisplayStatus = () => ({
        running: AudienceDisplayAddon.Instance.isRunning(),
        phase: AudienceDisplayAddon.Instance.getPhase(),
        version: AudienceDisplayAddon.Instance.getVersion(),
    });

    AudienceDisplayAddon.Instance.phase.on('phase', () =>
        window?.webContents.send(
            'audienceDisplay:status',
            audienceDisplayStatus()
        )
    );

    ipcMain.on('audienceDisplay:getStatus', (event) => {
        event.reply('audienceDisplay:status', audienceDisplayStatus());
    });

    ipcMain.on('audienceDisplay:restart', async (event) => {
        try {
            await AudienceDisplayAddon.Instance.stop();
            await AudienceDisplayAddon.Instance.start();
        } catch (e) {
            log.error('Audience display restart failed', e);
        }
        event.reply('audienceDisplay:status', audienceDisplayStatus());
    });

    ipcMain.on('audienceDisplay:stop', async (event) => {
        try {
            await AudienceDisplayAddon.Instance.stop();
        } catch (e) {
            log.error('Audience display stop failed', e);
        }
        event.reply('audienceDisplay:status', audienceDisplayStatus());
    });

    ipcMain.on('audienceDisplay:checkUpdate', async (event) => {
        event.reply(
            'audienceDisplay:updateInfo',
            await AudienceDisplayAddon.Instance.checkForUpdate()
        );
    });

    // Confirmed update: stop, start again (start() downloads the newest),
    // then reload the vMix FMS browser input so it serves the new build.
    ipcMain.on('audienceDisplay:update', async (event) => {
        try {
            await AudienceDisplayAddon.Instance.stop();
            await AudienceDisplayAddon.Instance.start();
            try {
                await VmixService.Instance.ReloadBrowserInput('FMS');
            } catch (e) {
                log.warn('Could not reload vMix FMS input', e);
            }
        } catch (e) {
            log.error('Audience display update failed', e);
        }
        event.reply('audienceDisplay:status', audienceDisplayStatus());
    });

    // #endregion Offseason AD tab

    ipcMain.on('upload:getStatus', (event) => {
        event.reply('upload:status', uploadStatus());
    });

    ipcMain.on('upload:restart', async (event) => {
        try {
            await YoutubeUploaderAddon.Instance.stop();
            await YoutubeUploaderAddon.Instance.start();
        } catch (e) {
            log.error('YouTube uploader restart failed', e);
        }
        event.reply('upload:status', uploadStatus());
    });

    ipcMain.on('upload:stopAddon', async (event) => {
        try {
            await YoutubeUploaderAddon.Instance.stop();
        } catch (e) {
            log.error('YouTube uploader stop failed', e);
        }
        event.reply('upload:status', uploadStatus());
    });

    // Upload settings: persisted in electron-store and pushed to the uploader as
    // its event config (POST /api/upload/config). The tba_secret only ever
    // leaves the main process to the uploader, which listens on 127.0.0.1
    // only (see YoutubeUploaderAddon.launch).
    //
    // The playlist is the exception: it belongs to one event, so it lives only
    // in the uploader's per-event config and is read back from there. A global
    // copy here would hand last week's playlist to this week's event on the
    // next Save. eventPlaylistName is the name the uploader gives the event's
    // own playlist (the + button's tooltip); it is not a stored setting.
    const uploadSettings = async () => {
        const settings = {
            ...store.get('upload'),
            playlistId: '',
            playlistName: '',
            eventPlaylistName: '',
            tbaEventKeyDefault: AutoAV.Instance.derivedTbaEventKey(),
        };
        const eventKey = YoutubeUploaderAddon.Instance.eventKey();
        if (!eventKey) return settings;
        try {
            const res = await fetch(
                `http://127.0.0.1:8807/api/upload/state?event_key=${encodeURIComponent(
                    eventKey
                )}`,
                { signal: AbortSignal.timeout(3000) }
            );
            const st = await res.json();
            settings.playlistId = st?.config?.playlist_id ?? '';
            settings.playlistName = st?.config?.playlist_name ?? '';
            settings.eventPlaylistName = st?.event_playlist_name ?? '';
        } catch (e) {
            log.warn('Could not read the event playlist from the uploader', e);
        }
        return settings;
    };

    ipcMain.on('upload:getSettings', async (event) => {
        event.reply('upload:settings', await uploadSettings());
    });

    ipcMain.on('upload:saveSettings', async (event, [settings]) => {
        // tbaEventKeyDefault is shown in the form, never stored.
        const stored = { ...(settings ?? {}) };
        delete stored.tbaEventKeyDefault;
        store.set('upload', {
            ...stored,
            tbaEventKey: String(stored.tbaEventKey ?? '')
                .trim()
                .toLowerCase(),
            playlistId: '',
            playlistName: '',
        });
        // The playlist is the one chosen in this save (it is not stored: see
        // uploadSettings).
        const playlist = {
            id: settings?.playlistId ?? '',
            name: settings?.playlistName ?? '',
        };
        // A key the uploader is not on yet (this save, or one still pending):
        // switch first, waiting out a running upload rather than killing it,
        // then store the config under the new key. A later save replaces a
        // pending one, and pushUploadConfig reads the settings when it runs,
        // so the newest save wins. Upload state lives in the event folder per
        // file, so nothing already uploaded goes up again.
        if (
            AutoAV.Instance.uploadEventKey() !==
            YoutubeUploaderAddon.Instance.eventKey()
        ) {
            pendingPlaylist = playlist;
            YoutubeUploaderAddon.Instance.retargetWhenIdle(() => {
                pushUploadConfig(takePending(playlist));
            });
        } else {
            pendingPlaylist = null;
            await pushUploadConfig(playlist);
        }
        event.reply('upload:settings', await uploadSettings());
    });

    // Native image picker for the thumbnail field (same pattern as the Auto AV
    // save-folder picker).
    ipcMain.on('upload:pickThumbnail', async (event) => {
        const win = BrowserWindow.getFocusedWindow() ?? window ?? undefined;
        const opts = {
            properties: ['openFile' as const],
            filters: [
                {
                    name: 'Images',
                    extensions: ['png', 'jpg', 'jpeg', 'webp'],
                },
            ],
        };
        const result = await (win
            ? dialog.showOpenDialog(win, opts)
            : dialog.showOpenDialog(opts));
        if (!result.canceled && result.filePaths[0]) {
            event.reply('upload:thumbnailPicked', result.filePaths[0]);
        }
    });

    // #endregion Upload tab

    // Auto AV settings dialog: naming + save folder (vMix connection now lives
    // in the vMix tab).
    const autoAvSettings = () => ({
        fileNameMode: store.get('autoAv.fileNameMode', 'in-season'),
        eventNameOverride: store.get('autoAv.eventNameOverride', ''),
        saveFolder: store.get('autoAv.saveFolder', ''),
        autoCut: store.get('autoAv.autoCut', false),
    });

    // A new event refilled the event name and reset the audience display:
    // refresh open settings dialogs so they don't save the old values back.
    AutoAV.Instance.on('eventChanged', () => {
        window?.webContents.send('autoav:settings', autoAvSettings());
        window?.webContents.send('app:settings', appSettings());
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

    // LAN status API (read-only), sharing the vMix tab's status builder
    startStatusApi({ vmixStatus: buildVmixStatus });
}
