import EventEmitter from 'events';
import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import log from 'electron-log';
import FMSMatchStatus from '../../models/FMSMatchState';
import attemptRename from '../../utils/recording';
import { AddonLoggers } from './addon-loggers';
import { getCurrentEvent, signalrToElectronLog } from '../util';
import VmixService from '../../services/VmixService';
import Event from '../../models/Event';
import { invokeExpectResponse, invoke } from '../window_components/signalR';

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
    private currentEventName: string | null = null;

    // Track whether or not we're recording (rather than someone in vMix clicking record)
    private weAreRecording = false;

    // Track if we're already scheduled to stop recording
    private willStopRecording = false;

    // Event Emitter
    private emitter: EventEmitter = new EventEmitter();

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
            this.log('🟥 Not Recording');
            return;
        }

        VmixService.Instance.StopRecording()
            .then(async () => {
                this.log('🟥 Stopped Recording');
                this.emitter.emit('info', 'Stopped Recording. Renaming File...');
                this.weAreRecording = false;
                this.willStopRecording = false;

                // If we don't have a start time or data, don't try to rename
                if (!this.lastMatchStartData) return undefined;

                // If we don't have an event name, try to get it
                if (
                    !this.currentEventName ||
                    this.currentEventName.length === 0
                ) {
                    this.log(
                        'ℹ Event Name not Present. Fetching current event name...'
                    );
                    this.currentEventName = await this.fetchEventName();
                }

                // Attempt to rename the file
                try {
                    const filename = await attemptRename(
                        this.currentEventName ?? 'Unknown Event',
                        this.currentFile,
                        this.lastMatchStartData
                    );

                    this.log(`Renamed last recording to ${filename}`);
                    this.emitter.emit('info', `Renamed recording to ${filename}`);
                } catch (err) {
                    this.log(`‼️ Error Renaming Recording: ${err}`, 'err');
                    this.emitter.emit('info', `‼️ Error Renaming Recording: ${err}`);
                } finally {
                    this.lastMatchStartData = null;
                }

                return undefined;
            })
            .catch((err) => {
                this.log(`‼️ Error Stopping Recording: ${err}`);
                this.log(err);
            });

        invoke('WriteLog', 'Stopping recording');
    }

    /**
     * Start Recording
     * @returns void
     */
    private startRecording(matchInfo: FMSMatchStatus) {
        VmixService.Instance.StartRecording()
            .then(() => {
                this.log('🔴 Started Recording');
                this.emitter.emit('info', `Started Recording ${matchInfo.Level} Match #${matchInfo.MatchNumber}-${matchInfo.PlayNumber}`);
                this.lastMatchStartData = matchInfo;
                this.weAreRecording = true;

                // Give it some time, then attempt to find the file
                setTimeout(async () => {
                    this.currentFile =
                        await VmixService.Instance.GetCurrentRecording();
                }, 3000);

                invoke(
                    'WriteLog',
                    `Starting recording of ${matchInfo.Level} ${matchInfo.MatchNumber} (play ${matchInfo.PlayNumber})`);

                return undefined;
            })
            .catch((err) => {
                this.log(`‼️ Error Starting Recording: ${err}`);
                this.emitter.emit('info', `‼️ Error Starting Recording. Is Vmix at ${VmixService.Instance.getUrl}?`);
                invoke('WriteLog', `Failed to start recording. Unable to talk to vMix? Configured URL: ${VmixService.Instance.getUrl()}`);
            });
    }

    // Start AutoAV
    public start() {
        // Notify Parent logs that we're running
        this.log('Service Started');
        this.emitter.emit('info', 'AutoAV Service Started');

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
                this.log(
                    `Match Status Changed: ${this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${info.MatchNumber
                    } (Play #${info.PlayNumber})`
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
            this.log(`Got a config value change: ${configKey}`);

            // VideoSwitchOption
            if (configKey === 'VideoSwitchOption') {
                this.log('Video switch option changed, fetching update!');
                const resp = await nodeFetch(
                    'http://10.0.100.5/api/v1.0/settings/get/get_VideoSwitchOption'
                );
                const switchOption = await resp.text();
                this.log(`Got Switch Option: ${switchOption}`);
                // "MatchResult" (yes, double quotes are included in the response)
                if (switchOption === '"MatchResult"') {
                    this.log('🚀 Scores Posted. Waiting 16 Seconds...');

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
            'azuresyncstatuschanged'
        ];

        // Dummies to get log to shush
        bogusEvents.forEach((e) => {
            this.hubConnection?.on(e, () => { });
        });

        // Register connected/disconnected events
        this.hubConnection.onreconnecting(() => {
            this.log('AutoAV FMS Connection Lost, Reconnecting');
            this.emitter.emit('info', 'FMS Connection Lost, Reconnecting');
        });
        this.hubConnection.onclose(() => {
            this.log('AutoAV FMS Connection Closed!');
            this.emitter.emit('info', 'FMS Connection Closed');
            invoke('WriteLog', 'Reconnecting to FMS');
        });
        this.hubConnection.onclose(() => {
            this.log('AutoAV FMS Connection Closed!');
            invoke('WriteLog', 'Lost connection to FMS');
        });

        // Start connection to SignalR Hub
        this.hubConnection
            .start()
            .then(() => {
                this.log('AutoAV FMS Connection Established!');
                this.emitter.emit('info', 'FMS Connection Established');
                invoke('WriteLog', 'FMS connected!');

                return undefined;
            })
            .catch((err) => {
                this.log(`AutoAV FMS Connection Failed: ${err}`);
                this.emitter.emit('info', `FMS Connection Failed.`);
                invoke('WriteLog', `FMS connection failed! ${err}`);

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
    private async fetchEventName(): Promise<string | null> {
        return invokeExpectResponse<Event[]>('GetEvents', 'Events').then((events: Event[]) => {
            return getCurrentEvent(events)
        }).then((e) => {
            return e ? `${new Date().getFullYear()} ${e.name}` : null;
        }).catch((e) => {
            this.log(
                `‼️ Error Fetching Event Name: ${e}`,
                'err'
            );
            return null;
        });
    }

    // Log a message
    private log(msg: string, severity: 'out' | 'err' = 'out') {
        if (!this.logs) throw new Error('Loggers have not been configured.');
        this.logs[severity].log(msg);
    }

    // Set the event name
    public setEventName(eventName: string) {
        this.currentEventName = eventName;
    }

    public static get Instance(): AutoAV {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }

    // eslint-disable-next-line no-unused-vars
    public on(event: 'info', listener: (arg: string) => void) {
        this.emitter.on(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public off(event: 'info', listener: (arg: string) => void) {
        this.emitter.off(event, listener);
    }

    // eslint-disable-next-line no-unused-vars
    public once(event: 'info', listener: (arg: string) => void) {
        this.emitter.once(event, listener);
    }
}
