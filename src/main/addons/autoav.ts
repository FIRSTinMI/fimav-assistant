import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import log from 'electron-log';
import { invokeExpectResponse } from 'main/window_components/signalR';
import VmixRecordingService from '../../services/VmixService';
import FMSMatchStatus from '../../models/FMSMatchState';
import attemptRename, { getNewestFile } from '../../utils/recording';
import { AddonLoggers } from './addon-loggers';
import { signalrToElectronLog } from '../util';
import Event from '../../models/Event';

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

    // VMix Service
    private vmixService: VmixRecordingService | null = null;

    // Last file recorded
    private currentFile: string | null = null;

    // Current event name
    private currentEventName: string | null = null;

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('autoav.out'),
            err: log.scope('autoav.err'),
        };
    }

    private stopRecording() {
        if (!this.vmixService) return;
        this.vmixService
            .StopRecording()
            .then(async () => {
                this.log('🟥 Stopped Recording');

                // If we don't have a start time or data, don't try to rename
                if (!this.lastMatchStartData)
                    return undefined;

                // If we don't have an event name, try to get it
                if (!this.currentEventName || this.currentEventName.length === 0) {
                    const events = await invokeExpectResponse<Event[]>('GetEvents', 'Events');
                    if (events.length > 0) {
                        const now = new Date();
                        const currentEvent = events.find(
                            (e) => now >= new Date(e.start) && now <= new Date(e.end)
                        );
                        if (currentEvent) {
                            this.setEventName(currentEvent.name);
                        } else {
                            this.setEventName('');
                        }
                    }
                }

                // Attempt to rename the file
                try {
                    const filename = await attemptRename(
                        this.currentEventName ?? 'Unknown Event',
                        this.currentFile,
                        this.lastMatchStartData
                    );

                    this.log(`Renamed last recording to ${filename}`);
                } catch (err) {
                    this.log(`‼️ Error Renaming Recording: ${err}`, 'err');
                } finally {
                    this.lastMatchStartData = null;
                }

                return undefined;
            })
            .catch((err) => {
                this.log(`‼️ Error Stopping Recording: ${err}`);
            });
    }

    // Start AutoAV
    public start() {
        // Notify Parent logs that we're running
        this.log('AutoAV Service Started');

        // Create new VMix Service
        this.vmixService = new VmixRecordingService({
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
                    `Match Status Changed: ${this.lastState ? this.lastState.MatchState : 'Unknown'
                    } -> ${info.MatchState} for ${info.Level} Match ${info.MatchNumber
                    } (Play #${info.PlayNumber})`
                );

                // Update
                this.lastState = info;

                // Start recording when GameSpecificData is released (match starts)
                if (info.MatchState === 'GameSpecificData' && !!this.vmixService) {
                    this.vmixService
                        .StartRecording()
                        .then(() => {
                            this.log('🔴 Started Recording');
                            this.lastMatchStartData = info;

                            // Give it some time, then attempt to find the file
                            setTimeout(() => {
                                // TODO: Make dynamic and configurable
                                this.currentFile = getNewestFile(
                                    'C:\\Users\\FIM\\Documents\\vMixStorage')
                            })

                            return undefined;
                        })
                        .catch((err) => {
                            this.log(`‼️ Error Starting Recording: ${err}`);
                        });
                } else if (info.MatchState === 'MatchCancelled') { // Estop!
                    setTimeout(() => this.stopRecording(), 10000); // Ok, but we wanna see the frantic running around for a bit
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
                    setTimeout(() => this.stopRecording(), 16000); // As of 2024, the time to actually see the match detailts happens at about 11 seconds, so we'll wait 16 seconds to be safe
                }
            }

            return this;
        });

        const bogusEvents = [
            'fieldnetworkstatus',
            'matchtimerchanged',
            'plc_io_status_changed',
            'plc_match_status_changed',
        ];

        // Dummies to get log to shush
        bogusEvents.forEach((e) => {
            this.hubConnection?.on(e, () => { });
        });

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

    // Set the event name
    public setEventName(eventName: string) {
        this.currentEventName = eventName;
    }

    public static get Instance(): AutoAV {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
