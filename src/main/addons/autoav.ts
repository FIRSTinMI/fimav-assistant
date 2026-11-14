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
import FMSMatchStatus, { TournamentLevel } from '../../models/FMSMatchState';
import FtcScorekeeper from './ftc-scorekeeper';
import FtcRecorder from '../ftc/recorder';
import { FtcScorekeeperStatus, FtcUpdate } from '../../models/Ftc';
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
import { AutoAVStatus, Program } from '../../models/AutoAVStatus';
import { MatchRecord } from '../../models/MatchRecord';
import {
    upsertMatch,
    updateMatch,
    getMatch,
    listMatches,
} from '../recordings/matchStore';
import cutMatchVideo, { enqueueCut } from '../cutMatch';
import { queueLoudness } from '../checks/loudness';
import { getStore } from '../store';
import { invokeExpectResponse, invokeLog } from '../window_components/signalR';

// Events AutoAV emits to the renderer: a human status line, a structured
// status snapshot, a single match-record upsert, and the full match list for
// the current event folder, plus eventChanged when the field system (FMS or
// the FTC scorekeeper) moves to a different event (see noteEvent).
export type AutoAVEvent =
    | 'info'
    | 'status'
    | 'match'
    | 'matches'
    | 'eventChanged'
    // FMS / FTC Live match state changed: the checks re-run at once, so the
    // match start sound is sampled from the start, not up to 5 s late.
    | 'play';

const stateOf = (r: MatchRecord) => r.processing?.state;

export default class AutoAV {
    private static instance: AutoAV;

    // Match data from the last time the match started
    private lastMatchStartData: FMSMatchStatus | null = null;

    // Last match state received
    private lastState: FMSMatchStatus | null = null;

    // The loaded match as FMS's GetCurrentMatchAndPlayNumber names it, and the
    // match+play a fetch is in flight for. See withLoadedLevel.
    private loadedMatch: {
        number: number;
        play: number;
        level: TournamentLevel;
    } | null = null;

    private loadedMatchFetch: string | null = null;

    // SignalR Hub Connection
    private hubConnection: HubConnection | null = null;

    // Loggers
    private logs: AddonLoggers | null = null;

    // Last file recorded
    private currentFile: string | null = null;

    // Current event name
    private currentEvent: Event | null = null;

