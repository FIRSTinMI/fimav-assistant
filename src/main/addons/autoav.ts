import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import glob from 'glob';
import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import log from 'electron-log';
import {
    EquipmentLogCategory,
    EquipmentLogDetails,
    EquipmentLogType,
} from '../../models/EquipmentLog';
import FMSMatchStatus from '../../models/FMSMatchState';
import attemptRename, {
    FileNameMode,
    eventFolderName,
    sampleFileName,
} from '../../utils/recording';
import { AddonLoggers } from './addon-loggers';
import { getCurrentEvent, signalrToElectronLog } from '../util';
import VmixService from '../../services/VmixService';
import FmsApi from '../../services/FmsApi';
import Event from '../../models/Event';
import { AutoAVStatus } from '../../models/AutoAVStatus';
import { MatchRecord } from '../../models/MatchRecord';
import {
    upsertMatch,
    updateMatch,
    getMatch,
    listMatches,
} from '../recordings/matchStore';
import cutMatchVideo, { enqueueCut } from '../cutMatch';
import { getStore } from '../store';
import { invokeExpectResponse, invokeLog } from '../window_components/signalR';

// Events AutoAV emits to the renderer: a human status line, a structured
// status snapshot, a single match-record upsert, and the full match list for
// the current event folder.
export type AutoAVEvent = 'info' | 'status' | 'match' | 'matches';

export default class AutoAV {
    private static instance: AutoAV;

    // Match data from the last time the match started
    private lastMatchStartData: FMSMatchStatus | null = null;

    // Last match state received
    private lastState: FMSMatchStatus | null = null;

    // SignalR Hub Connection
    private hubConnection: HubConnection | null = null;

    // Loggers
    private logs: AddonLoggers | null = null;

    // Last file recorded
    private currentFile: string | null = null;

    // Current event name
    private currentEvent: Event | null = null;

    // Track whether or not we're recording (rather than someone in vMix clicking record)
    public weAreRecording = false;

    // Track if we're already scheduled to stop recording
    private willStopRecording = false;

    // Event Emitter
    private emitter: EventEmitter = new EventEmitter();

    // Structured status surfaced to the Auto AV tab
    private status: AutoAVStatus = {
        running: false,
        fmsConnected: false,
        vmix: { reachable: false, recording: false },
        recordingActive: false,
        currentEvent: null,
        saveFolder: null,
        fileNameMode: 'in-season',
        sampleFileName: '',
        lastMessage: null,
    };

    // Id of the MatchRecord for the in-progress recording, so we can patch it on stop
    private currentRecordId: string | null = null;

    // The in-progress record itself. It isn't persisted until the recording
    // stops (we don't know the destination folder for its manifest until then),
    // so we hold it here and write it once the file is filed.
    private currentRecordObj: MatchRecord | null = null;

    // Periodic vMix reachability poll
    private vmixPollTimer: ReturnType<typeof setInterval> | null = null;

