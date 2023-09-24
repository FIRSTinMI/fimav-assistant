import { HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import { parentPort, MessagePort } from 'node:worker_threads';
import VmixRecordingService from '../services/VmixRecordingService';
import FMSMatchStatus from '../models/FMSMatchState';
import attemptRename from '../utils/recording';

// Parent Port
let parent = parentPort!;

// Last Match "Start"
let lastMatchStartTime: Date | null;
let lastMatchStartData: FMSMatchStatus | null;
let lastState: FMSMatchStatus | null;

const logToParent = (msg: string) => {
    parent.postMessage('AutoAV: ' + msg);
}

if (parent === null) {
    parent = {
        postMessage: console.log,
    } as any as MessagePort;
}

// Notify Parent logs that we're running
logToParent('AutoAV Service Started');

// Create new VMix Service
const vmixService = new VmixRecordingService({
    baseUrl: 'http://127.0.0.1:8000/api',
    username: 'user',
    password: 'pass',
});

// Build a connection to the SignalR Hub
const conn = new HubConnectionBuilder()
    .withUrl('http://10.0.100.5:8189/infrastructureHub')
    .withAutomaticReconnect()
    .build();

// Register listener for the "MatchStatusInfoChanged" event (match starts, ends, changes modes, etc)
conn.on('MatchStatusInfoChanged', (info: FMSMatchStatus) => {
    // Log the change
    logToParent(`Match Status Changed: ${lastState ? lastState.p1 : 'Unknown'} -> ${info.p1} for ${info.p4} Match ${info.p2} (Play #${info.p3})`);

    // Update
    lastState = info;

    // Start recording when GameSpecificData is released (match starts)
    if (info.p1 === 'GameSpecificData') {
        vmixService.StartRecording().then(() => {
            logToParent('🔴 Started Recording');
            lastMatchStartData = info;
            lastMatchStartTime = new Date();
        }).catch((err) => {
            logToParent(`‼️ Error Starting Recording: ${err}`);
        });
    }
});

// Register listener for the "SystemConfigValueChanged" event (video switch))
conn.on('SystemConfigValueChanged', async (configKey) => {
    logToParent(`Got a config value change: ${configKey}`);

    // VideoSwitchOption
    if (configKey === 'VideoSwitchOption') {
        logToParent('Video switch option changed, fetching update!');
        const resp = await nodeFetch(
            'http://10.0.100.5/api/v1.0/settings/get/get_VideoSwitchOption'
        );
        const switchOption = await resp.text();
        logToParent(`Got Switch Option: ${switchOption}`);
        // MatchResult
        if (parseInt(switchOption, 10) === 4) {
            logToParent('🚀 Scores Posted. Waiting 10 Seconds...');

            // TODO: Request the recording location and event name from parent process

            // TODO: Make this time dynamic and configurable
            setTimeout(() => {
                vmixService.StopRecording().then(async () => {
                    logToParent('🟥 Stopped Recording');

                    // If we don't have a start time or data, don't try to rename
                    if (!lastMatchStartTime || !lastMatchStartData) return;

                    // Start trying to rename file // TODO: Make dynamic and configurable
                    const recordingLocation = "C:\\Users\\FIM\\Documents\\vMixStorage";

                    // Attempt to rename the file
                    await attemptRename("eventName", recordingLocation, lastMatchStartTime, lastMatchStartData).then(filename => {
                        // Log the new filename
                        logToParent(`Renamed last recording to ${filename}`);
                    }).catch(err => {
                        // Log the error
                        logToParent(`‼️ Error Renaming Recording: ${err}`);
                    }).finally(() => {
                        // Reset the last match start time and data
                        lastMatchStartTime = null;
                        lastMatchStartData = null;
                    });
                }).catch((err) => {
                    logToParent(`‼️ Error Stopping Recording: ${err}`);
                });
            }, 10000);
        }
    }
});

// Register connected/disconnected events
conn.onreconnecting(() => {
    logToParent('AutoAV FMS Connection Lost, Reconnecting');
});
conn.onclose(() => {
    logToParent('AutoAV FMS Connection Closed!');
});

// Start connection to SignalR Hub
conn.start().then(() => {
    logToParent('AutoAV FMS Connection Established!');
}).catch((err) => {
    logToParent(`AutoAV FMS Connection Failed: ${err}`);
});