    // The FTC scorekeeper's event. Kept apart from currentEvent (fim-admin)
    // so it only names and sets the season of recordings in FTC mode.
    private ftcEvent: Event | null = null;

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
        fileNameModeForced: false,
        season: 'in-season',
        uploader: false,
        ftcConnected: false,
        program: 'frc',
        programDetected: null,
        frcAudienceDisplay: 'fms',
        audienceDisplay: 'fms',
        sampleFileName: '',
        lastMessage: null,
    };

    // Id of the MatchRecord for the in-progress recording, so we can patch it on stop
    private currentRecordId: string | null = null;

    // The in-progress record itself. It isn't persisted until the recording
    // stops (we don't know the destination folder for its manifest until then),
    // so we hold it here and write it once the file is filed.
    private currentRecordObj: MatchRecord | null = null;

    // Cuts this process has queued or is running, by folder|record id.
    private cutJobs = new Set<string>();

    // Matches being filed right now (written "queued", cut not asked for yet),
    // by folder|record id. Recovery leaves them alone.
    private filing = new Set<string>();

    // Recovery runs once per folder this process points at (and again on start).
    private recovering = false;

    // Failed recoveries per cut job key; see recoverInterruptedCuts.
    private recoveryFailures = new Map<string, number>();

    private static RECOVERY_TRIES = 5;

    private static RECOVERY_RETRY_MS = 30_000;

    // Periodic vMix reachability poll
    private vmixPollTimer: ReturnType<typeof setInterval> | null = null;

    private fmsEventTimer: ReturnType<typeof setInterval> | null = null;

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

                // Local handles to this match's state, taken before any await:
                // the file can take up to a minute to finish, and the next
                // match may start (and set these fields) meanwhile.
                const matchData = this.lastMatchStartData;
                const recordId = this.currentRecordId;
                const recordObj = this.currentRecordObj;
                const file = this.currentFile;

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

                // Set once the match is written to its folder's manifest: an
                // error after that must not overwrite the good record.
                let filed = false;

                // Attempt to rename the file
                try {
                    const filename = await attemptRename(
                        this.currentEvent,
                        file,
                        matchData
                    );

                    this.logRecording(
                        `Renamed last recording to ${path.basename(filename)}`
                    );

                    // Persist the finished record into the manifest that lives
                    // in the event folder the file was filed into.
                    if (recordId && recordObj) {
                        const saveFolder = path.dirname(filename);
                        this.status.saveFolder = saveFolder;
                        // With auto-cut on, the file is not final yet: say so
                        // in the record before anyone hears about it, so the
                        // uploader holds it ("cut queued") and nobody announces
                        // it as ready. Uploading the raw file while the cut
                        // moves it away broke every first upload attempt.
                        const mayCut =
                            this.isFrcOffSeason() &&
                            getStore().get('autoAv.autoCut', false);
                        const record: MatchRecord = {
                            ...recordObj,
                            fileName: path.basename(filename),
                            filePath: filename,
                            saveFolder,
                            endedAt: Date.now(),
                            status: 'recorded',
                            ...(mayCut
                                ? { processing: { state: 'queued' as const } }
                                : {}),
                        };
                        // From here until its cut is queued (or it is released)
                        // this match is ours: recovery must not take it, even
                        // though the record says "queued" and no cut job holds
                        // it yet (the metadata fetch below can take seconds).
                        const fileKey = AutoAV.cutJobKey(saveFolder, recordId);
                        if (mayCut) this.filing.add(fileKey);
                        try {
                            upsertMatch(saveFolder, record);
                            filed = true;
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
                            if (mayCut && hasCard !== true) {
                                // Loudness is measured once the cut is made.
                                this.queueCut(saveFolder, recordId, {
                                    claimed: true,
                                });
                            } else {
                                if (mayCut) {
                                    // A carded match is never cut: the raw file is
                                    // final after all, so release it.
                                    const released = updateMatch(
                                        saveFolder,
                                        recordId,
                                        {
                                            processing: {
                                                state: 'unprocessed',
                                            },
                                        }
                                    );
                                    if (released)
                                        this.emitter.emit('match', released);
                                }
                                // The whole recording, from when vMix
                                // started it.
                                queueLoudness(
                                    saveFolder,
                                    recordId,
                                    filename,
                                    [
                                        {
                                            wallStart: record.startedAt,
                                            seconds: Infinity,
                                        },
                                    ],
                                    (r) => this.emitter.emit('match', r)
                                );
                            }
                        } finally {
                            this.filing.delete(fileKey);
                            // Held as queued but no cut followed (an error on
                            // the way): release the raw video rather than leave
                            // the uploader holding it until a restart.
                            const releaseIfStuck = () => {
                                const left = getMatch(saveFolder, recordId);
                                if (
                                    left?.processing?.state === 'queued' &&
                                    !this.cutJobs.has(fileKey) &&
                                    !this.filing.has(fileKey)
                                ) {
                                    const released = updateMatch(
                                        saveFolder,
                                        recordId,
                                        {
                                            processing: {
                                                state: 'error',
                                                error: 'cut not started',
                                            },
                                        }
                                    );
                                    if (released)
                                        this.emitter.emit('match', released);
                                }
                                return left;
                            };
                            // An unreadable manifest (locked for a moment by
                            // antivirus) reads as no record: look again shortly.
                            if (mayCut && !releaseIfStuck()) {
                                setTimeout(releaseIfStuck, 2000);
                            }
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
                    // else just surface it live. Once filed, the record in the
                    // manifest is right (the error came later, e.g. a listener
                    // at quit): replacing it with this one, which has no file
                    // path, would stop the match from ever uploading.
                    if (recordId && recordObj && !filed) {
                        const errored: MatchRecord = {
                            ...recordObj,
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
                    // Only if no newer match has taken these over.
                    if (this.currentRecordId === recordId) {
                        this.lastMatchStartData = null;
                        this.currentRecordId = null;
                        this.currentRecordObj = null;
                    }
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

    // #region FTC

    private ftcListening = false;

    // FTC recording: match plus score reveal, cut from vMix raw files.
    private ftcRecorder = new FtcRecorder({
        event: () => this.event(),
        folder: () => this.status.saveFolder,
        log: (m) => this.logRecording(m),
        setRecording: (on) => {
            // weAreRecording also tells the auto-updater not to restart now.
            this.weAreRecording = on;
            this.status.recordingActive = on;
            this.status.vmix.recording = on;
            this.emitStatus();
        },
        record: (rec) => this.emitter.emit('match', rec),
    });

    // FMS's MatchStatusInfoChanged carries the event's active tournament level,
    // not the loaded match's: during quals a test match (always number 999)
    // arrives as Qualification 999. Goonettes and DCC 2026-10-10 recorded test
    // matches as "Qualification Match 999" and uploaded them as quals.
    // GetCurrentMatchAndPlayNumber names the loaded match (level "None" for a
    // test match). Its answer is cached per match+play and applied to every
    // status for that match; the status's own level is the fallback until the
    // answer arrives or when FMS does not give one. Prestart comes well before
    // MatchAuto, so the level is corrected before a recording starts.
    private withLoadedLevel(info: FMSMatchStatus): FMSMatchStatus {
        if (this.isFtc()) return info;
        const lm = this.loadedMatch;
        if (
            lm &&
            lm.number === info.MatchNumber &&
            lm.play === info.PlayNumber
        ) {
            return lm.level === info.Level
                ? info
                : { ...info, Level: lm.level };
        }
        this.refreshLoadedMatch(info.MatchNumber, info.PlayNumber);
        return info;
    }

    private refreshLoadedMatch(num: number, play: number) {
        const key = `${num}-${play}`;
        if (this.loadedMatchFetch === key) return;
        this.loadedMatchFetch = key;
        this.fetchLoadedMatch(num, play, key).catch((e) => {
            this.logFMS(
                'GetCurrentMatchAndPlayNumber failed; using the status level',
                e,
                EquipmentLogType.Debug
            );
        });
    }

    private async fetchLoadedMatch(
        num: number,
        play: number,
        key: string
    ): Promise<void> {
        try {
            await this.applyLoadedMatch(num, play);
        } finally {
            if (this.loadedMatchFetch === key) this.loadedMatchFetch = null;
        }
    }

    private async applyLoadedMatch(num: number, play: number): Promise<void> {
        const r = await nodeFetch(
            'http://10.0.100.5/api/v1.0/audience/get/GetCurrentMatchAndPlayNumber'
        );
        if (r.status !== 200) return;
        const d = await r.json();
        if (!d || typeof d.item1 !== 'string') return;
        // FMS has moved on to another match: the next status asks again.
        if (d.item2 !== num || d.item3 !== play) return;
        const level = d.item1 as TournamentLevel;
        this.loadedMatch = { number: num, play, level };
        const st = this.lastState;
        if (
            st &&
            st.MatchNumber === num &&
            st.PlayNumber === play &&
            st.Level !== level
        ) {
            this.lastState = { ...st, Level: level };
            this.emitter.emit('play');
        }
    }

    // A qualification or playoff match being played right now, FRC or FTC,
    // for the stream checks; null between matches and for practice/test.
    // `anyLevel` also counts practice and test matches (the level wizard
    // listens to the match sounds of whatever match is run).
    public matchInPlay(
        anyLevel = false
    ): { label: string; level: string } | null {
        const counted = (level: string) =>
            anyLevel || ['Qualification', 'Playoff'].includes(level);
        if (this.isFtc()) {
            const m = this.ftcRecorder.inPlay();
            if (!m || !counted(m.level)) return null;
            return { label: m.shortName, level: m.level };
        }
        const st = this.lastState;
        if (
            !st ||
            !counted(st.Level) ||
            ![
                'GameSpecificData',
                'MatchAuto',
                'MatchTransition',
                'MatchTeleop',
            ].includes(st.MatchState)
        )
            return null;
        if (!['Qualification', 'Playoff'].includes(st.Level))
            return { label: `${st.Level} ${st.MatchNumber}`, level: st.Level };
        const prefix = st.Level === 'Qualification' ? 'Q' : 'P';
        return { label: `${prefix}${st.MatchNumber}`, level: st.Level };
    }

    public ftcRecorderSummary() {
        return this.ftcRecorder.summary();
    }

    private onFtcUpdate(u: FtcUpdate) {
        if (!this.isFtc()) return;
        this.ftcRecorder.onUpdate(u);
        this.emitter.emit('play');
    }

    // A new FTC event fills in the event name like a new FMS event does, and
    // is the event in FTC mode unless fim-admin names a different one.
    private onFtcStatus(s: FtcScorekeeperStatus) {
        // Connecting or dropping can change the detected program.
        if (!s.eventCode) {
            this.emitStatus();
            return;
        }
        this.ftcEvent = {
            code: s.eventCode,
            name: s.eventName || s.eventCode,
            // Off-season events report "Non-Advancement" (FTC Live 8.0);
            // scrimmages and off-season types are not official either.
            isOfficial: !/NON-?ADVANCEMENT|OFF|SCRIM/i.test(s.eventType ?? ''),
        } as Event;
        // Program detection first: the scorekeeper's event only counts as a
        // new event in FTC mode (see checkFmsEvent).
        this.emitStatus();
        if (this.isFtc()) {
            this.noteEvent('ftc', s.eventCode, s.eventName || s.eventCode);
            // Finish matches left from before a restart.
            this.ftcRecorder.resume();
        }
        this.emitStatus();
        this.emitMatches();
    }

    // #endregion

    // Start AutoAV
    public start() {
        if (!this.ftcListening) {
            this.ftcListening = true;
            FtcScorekeeper.Instance.on('update', (u: FtcUpdate) =>
                this.onFtcUpdate(u)
            );
            FtcScorekeeper.Instance.on('status', (s: FtcScorekeeperStatus) =>
                this.onFtcStatus(s)
            );
        }

        // Notify Parent logs that we're running
        this.log('AutoAV Service Started', undefined, true);

        this.status.running = true;
        this.emitStatus();

        // A cut that was running when the app last closed never finished.
        this.recoverInterruptedCuts(this.status.saveFolder);

        // Begin polling vMix reachability for the status tab
        this.startVmixPoll();

        // Follow the event FMS is set up for
        this.startFmsEventPoll();

        // There is no FMS at an FTC event. FtcScorekeeper is a singleton that
        // may already be connected with a known event by the time we get
        // here (e.g. this is a restart) - in that case don't even try the
        // FMS hub, rather than try-fail-retry on a connection that will never
        // succeed. On a cold start before FTC is known yet, this is false
        // and the hub is still tried once, same as before.
        //
        // Gated on isFtc() (status.program, same source the catch handler
        // below and every other FRC/FTC branch in this file already use) -
        // NOT FtcScorekeeper's raw eventCode, which is set once on first
        // discovery and never cleared back to null (see ftc-scorekeeper.ts),
        // so it would stay truthy for the rest of the process even if this
        // cart is later pointed at a real FRC event. isFtc() tracks the
        // live/current program (and respects a manual Settings override),
        // so this gate clears correctly when the program actually changes.
        if (this.isFtc()) {
            this.status.fmsConnected = false;
            this.emitStatus();
            return;
        }

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
            (raw: FMSMatchStatus) => {
                const info = this.withLoadedLevel(raw);
                // Log the change
                this.logFMS(
                    `Match Status Changed: ${
                        this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${
                        info.MatchNumber
                    } (Play #${info.PlayNumber})${
                        raw.Level !== info.Level
                            ? ` (FMS said ${raw.Level})`
                            : ''
                    }`,
                    raw,
                    EquipmentLogType.Debug
                );

                // Update
                this.lastState = info;
                this.emitter.emit('play');

                // At FTC events FTC Live drives recording, even when an FMS
                // is also on the network.
                if (this.isFtc()) return;

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
            if (configKey === 'VideoSwitchOption' && !this.isFtc()) {
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
            this.checkFmsEvent();
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
                this.checkFmsEvent();
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

                // Same reasoning as the pre-connect check above: once FTC is
                // confirmed, stop treating "no FMS" as an error and stop
                // retrying forever - it will never succeed.
                if (this.isFtc()) {
                    this.logFMS(
                        'No FMS at this FTC event (expected)',
                        undefined,
                        EquipmentLogType.Debug,
                        false
                    );
                    return;
                }

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
        this.stopFmsEventPoll();
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

    // TBA key from FMS: season year + FMS event code (2026 + MIDET =
    // 2026midet), or '' before FMS has reported an event.
    // eslint-disable-next-line class-methods-use-this
    public derivedTbaEventKey(): string {
        const m = /^frc:(.+)$/.exec(getStore().get('autoAv.lastEventKey', ''));
        return m ? `${new Date().getFullYear()}${m[1].toLowerCase()}` : '';
    }

    // The event key the YouTube uploader files videos under and submits to
    // TBA with. FTC keeps the event code it always used. FRC: the Upload
    // tab's TBA event key when set, else year + FMS code. Never the display
    // event's code: on every new FMS event the name override is written into
    // that code too, so it carries "Detroit City Championship", which TBA
    // rejects as an unknown event.
    public uploadEventKey(): string {
        if (this.isFtc()) return this.status.currentEvent?.code ?? '';
        const typed = String(getStore().get('upload.tbaEventKey', '') ?? '')
            .trim()
            .toLowerCase();
        return typed || this.derivedTbaEventKey();
    }

    // Set the event name
    public setEvent(event: Event | null) {
        this.currentEvent = event;
        this.emitStatus();
    }

    // The event recordings are named and seasoned by: fim-admin's, except in
    // FTC mode, where the scorekeeper's event stands in when fim-admin has
    // none or names the same event.
    private event(): Event | null {
        if (!this.isFtc() || !this.ftcEvent) return this.currentEvent;
        if (this.currentEvent && this.currentEvent.code !== this.ftcEvent.code)
            return this.currentEvent;
        return { ...(this.currentEvent ?? {}), ...this.ftcEvent } as Event;
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
        const event = this.event();
        if (event?.isOfficial === false) return 'off-season';
        if (event?.isOfficial === true) return 'in-season';
        return getStore().get('autoAv.fileNameMode', 'in-season');
    }

    public isFtc(): boolean {
        return this.status.program === 'ftc';
    }

    // FRC off-season features: the custom audience display and dead-time
    // cutting (its keep-first-166-s rule is FRC match timing).
    public isFrcOffSeason(): boolean {
        return !this.isFtc() && this.isOffSeason();
    }

    // The custom audience display runs at FRC off-season events when it is
    // the chosen display in Settings.
    public runsCustomAd(): boolean {
        return (
            this.isFrcOffSeason() &&
            getStore().get('frcAudienceDisplay', 'fms') === 'customAd'
        );
    }

    // The YouTube uploader runs at off-season events only, FRC or FTC. Never
    // at in-season events.
    public runsUploader(): boolean {
        return this.isOffSeason();
    }

    // Off-season turns on the off-season-only features: the YouTube uploader
    // and Upload tab, the custom audience display and
    // dead-time cutting.
    // Detected, never set: an unofficial event is off-season, an official one
    // in-season. With no event, January to April is in-season and the rest of
    // the year off-season. File naming is separate and does not decide it.
    public isOffSeason(): boolean {
        const official = this.event()?.isOfficial;
        if (typeof official === 'boolean') return !official;
        return new Date().getMonth() > 3;
    }

    // Build and broadcast the current status snapshot
    private emitStatus() {
        const store = getStore();
        const nameOverride = store.get('autoAv.eventNameOverride', '').trim();
        const saveFolderOverride = store.get('autoAv.saveFolder', '').trim();

        // FRC or FTC. Detection: the scorekeeper answering and FMS not = FTC;
        // FMS answering = FRC; neither = keep what it was. Settings override.
        const ftcConnected = FtcScorekeeper.Instance.getStatus().connected;
        this.status.ftcConnected = ftcConnected;
        let detected: Program | null = null;
        if (ftcConnected && !this.status.fmsConnected) detected = 'ftc';
        else if (this.status.fmsConnected) detected = 'frc';
        this.status.programDetected = detected;
        const override = store.get('program', 'auto');
        this.status.program =
            override === 'frc' || override === 'ftc'
                ? override
                : detected ?? this.status.program;
        // The event actually used for naming: a typed override always wins.
        const effectiveEvent: Event | null = nameOverride
            ? ({
                  ...(this.event() ?? {}),
                  name: nameOverride,
                  code: nameOverride,
              } as Event)
            : this.event();

        this.status.currentEvent = effectiveEvent
            ? {
                  name: effectiveEvent.name,
                  code: effectiveEvent.code ?? null,
              }
            : null;
        this.status.fileNameMode = this.effectiveFileNameMode();
        this.status.season = this.isOffSeason() ? 'off-season' : 'in-season';
        this.status.uploader = this.runsUploader();
        this.status.frcAudienceDisplay =
            store.get('frcAudienceDisplay', 'fms') === 'customAd'
                ? 'customAd'
                : 'fms';
        if (this.isFtc()) this.status.audienceDisplay = 'ftcLive';
        else if (this.runsCustomAd()) this.status.audienceDisplay = 'customAd';
        else this.status.audienceDisplay = 'fms';
        this.status.fileNameModeForced =
            typeof this.event()?.isOfficial === 'boolean';
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
        const folderBefore = this.status.saveFolder;
        this.status.saveFolder = base
            ? path.join(base, eventFolderName(effectiveEvent))
            : null;
        // A new event folder may hold cuts a previous run never finished.
        if (this.status.running && this.status.saveFolder !== folderBefore) {
            this.recoverInterruptedCuts(this.status.saveFolder);
        }

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

    // Poll FMS for its event so a new event renames recordings without anyone
    // touching the settings dialog.
    private startFmsEventPoll() {
        this.stopFmsEventPoll();
        this.fmsEventTimer = setInterval(() => this.checkFmsEvent(), 30000);
        this.checkFmsEvent();
    }

    private stopFmsEventPoll() {
        if (this.fmsEventTimer) {
            clearInterval(this.fmsEventTimer);
            this.fmsEventTimer = null;
        }
    }

    // When FMS reports a different event code than the one the name was last
    // filled from, replace the event name with FMS's. Same code = leave the
    // name alone, so a volunteer's hand edit survives until the next event.
    private async checkFmsEvent() {
        const info = await FmsApi.Instance.getEventInfo();
        // With FMS and the FTC scorekeeper both up, each reports its own
        // event; only the active program's counts, or the two would take
        // turns being "new".
        if (!info || this.isFtc()) return;
        this.noteEvent('frc', info.eventCode, info.eventName || info.eventCode);
    }

    // The one place a new event is detected. Both field systems report their
    // event here (FMS through checkFmsEvent, the FTC scorekeeper through
    // onFtcStatus). A different program:code than last time is a new event:
    // the event name is refilled from the field system, per-event choices go
    // back to their defaults (the FRC audience display to the official FMS
    // display), and eventChanged tells everything else. The same event again
    // changes nothing, so a volunteer's hand edits survive until the next one.
    private noteEvent(program: Program, code: string, name: string) {
        const store = getStore();
        const key = `${program}:${code}`;
        if (key === store.get('autoAv.lastEventKey', '')) return;
        const previous = store.get('autoAv.lastEventKey', '');
        store.set('autoAv.lastEventKey', key);
        store.set('autoAv.eventNameOverride', name);
        store.set('frcAudienceDisplay', 'fms');
        this.log(`Event is now ${key} (was ${previous || 'none'}): "${name}"`);
        this.emitStatus();
        this.emitMatches();
        this.emitter.emit('eventChanged', { program, code, name });
    }

    // Read vMix's configured recording folder from its .NET user.config (the
    // Web API only reports it while actively recording). Safe heuristic: a
    // setting whose NAME contains "record" whose value is an existing directory.
    // Returns null rather than a wrong guess.
    private static readVmixConfigRecordFolder(): string | null {
        try {
            const base = path.join(process.env.LOCALAPPDATA || '', 'vMix');
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
                score: results.score,
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

    // A record still marked queued or processing that this process is not
    // cutting was cut off by the app closing (an install mid-cut left Q4 at
    // DCC with no video in the event folder, and the 11:30 build left Q8 on
    // held as queued). Put the original back where the uploader expects it,
    // drop the partial cut, and cut it again; with auto-cut off, release the
    // raw video as an error. Runs on start and whenever the event folder
    // changes. Never guesses: if it cannot tell which file is the original,
    // it leaves every file where it is and marks the record errored.
    private recoverInterruptedCuts(folder: string | null) {
        if (!folder || !fs.existsSync(folder) || this.recovering) return;
        this.recovering = true;
        let retry = false;
        try {
            const originalsDir = path.join(folder, 'Originals');
            let records: MatchRecord[] = [];
            try {
                records = listMatches(folder);
            } catch {
                return;
            }
            records.forEach((rec) => {
                const ps = rec.processing?.state;
                if (ps !== 'queued' && ps !== 'processing') return;
                if (rec.ftc || !(rec.fileName || rec.filePath)) return;
                const key = AutoAV.cutJobKey(folder, rec.id);
                if (this.cutJobs.has(key) || this.filing.has(key)) return;
                try {
                    this.recoverOne(folder, originalsDir, rec);
                    this.recoveryFailures.delete(key);
                } catch (e) {
                    this.logs?.err.warn(
                        `Could not recover cut for ${rec.fileName}`,
                        e
                    );
                    // Recovery only runs on start and on a folder change, so a
                    // failure here (a partial cut still held open: EBUSY) would
                    // leave the match in "processing" for good. Try again, and
                    // after the last try mark it errored so Cut and the
                    // uploader are not blocked by it.
                    const failures = (this.recoveryFailures.get(key) ?? 0) + 1;
                    this.recoveryFailures.set(key, failures);
                    if (failures < AutoAV.RECOVERY_TRIES) {
                        retry = true;
                    } else {
                        this.recoveryFailures.delete(key);
                        const r = updateMatch(folder, rec.id, {
                            processing: {
                                state: 'error',
                                error: `cut not recovered: ${String(
                                    (e as Error)?.message ?? e
                                )}`,
                            },
                        });
                        if (r) this.emitter.emit('match', r);
                    }
                }
            });
        } finally {
            this.recovering = false;
        }
        if (retry) {
            setTimeout(
                () => this.recoverInterruptedCuts(folder),
                AutoAV.RECOVERY_RETRY_MS
            );
        }
    }

    private recoverOne(folder: string, originalsDir: string, rec: MatchRecord) {
        const fileName = rec.fileName || path.basename(rec.filePath as string);
        const main = path.join(folder, fileName);
        const { name, ext } = path.parse(fileName);
        // Partial cuts: the current temp spot and the one older builds used.
        [
            path.join(originalsDir, `${name}.cutting${ext}`),
            path.join(folder, `${name}.cutting${ext}`),
        ].forEach((p) => fs.rmSync(p, { force: true }));

        // Which file in Originals is this match's raw recording: the one the
        // cut recorded, else the plain name only when no "(n)" copy exists.
        const stored = rec.processing?.originalPath
            ? path.join(
                  originalsDir,
                  path.basename(rec.processing.originalPath)
              )
            : '';
        const sameName = fs.existsSync(originalsDir)
            ? fs
                  .readdirSync(originalsDir)
                  .filter(
                      (f) =>
                          f === `${name}${ext}` ||
                          (f.startsWith(`${name} (`) && f.endsWith(`)${ext}`))
                  )
            : [];
        let original = '';
        // A record that says where its original went (this build on) is
        // only ever matched to that file; the same-name guess is for records
        // from builds that did not store it.
        if (stored) original = fs.existsSync(stored) ? stored : '';
        else if (sameName.length === 1)
            original = path.join(originalsDir, sameName[0]);

        const markError = (why: string) => {
            const r = updateMatch(folder, rec.id, {
                processing: { state: 'error', error: why },
            });
            if (r) this.emitter.emit('match', r);
            this.logRecording(`Cut of ${fileName} not recovered: ${why}`);
        };

        const haveMain = fs.existsSync(main);
        if (!haveMain) {
            if (!original) {
                markError(
                    sameName.length > 1
                        ? 'interrupted cut; several originals, left in Originals for a person to pick'
                        : 'interrupted cut; no video found'
                );
                return;
            }
            fs.renameSync(original, main);
        } else if (stateOf(rec) === 'processing' && original) {
            // "processing" is written just before the raw moves to Originals,
            // so the video in place plus its original in Originals means the
            // cut was put in place and only the done state never got written.
            // ("original" is the stored path, or the only same-name file.)
            const done = updateMatch(folder, rec.id, {
                processing: {
                    state: 'done',
                    outputPath: main,
                    originalPath: original,
                },
            });
            if (done) this.emitter.emit('match', done);
            return;
        }
        this.logRecording(`Recovering interrupted cut of ${fileName}`);
        if (this.isFrcOffSeason() && getStore().get('autoAv.autoCut', false)) {
            this.queueCut(folder, rec.id, { claimed: true });
        } else {
            const released = updateMatch(folder, rec.id, {
                processing: { state: 'error', error: 'cut interrupted' },
            });
            if (released) this.emitter.emit('match', released);
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
    // `claimed`: the caller already marked this record queued (the hold set at
    // filing, or recovery of an interrupted cut) and is asking for the cut
    // itself, so the already-queued guard below must not refuse it.
    public queueCut(
        folder: string,
        recordId: string,
        opts: { claimed?: boolean } = {}
    ): void {
        const rec = getMatch(folder, recordId);
        if (!rec) return;
        if (rec.ftc) {
            this.ftcRecorder.remake(folder, recordId);
            return;
        }
        if (!rec.filePath) return;
        if (rec.hasCard) {
            this.logRecording(
                `Not cutting ${rec.fileName} (card issued, keeping explanation)`,
                undefined,
                EquipmentLogType.Debug
            );
            return;
        }
        // One cut per match at a time, whoever asks: recovery can run while
        // this process is still cutting (Restart, the FMS reconnect restart),
        // and a second cut of the same match would move the first cut's
        // output over the raw recording.
        const jobKey = AutoAV.cutJobKey(folder, recordId);
        if (this.cutJobs.has(jobKey)) return;
        const state = rec.processing?.state;
        if (!opts.claimed && (state === 'queued' || state === 'processing'))
            return;

        // The video lives in this folder under its file name; the stored
        // filePath can be stale if the folder was moved.
        const mainPath = path.join(
            folder,
            rec.fileName || path.basename(rec.filePath)
        );
        const originalsDir = path.join(folder, 'Originals');

        this.cutJobs.add(jobKey);
        let queuedJob = false;
        try {
            const queued = updateMatch(folder, recordId, {
                processing: { state: 'queued' },
            });
            if (queued) this.emitter.emit('match', queued);

            queuedJob = true;
            enqueueCut(async () => {
                let moved = false;
                let originalPath = '';
                let cutPath = '';
                try {
                    if (!fs.existsSync(originalsDir)) {
                        fs.mkdirSync(originalsDir, { recursive: true });
                    }
                    // Worked out now, when the cut runs: a file of the same name
                    // already in Originals belongs to another match or an earlier
                    // cut, so it is never reused or replaced.
                    const { name, ext } = path.parse(mainPath);
                    originalPath = path.join(originalsDir, `${name}${ext}`);
                    for (let n = 2; fs.existsSync(originalPath); n += 1) {
                        originalPath = path.join(
                            originalsDir,
                            `${name} (${n})${ext}`
                        );
                    }
                    // ffmpeg writes inside Originals/, where the uploader never looks.
                    cutPath = path.join(originalsDir, `${name}.cutting${ext}`);
                    fs.rmSync(cutPath, { force: true });

                    const started = updateMatch(folder, recordId, {
                        processing: { state: 'processing', originalPath },
                    });
                    if (started) this.emitter.emit('match', started);
                    this.logRecording(`Cutting ${path.basename(mainPath)}`);

                    // Move the original aside, cut it into a temp file, then put
                    // the cut where the original was.
                    fs.renameSync(mainPath, originalPath);
                    moved = true;
                    const kept = await cutMatchVideo(originalPath, cutPath);
                    // Never rename onto an existing file.
                    if (fs.existsSync(mainPath)) {
                        throw new Error(
                            `${path.basename(
                                mainPath
                            )} reappeared during the cut; not replacing it`
                        );
                    }
                    fs.renameSync(cutPath, mainPath);

                    const done = updateMatch(folder, recordId, {
                        processing: {
                            state: 'done',
                            outputPath: mainPath,
                            originalPath,
                        },
                    });
                    if (done) this.emitter.emit('match', done);
                    // The cut's pieces, at the time each was recorded.
                    queueLoudness(
                        folder,
                        recordId,
                        mainPath,
                        kept.map((k) => ({
                            wallStart: rec.startedAt + k.from * 1000,
                            seconds: k.seconds,
                        })),
                        (r) => this.emitter.emit('match', r)
                    );
                    this.logRecording(
                        `Cut ${path.basename(
                            mainPath
                        )}; original kept in Originals`,
                        undefined,
                        EquipmentLogType.Debug
                    );
                } catch (err: any) {
                    // Drop a partial cut and put the original back, so the base
                    // folder (which the uploader reads) holds the full recording.
                    // Never over an existing file.
                    try {
                        if (cutPath) fs.rmSync(cutPath, { force: true });
                        if (
                            moved &&
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
                            ...(originalPath ? { originalPath } : {}),
                        },
                    });
                    if (failed) this.emitter.emit('match', failed);
                    this.logRecording(
                        'Failed to cut recording',
                        err as object,
                        EquipmentLogType.Warn
                    );
                } finally {
                    this.cutJobs.delete(jobKey);
                }
            });
        } finally {
            // Nothing was queued (an error before the job existed): never keep
            // the match marked as ours, or recovery and Cut would skip it.
            if (!queuedJob) this.cutJobs.delete(jobKey);
        }
    }

    private static cutJobKey(folder: string, recordId: string): string {
        return `${path.resolve(folder)}|${recordId}`;
    }

    // Emit the recorded-match list for the folder the app is currently pointed
    // at, so the tab's history reflects the current event folder.
    // The recorded matches in the event folder, plus the match being recorded
    // now: its record only reaches the folder's manifest when the recording
    // stops, so a list read from disk alone drops it mid-match.
    public matches(): MatchRecord[] {
        const list = listMatches(this.status.saveFolder);
        const live = this.weAreRecording ? this.currentRecordObj : null;
        if (live && !list.some((r) => r.id === live.id)) list.unshift(live);
        return list;
    }

    public emitMatches(): void {
        this.emitter.emit('matches', this.matches());
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