    // vMix's configured recording folder, cached from the poll so emitStatus can
    // show the exact save path before the first recording.
    private vmixRecordFolder: string | null = null;

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('autoav.out'),
            err: log.scope('autoav.err'),
        };
    }

    /**
     * Stop recording
     * @returns void
     */
    private async stopRecording() {
        // Check if we're recording
        if (!(await VmixService.Instance.isRecording())) {
            this.logRecording(
                '🟥 Not Recording',
                undefined,
                EquipmentLogType.Debug
            );
            return;
        }

        VmixService.Instance.StopRecording()
            .then(async () => {
                this.logRecording('🟥 Stopped Recording');
                this.weAreRecording = false;
                this.willStopRecording = false;
                this.status.recordingActive = false;
                this.status.vmix.recording = false;
                this.emitStatus();

                // If we don't have a start time or data, don't try to rename
                if (!this.lastMatchStartData) return undefined;

                // Keep a local handle; the fields below get reset in finally
                const matchData = this.lastMatchStartData;
                const recordId = this.currentRecordId;

                // If we don't have an event name, try to get it
                if (!this.currentEvent) {
                    this.logRecording(
                        'ℹ Event not Present. Fetching current event...',
                        undefined,
                        EquipmentLogType.Warn
                    );
                    this.currentEvent = await this.fetchEvent();
                    this.emitStatus();
                }

                // Attempt to rename the file
                try {
                    const filename = await attemptRename(
                        this.currentEvent,
                        this.currentFile,
                        matchData
                    );

                    this.logRecording(`Renamed last recording to ${filename}`);

                    // Persist the finished record into the manifest that lives
                    // in the event folder the file was filed into.
                    if (recordId && this.currentRecordObj) {
                        const saveFolder = path.dirname(filename);
                        this.status.saveFolder = saveFolder;
                        const record: MatchRecord = {
                            ...this.currentRecordObj,
                            fileName: path.basename(filename),
                            filePath: filename,
                            saveFolder,
                            endedAt: Date.now(),
                            status: 'recorded',
                        };
                        upsertMatch(saveFolder, record);
                        this.emitter.emit('match', record);
                        this.emitStatus();

                        // Capture teams + cards first, so the card rule below can
                        // be honoured. Best-effort: a failed fetch never risks
                        // the file, and only means we can't confirm cards.
                        const hasCard = await this.captureMetadata(
                            saveFolder,
                            recordId,
                            matchData
                        );

                        // Auto-cut the dead time in place (original moved to
                        // Originals/), if enabled. Never cut a match with a card:
                        // the card explanation lives in the dead time we'd remove.
                        if (
                            getStore().get('autoAv.autoCut', false) &&
                            hasCard !== true
                        ) {
                            this.queueCut(saveFolder, recordId);
                        }
                    }
                } catch (err: any) {
                    this.logRecording(
                        `‼️ Error Renaming Recording`,
                        err,
                        EquipmentLogType.Error
                    );
                    // The file was never filed, so there's no folder/manifest to
                    // write to. Persist the error record if we have a folder,
                    // else just surface it live.
                    if (recordId && this.currentRecordObj) {
                        const errored: MatchRecord = {
                            ...this.currentRecordObj,
                            status: 'error',
                            error: String(err?.message ?? err),
                            endedAt: Date.now(),
                        };
                        if (this.status.saveFolder) {
                            upsertMatch(this.status.saveFolder, errored);
                        }
                        this.emitter.emit('match', errored);
                    }
                } finally {
                    this.lastMatchStartData = null;
                    this.currentRecordId = null;
                    this.currentRecordObj = null;
                }

                return undefined;
            })
            .catch((err) => {
                this.logRecording(
                    `‼️ Error Stopping Recording`,
                    err,
                    EquipmentLogType.Error
                );
            });
    }

    /**
     * Start Recording
     * @returns void
     */
    private startRecording(matchInfo: FMSMatchStatus) {
        VmixService.Instance.StartRecording()
            .then(() => {
                this.logRecording(
                    `🔴 Started Recording ${matchInfo.Level} Match #${matchInfo.MatchNumber}-${matchInfo.PlayNumber}`
                );
                this.lastMatchStartData = matchInfo;
                this.weAreRecording = true;

                // Create a record for this match so it shows in the Auto AV tab
                const startedAt = Date.now();
                const record: MatchRecord = {
                    id: `${matchInfo.Level}_${matchInfo.MatchNumber}_${matchInfo.PlayNumber}_${startedAt}`,
                    level: matchInfo.Level,
                    matchNumber: matchInfo.MatchNumber,
                    playNumber: matchInfo.PlayNumber,
                    eventName: this.currentEvent?.name ?? 'Unknown Event',
                    eventCode: this.currentEvent?.code ?? null,
                    fileName: null,
                    filePath: null,
                    saveFolder: null,
                    startedAt,
                    endedAt: null,
                    status: 'recording',
                };
                this.currentRecordId = record.id;
                this.currentRecordObj = record;
                // Not persisted yet: the destination folder (and thus which
                // manifest to write) isn't known until the file is filed on
                // stop. Emit it live so the tab shows it recording.
                this.emitter.emit('match', record);

                this.status.recordingActive = true;
                this.status.vmix.recording = true;
                this.emitStatus();

                // Give it some time, then attempt to find the file
                setTimeout(async () => {
                    this.currentFile =
                        await VmixService.Instance.GetCurrentRecording();
                }, 3000);

                return undefined;
            })
            .catch((err) => {
                this.logRecording(
                    `‼️ Error Starting Recording. Is Vmix at ${VmixService.Instance.getUrl()}?`,
                    err,
                    EquipmentLogType.Error
                );
            });
    }

    // Start AutoAV
    public start() {
        // Notify Parent logs that we're running
        this.log('AutoAV Service Started', undefined, true);

        this.status.running = true;
        this.emitStatus();

        // Begin polling vMix reachability for the status tab
        this.startVmixPoll();

        // Build a connection to the SignalR Hub
        this.hubConnection = new HubConnectionBuilder()
            .withUrl('http://10.0.100.5/infrastructureHub')
            .withServerTimeout(30000) // 30 seconds, per FMS Audience Display
            .withKeepAliveInterval(15000) // 15 seconds per FMS Audience Display
            .configureLogging({
                log: (logLevel, message) => {
                    signalrToElectronLog(
                        this.logs?.out ?? null,
                        logLevel,
                        message
                    );
                },
            })
            // .withHubProtocol(new MessagePackHubProtocol())
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds(retryContext) {
                    log.warn('Retrying SignalR connection...');
                    return Math.min(
                        2_000 * retryContext.previousRetryCount,
                        120_000
                    );
                },
            })
            .build();

        // Register listener for the "MatchStatusInfoChanged" event (match starts, ends, changes modes, etc)
        this.hubConnection.on(
            'MatchStatusInfoChanged',
            (info: FMSMatchStatus) => {
                // Log the change
                this.logFMS(
                    `Match Status Changed: ${
                        this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${
                        info.MatchNumber
                    } (Play #${info.PlayNumber})`,
                    info,
                    EquipmentLogType.Debug
                );

                // Update
                this.lastState = info;

                // Start recording when GameSpecificData is released (match starts)
                if (info.MatchState === 'GameSpecificData') {
                    this.startRecording(info);
                } else if (info.MatchState === 'MatchCancelled') {
                    // Estop!
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 10000); // Ok, but we wanna see the frantic running around for a bit
                } else if (
                    [
                        'Prestarting',
                        'PrestartingTO',
                        'WaitingForPrestart',
                        'WaitingForPrestartTO',
                    ].includes(info.MatchState) &&
                    !this.willStopRecording // Don't stop recording if we're already stopping
                ) {
                    // Probably skipped showing results.  Stop recording as results won't be shown
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 10000);
                }
            }
        );

        // Register listener for the "SystemConfigValueChanged" event (video switch))
        this.hubConnection.on('SystemConfigValueChanged', async (configKey) => {
            this.logFMS(
                `Got a config value change`,
                { key: configKey },
                EquipmentLogType.Debug
            );

            // VideoSwitchOption
            if (configKey === 'VideoSwitchOption') {
                this.logFMS(
                    'Video switch option changed, fetching update!',
                    undefined,
                    EquipmentLogType.Debug
                );
                const resp = await nodeFetch(
                    'http://10.0.100.5/api/v1.0/settings/get/get_VideoSwitchOption'
                );
                const switchOption = await resp.text();
                this.logFMS(
                    `Got Switch Option: ${switchOption}`,
                    undefined,
                    EquipmentLogType.Debug
                );
                // "MatchResult" (yes, double quotes are included in the response)
                if (switchOption === '"MatchResult"') {
                    this.logFMS(
                        '🚀 Scores Posted. Waiting 16 Seconds...',
                        undefined,
                        EquipmentLogType.Debug
                    );

                    // TODO: Make this time dynamic and configurable
                    this.willStopRecording = true;
                    setTimeout(() => this.stopRecording(), 16000); // As of 2024, the time to actually see the match details happens at about 11 seconds, so we'll wait 16 seconds to be safe
                }
            }
        });

        const bogusEvents = [
            'fieldnetworkstatus',
            'matchtimerchanged',
            'plc_io_status_changed',
            'plc_match_status_changed',
            'plc_connection_status_changed',
            'robotversiondatachanged',
            'azuresyncprogress',
            'azuresyncstatuschanged',
        ];

        // Dummies to get log to shush
        bogusEvents.forEach((e) => {
            this.hubConnection?.on(e, () => {});
        });

        // Register connected/disconnected events
        this.hubConnection.onreconnecting(() => {
            this.status.fmsConnected = false;
            this.emitStatus();
            this.logFMS(
                'AutoAV FMS Connection Lost, Reconnecting',
                undefined,
                EquipmentLogType.Warn,
                true
            );
        });
        this.hubConnection.onreconnected(() => {
            this.status.fmsConnected = true;
            this.emitStatus();
        });
        this.hubConnection.onclose(() => {
            this.status.fmsConnected = false;
            this.emitStatus();
            this.logFMS(
                'AutoAV FMS Connection Closed!',
                undefined,
                EquipmentLogType.Warn,
                true
            );
        });

        // Start connection to SignalR Hub
        this.hubConnection
            .start()
            .then(() => {
                this.status.fmsConnected = true;
                this.emitStatus();
                this.logFMS(
                    'FMS Connection Established!',
                    undefined,
                    undefined,
                    true
                );

                return undefined;
            })
            .catch((err) => {
                this.status.fmsConnected = false;
                this.emitStatus();
                this.logFMS(
                    `AutoAV FMS Connection Failed. Restarting...`,
                    err,
                    EquipmentLogType.Error,
                    true
                );

                setTimeout(() => {
                    // Restart AutoAV
                    this.stop();
                    this.start();
                }, 120_000);
            });
    }

    // Stop AutoAV
    public stop() {
        // Log stopping
        this.log('AutoAV Service Stopped');
        this.emitter.emit('info', 'Service Stopped');
        // Stop polling vMix
        this.stopVmixPoll();
        this.status.running = false;
        this.status.fmsConnected = false;
        this.status.vmix = { reachable: false, recording: false };
        this.emitStatus();
        // Stop the SignalR Hub connection
        this.hubConnection?.stop();
    }

    /**
     * Stop recording (for development)
     * Fill in random info and stop recording
     */
    public devStopRecording() {
        if (!this.lastMatchStartData) {
            this.lastMatchStartData = {
                MatchState: 'GameSpecificData',
                Level: 'Qualification',
                MatchNumber: 1,
                PlayNumber: 1,
            };
        } else {
            this.lastMatchStartData = {
                MatchState: 'GameSpecificData',
                Level: 'Qualification',
                MatchNumber: this.lastMatchStartData.MatchNumber + 1,
                PlayNumber: 1,
            };
        }
        this.stopRecording();
    }

    public devStartRecording() {
        this.startRecording({
            MatchState: 'GameSpecificData',
            Level: 'Qualification',
            MatchNumber: this.lastMatchStartData
                ? this.lastMatchStartData.MatchNumber + 1
                : 1,
            PlayNumber: 1,
        });
    }

    // Fetch the event name
    private async fetchEvent(): Promise<Event | null> {
        return invokeExpectResponse<Event[]>('GetEvents', 'Events')
            .then((events: Event[]) => {
                return getCurrentEvent(events);
            })
            .then((e) => {
                return e ?? null;
            })
            .catch((e) => {
                this.log(`‼️ Error Fetching Event Name`, {
                    severity: EquipmentLogType.Error,
                    extraInfo: e,
                    category: EquipmentLogCategory.General,
                });
                return null;
            });
    }

    private logRecording(
        msg: string,
        extraInfo?: object,
        severity: EquipmentLogType = EquipmentLogType.Info,
        notifyClient = true
    ) {
        this.log(
            msg,
            {
                severity,
                extraInfo,
                category: EquipmentLogCategory.AutoAV_Recording,
            },
            notifyClient
        );
    }

    private logFMS(
        msg: string,
        extraInfo?: object,
        severity: EquipmentLogType = EquipmentLogType.Info,
        notifyClient = false
    ) {
        this.log(
            msg,
            { severity, extraInfo, category: EquipmentLogCategory.AutoAV_FMS },
            notifyClient
        );
    }

    // Log a message
    private log(
        msg: string,
        opts: EquipmentLogDetails = {
            severity: EquipmentLogType.Info,
            category: EquipmentLogCategory.AutoAV_General,
        },
        notifyClient = false
    ) {
        if (this.logs) {
            // Local log to file
            const localLog =
                opts.severity === EquipmentLogType.Error ||
                opts.severity === EquipmentLogType.Fatal
                    ? this.logs.err
                    : this.logs.out;
            localLog.log(msg + (opts.extraInfo ? `\n\t${opts.extraInfo}` : ''));
        }

        // Log to frontend
        if (notifyClient) {
            this.status.lastMessage = msg;
            this.emitter.emit('info', msg);
            this.emitStatus();
        }

        // Don't send debug to logging server, too verbose
        if (opts.severity === EquipmentLogType.Debug) return;

        // Log to backend
        try {
            invokeLog(msg, {
                severity: opts.severity,
                category: opts.category ?? EquipmentLogCategory.AutoAV_General,
                extraInfo: opts.extraInfo,
            });
        } catch (e) {
            this.logs?.err.error(`Failed to log message to backend: ${msg}`, e);
        }
    }

    // Set the event name
    public setEvent(event: Event | null) {
        this.currentEvent = event;
        this.emitStatus();
    }

    // Apply settings changed from the Auto AV settings dialog: re-emit status
    // (picks up a new naming mode) and re-check vMix with the new connection.
    public applySettings(): void {
        this.emitStatus();
        // The save folder may have changed, so refresh the history to match.
        this.emitMatches();
        this.pollVmix();
    }

    // Effective file naming mode: official events are always in-season,
    // unofficial always off-season, otherwise fall back to the stored setting.
    private effectiveFileNameMode(): FileNameMode {
        if (this.currentEvent?.isOfficial === false) return 'off-season';
        if (this.currentEvent?.isOfficial === true) return 'in-season';
        return getStore().get('autoAv.fileNameMode', 'in-season');
    }

    // Build and broadcast the current status snapshot
    private emitStatus() {
        const store = getStore();
        const nameOverride = store.get('autoAv.eventNameOverride', '').trim();
        const saveFolderOverride = store.get('autoAv.saveFolder', '').trim();

        // The event actually used for naming: a typed override always wins.
        const effectiveEvent: Event | null = nameOverride
            ? ({
                  ...(this.currentEvent ?? {}),
                  name: nameOverride,
                  code: nameOverride,
              } as Event)
            : this.currentEvent;

        this.status.currentEvent = effectiveEvent
            ? {
                  name: effectiveEvent.name,
                  code: effectiveEvent.code ?? null,
              }
            : null;
        this.status.fileNameMode = this.effectiveFileNameMode();
        this.status.sampleFileName = sampleFileName(
            effectiveEvent,
            this.status.fileNameMode
        );

        // Effective destination folder = base folder + the event subfolder for
        // the CURRENT effective event name. The event subfolder is always
        // recomputed from the name (not frozen to the last recording), so
        // changing the event name updates the shown path immediately. The base
        // is: an explicit save-folder override, else the parent of the last real
        // save folder, else vMix's configured record folder.
        let base: string | null = null;
        if (saveFolderOverride) {
            base = saveFolderOverride;
        } else {
            const last = store.get('autoAv.lastSaveFolder', '').trim();
            if (last) base = path.dirname(last);
            else if (this.vmixRecordFolder) base = this.vmixRecordFolder;
        }
        this.status.saveFolder = base
            ? path.join(base, eventFolderName(effectiveEvent))
            : null;

        this.emitter.emit('status', this.getStatus());
    }

    // Current status snapshot (for IPC getState)
    public getStatus(): AutoAVStatus {
        return {
            ...this.status,
            vmix: { ...this.status.vmix },
            currentEvent: this.status.currentEvent
                ? { ...this.status.currentEvent }
                : null,
        };
    }

    // Poll vMix so the tab can show whether it's reachable / recording
    private startVmixPoll() {
        this.stopVmixPoll();
        this.vmixPollTimer = setInterval(() => this.pollVmix(), 5000);
        this.pollVmix();
    }

    private stopVmixPoll() {
        if (this.vmixPollTimer) {
            clearInterval(this.vmixPollTimer);
            this.vmixPollTimer = null;
        }
    }

    // Read vMix's configured recording folder from its .NET user.config (the
    // Web API only reports it while actively recording). Safe heuristic: a
    // setting whose NAME contains "record" whose value is an existing directory.
    // Returns null rather than a wrong guess.
    private static readVmixConfigRecordFolder(): string | null {
        try {
            const base = path.join(
                process.env.LOCALAPPDATA || '',
                'vMix'
            );
            const files = glob
                .sync(path.join(base, 'vMix*', '*', 'user.config'))
                .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
                .sort((a, b) => b.m - a.m);
            let found: string | null = null;
            files.forEach(({ f }) => {
                if (found !== null) return;
                const xml = fs.readFileSync(f, 'utf8');
                const re =
                    /<setting name="[^"]*record[^"]*"[^>]*>\s*<value>([A-Za-z]:\\[^<]+?)<\/value>/gi;
                const hit = [...xml.matchAll(re)]
                    .map((m) => m[1].trim())
                    .find((dir) => fs.existsSync(dir));
                if (hit) found = hit;
            });
            return found;
        } catch {
            // best effort
        }
        return null;
    }

    private async pollVmix() {
        let reachable = false;
        let recording = false;
        let recordFolder: string | null = this.vmixRecordFolder;
        try {
            const parsed = await VmixService.Instance.GetBase();
            reachable = !!parsed?.vmix;
            recording = parsed?.vmix?.recording?.['#text'] === 'True';
            // vMix reports the record destination as recording.filename1, but
            // only while actively recording. When idle, fall back to reading its
            // config file.
            const file =
                parsed?.vmix?.recording?.filename1 ??
                parsed?.vmix?.recording?.filename;
            if (typeof file === 'string' && file.trim()) {
                const i = Math.max(
                    file.lastIndexOf('\\'),
                    file.lastIndexOf('/')
                );
                recordFolder = i > 0 ? file.slice(0, i) : file;
            } else if (!recordFolder) {
                recordFolder = AutoAV.readVmixConfigRecordFolder();
            }
        } catch {
            reachable = false;
            recording = false;
        }
        const folderChanged = recordFolder !== this.vmixRecordFolder;
        if (folderChanged) this.vmixRecordFolder = recordFolder;
        if (
            this.status.vmix.reachable !== reachable ||
            this.status.vmix.recording !== recording ||
            folderChanged
        ) {
            this.status.vmix = { reachable, recording };
            this.emitStatus();
            // A changed record folder means a different event: refresh history.
            if (folderChanged) this.emitMatches();
        }
    }

    // Best-effort fetch of teams + card status for a finished match, patched
    // onto the record after it's been renamed. Never throws into the stop path.
    // Returns the card status: true (carded), false (clean), or undefined when
    // it couldn't be determined, so the caller can honour the no-cut card rule.
    private async captureMetadata(
        folder: string,
        recordId: string,
        matchData: FMSMatchStatus
    ): Promise<boolean | undefined> {
        try {
            const results = await FmsApi.Instance.getMatchResults(
                matchData.Level,
                matchData.MatchNumber
            );
            if (!results) return undefined;
            const record = updateMatch(folder, recordId, {
                teams: results.teams,
                hasCard: results.hasCard,
            });
            if (record) {
                this.emitter.emit('match', record);
                this.logRecording(
                    `Captured metadata for ${matchData.Level} Match ${
                        matchData.MatchNumber
                    }${results.hasCard ? ' (card issued)' : ''}`,
                    undefined,
                    EquipmentLogType.Debug
                );
            }
            return results.hasCard;
        } catch (err) {
            this.logRecording(
                'Failed to capture match metadata',
                err as object,
                EquipmentLogType.Warn
            );
            return undefined;
        }
    }

    // Cut the dead time out of a recorded match in place: the original video is
    // moved into an "Originals" subfolder and the trimmed, upload-ready cut takes
    // its spot in the base event folder (so the base folder holds every match's
    // final video, cut and uncut alike). Queued so a burst of matches encodes one
    // at a time and never starves vMix/streaming of CPU. Best-effort: a failure
    // restores the original and only marks the record. Refuses carded matches so
    // their explanation (which lives in the dead time) is preserved. Used by both
    // the auto-cut path and the manual Cut button.
    public queueCut(folder: string, recordId: string): void {
        const rec = getMatch(folder, recordId);
        if (!rec || !rec.filePath) return;
        if (rec.hasCard) {
            this.logRecording(
                `Not cutting ${rec.fileName} (card issued, keeping explanation)`,
                undefined,
                EquipmentLogType.Debug
            );
            return;
        }
        const state = rec.processing?.state;
        if (state === 'queued' || state === 'processing') return;

        const mainPath = rec.filePath;
        const originalsDir = path.join(folder, 'Originals');
        const originalPath = path.join(originalsDir, path.basename(mainPath));

        const queued = updateMatch(folder, recordId, {
            processing: { state: 'queued' },
        });
        if (queued) this.emitter.emit('match', queued);

        enqueueCut(async () => {
            try {
                if (!fs.existsSync(originalsDir)) {
                    fs.mkdirSync(originalsDir, { recursive: true });
                }
                const started = updateMatch(folder, recordId, {
                    processing: { state: 'processing' },
                });
                if (started) this.emitter.emit('match', started);
                this.logRecording(`Cutting ${path.basename(mainPath)}`);

                // Move the original aside (don't clobber an existing Originals
                // copy from a prior attempt), then cut it back into the base spot.
                if (fs.existsSync(mainPath) && !fs.existsSync(originalPath)) {
                    fs.renameSync(mainPath, originalPath);
                }
                const source = fs.existsSync(originalPath)
                    ? originalPath
                    : mainPath;
                await cutMatchVideo(source, mainPath);

                const done = updateMatch(folder, recordId, {
                    processing: { state: 'done', outputPath: mainPath },
                });
                if (done) this.emitter.emit('match', done);
                this.logRecording(
                    `Cut ${path.basename(mainPath)}; original kept in Originals`,
                    undefined,
                    EquipmentLogType.Debug
                );
            } catch (err: any) {
                // Restore the original to the base folder if the cut left it
                // missing, so we never lose the recording.
                try {
                    if (
                        !fs.existsSync(mainPath) &&
                        fs.existsSync(originalPath)
                    ) {
                        fs.renameSync(originalPath, mainPath);
                    }
                } catch {
                    // best effort
                }
                const failed = updateMatch(folder, recordId, {
                    processing: {
                        state: 'error',
                        error: String(err?.message ?? err),
                    },
                });
                if (failed) this.emitter.emit('match', failed);
                this.logRecording(
                    'Failed to cut recording',
                    err as object,
                    EquipmentLogType.Warn
                );
            }
        });
    }

    // Emit the recorded-match list for the folder the app is currently pointed
    // at, so the tab's history reflects the current event folder.
    public emitMatches(): void {
        this.emitter.emit('matches', listMatches(this.status.saveFolder));
    }

    public static get Instance(): AutoAV {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }

    // eslint-disable-next-line no-unused-vars
    public on(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.on(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public off(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.off(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public once(event: AutoAVEvent, listener: (arg: any) => void) {
        this.emitter.once(event, listener);
    }
}
