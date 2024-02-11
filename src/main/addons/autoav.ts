import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import VmixRecordingService from '../../services/VmixRecordingService';
import FMSMatchStatus from '../../models/FMSMatchState';
import attemptRename from '../../utils/recording';
import log from 'electron-log';
import { AddonLoggers } from '.';
import { signalrToElectronLog } from '../util';


export default class AutoAV {

    private static _instance: AutoAV;

    // Last Match "Start"
    private lastMatchStartTime: Date | null = null;
    private lastMatchStartData: FMSMatchStatus | null = null;
    private lastState: FMSMatchStatus | null = null;
    private hubConnection: HubConnection | null = null;

    private logs: AddonLoggers | null = null;

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope("autoav.out"),
            err: log.scope("autoav.err")
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
            .withUrl('http://10.0.100.5:8189/infrastructureHub')
            .configureLogging({
                log: (logLevel, message) => {
                    signalrToElectronLog(this.logs?.out ?? null, logLevel, message)
                },
            })
            .withAutomaticReconnect()
            .build();

        // Register listener for the "MatchStatusInfoChanged" event (match starts, ends, changes modes, etc)
        this.hubConnection.on('MatchStatusInfoChanged', (info: FMSMatchStatus) => {
            // Log the change
            this.log(`Match Status Changed: ${this.lastState ? this.lastState.p1 : 'Unknown'} -> ${info.p1} for ${info.p4} Match ${info.p2} (Play #${info.p3})`);

            // Update
            this.lastState = info;

            // Start recording when GameSpecificData is released (match starts)
            if (info.p1 === 'GameSpecificData') {
                vmixService.StartRecording().then(() => {
                    this.log('🔴 Started Recording');
                    this.lastMatchStartData = info;
                    this.lastMatchStartTime = new Date();
                }).catch((err) => {
                    this.log(`‼️ Error Starting Recording: ${err}`);
                });
            }
        });

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
                // MatchResult
                if (parseInt(switchOption, 10) === 4) {
                    this.log('🚀 Scores Posted. Waiting 10 Seconds...');

                    // TODO: Request the recording location and event name from parent process

                    // TODO: Make this time dynamic and configurable
                    setTimeout(() => {
                        vmixService.StopRecording().then(async () => {
                            this.log('🟥 Stopped Recording');

                            // If we don't have a start time or data, don't try to rename
                            if (!this.lastMatchStartTime || !this.lastMatchStartData) return;

                            // Start trying to rename file // TODO: Make dynamic and configurable
                            const recordingLocation = "C:\\Users\\FIM\\Documents\\vMixStorage";

                            // Attempt to rename the file
                            await attemptRename("eventName", recordingLocation, this.lastMatchStartTime, this.lastMatchStartData).then(filename => {
                                // Log the new filename
                                this.log(`Renamed last recording to ${filename}`);
                            }).catch(err => {
                                // Log the error
                                this.log(`‼️ Error Renaming Recording: ${err}`);
                            }).finally(() => {
                                // Reset the last match start time and data
                                this.lastMatchStartTime = null;
                                this.lastMatchStartData = null;
                            });
                        }).catch((err) => {
                            this.log(`‼️ Error Stopping Recording: ${err}`);
                        });
                    }, 10000);
                }
            }

            return this;
        });

        // Register connected/disconnected events
        this.hubConnection.onreconnecting(() => {
            this.log('AutoAV FMS Connection Lost, Reconnecting');
        });
        this.hubConnection.onclose(() => {
            this.log('AutoAV FMS Connection Closed!');
        });

        // Start connection to SignalR Hub
        this.hubConnection.start().then(() => {
            this.log('AutoAV FMS Connection Established!');
        }).catch((err) => {
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
        return this._instance || (this._instance = new this());
    }
}