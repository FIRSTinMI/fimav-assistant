import { HubConnectionBuilder } from '@microsoft/signalr';
import nodeFetch from 'node-fetch';
import { parentPort, MessagePort } from 'node:worker_threads';
import VmixRecordingService from '../services/VmixRecordingService';

let parent = parentPort!;

if (parent === null) {
    parent = {
        postMessage: console.log,
    } as any as MessagePort;
}

parent.postMessage('background thread is running');

const vmixService = new VmixRecordingService({
    baseUrl: 'http://127.0.0.1:8000/api',
    username: 'user',
    password: 'pass',
});

const conn = new HubConnectionBuilder()
    .withUrl('http://10.0.100.5:8189/infrastructureHub')
    .withAutomaticReconnect()
    .build();

conn.on('MatchStatusInfoChanged', (info) => {
    parent.postMessage('match status info changed');
    if (info.p1 === 'GameSpecificData') {
        parent.postMessage('====== start recording');
        vmixService.StartRecording();
    }
});

conn.on('SystemConfigValueChanged', async (configKey) => {
    parent.postMessage(`got a config value change ${configKey}`);
    // VideoSwitchOption
    if (configKey === 'VideoSwitchOption') {
        parent.postMessage('got a video switch option change');
        const resp = await nodeFetch(
            'http://10.0.100.5/api/v1.0/settings/get/get_VideoSwitchOption'
        );
        const switchOption = await resp.text();
        parent.postMessage(`switch option is ${switchOption}`);
        // MatchResult
        if (parseInt(switchOption, 10) === 4) {
            parent.postMessage('====== stop recording');
            vmixService.StopRecording();
        }
    }
});

(async () => {
    await conn.start();
    parent.postMessage('started websocket');
})();
