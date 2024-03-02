import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import log from 'electron-log';
import VmixRecordingService from '../../services/VmixRecordingService';
import FMSMatchStatus from '../../models/FMSMatchState';
import attemptRename from '../../utils/recording';
import { AddonLoggers } from './addon-loggers';
import { signalrToElectronLog } from '../util';


export default class AutoAV {
    private static instance: AutoAV;

    // Last Match "Start"
    private lastMatchStartTime: Date | null = null;

    private lastMatchStartData: FMSMatchStatus | null = null;

    private lastState: FMSMatchStatus | null = null;

    private hubConnection: HubConnection | null = null;

    private logs: AddonLoggers | null = null;

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('autoav.out'),
            err: log.scope('autoav.err'),
        };
    }

    // Start AutoAV
    public start() {
        // Notify Parent logs that we're running
        this.log('AutoAV Service Started');

        // Create new VMix Service
        const vmixService = new VmixRecordingService({
            baseUrl: 'http://127.0.0.1:8000/api',
            username: 'user',
            password: 'pass',
        });

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
            .withAutomaticReconnect()
            .build();

        // Register listener for the "MatchStatusInfoChanged" event (match starts, ends, changes modes, etc)
        this.hubConnection.on(
            'MatchStatusInfoChanged',
            (info: FMSMatchStatus) => {
                // Log the change
                this.log(
                    `Match Status Changed: ${
                        this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${info.MatchNumber} (Play #${
                        info.PlayNumber
                    })`
                );

                // Update
                this.lastState = info;

                // Start recording when GameSpecificData is released (match starts)
                if (info.MatchState === 'GameSpecificData') {
                    vmixService
                        .StartRecording()
                        .then(() => {
                            this.log('🔴 Started Recording');
                            this.lastMatchStartData = info;
                            this.lastMatchStartTime = new Date();

                            return undefined;
                        })
                        .catch((err) => {
                            this.log(`‼️ Error Starting Recording: ${err}`);
                        });
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
                    this.log('🚀 Scores Posted. Waiting 10 Seconds...');

                    // TODO: Request the recording location and event name from parent process

                    // TODO: Make this time dynamic and configurable
                    setTimeout(() => {
                        vmixService
                            .StopRecording()
                            .then(async () => {
                                this.log('🟥 Stopped Recording');

                                // If we don't have a start time or data, don't try to rename
                                if (
                                    !this.lastMatchStartTime ||
                                    !this.lastMatchStartData
                                )
                                    return undefined;

                                // Start trying to rename file // TODO: Make dynamic and configurable
                                const recordingLocation =
                                    'C:\\Users\\FIM\\Documents\\vMixStorage';

                                // Attempt to rename the file
                                try {
                                    const filename = await attemptRename(
                                        'eventName',
                                        recordingLocation,
                                        this.lastMatchStartTime,
                                        this.lastMatchStartData
                                    );

                                    this.log(
                                        `Renamed last recording to ${filename}`
                                    );
                                } catch (err) {
                                    this.log(
                                        `‼️ Error Renaming Recording: ${err}`, 'err'
                                    );
                                } finally {
                                    this.lastMatchStartTime = null;
                                    this.lastMatchStartData = null;
                                }

                                return undefined;
                            })
                            .catch((err) => {
                                this.log(`‼️ Error Stopping Recording: ${err}`);
                            });
                    }, 10000);
                }
            }

            return this;
        });

        const bogusEvents = ["fieldnetworkstatus", "matchtimerchanged", "plc_io_status_changed", "plc_match_status_changed"]

        // Dummies to get log to shush
        bogusEvents.forEach(e => {
            this.hubConnection?.on(e, () => {})
        })

        // Register connected/disconnected events
        this.hubConnection.onreconnecting(() => {
            this.log('AutoAV FMS Connection Lost, Reconnecting');
        });
        this.hubConnection.onclose(() => {
            this.log('AutoAV FMS Connection Closed!');
        });

        // Start connection to SignalR Hub
        this.hubConnection
            .start()
            .then(() => {
                this.log('AutoAV FMS Connection Established!');

                return undefined;
            })
            .catch((err) => {
                this.log(`AutoAV FMS Connection Failed: ${err}`);
            });
    }

    // Stop AutoAV
    public stop() {
        // Log stopping
        this.log('AutoAV Service Stopped');
        // Stop the SignalR Hub connection
        this.hubConnection?.stop();
    }

    // Log a message
    private log(msg: string, severity: 'out' | 'err' = 'out') {
        if (!this.logs) throw new Error('Loggers have not been configured.');
        this.logs[severity].log(msg);
    }

    public static get Instance(): AutoAV {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
