import log from 'electron-log';
import ping, { PingResponse } from 'ping';
import HWPingResponse from 'models/HWPingResponse';
import { EventEmitter } from 'stream';
import { getCartNumberFromHostname } from '../util';
import { AddonLoggers } from './addon-loggers';
import { fetchAndParseAudioDevices } from '../events/HWCheck';

const pingConfig = {
    timeout: 3,
};

export default class HWPing {
    private static instance: HWPing;

    private interval: any = null;

    private logs: AddonLoggers | null = null;

    private cartNumber: number = 0;

    private currentState: HWPingResponse = {
        camera1: false,
        camera2: false,
        mixer: false,
        switch: false,
        internet: false,
        errors: [],
    };

    private emitter: EventEmitter = new EventEmitter();

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('hwping.out'),
            err: log.scope('hwping.err'),
        };

        this.cartNumber = getCartNumberFromHostname();
    }

    public start() {
        // Start HWPing
        this.log('HWPing Service Started');

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        // Initial Ping
        this.ping();

        // Start pinging every 10 seconds
        this.interval = setInterval(() => this.ping(), 10000);
    }

    // Ping the hardware
    // TODO: make these dynamic?
    private async ping() {
        const promises: Promise<any>[] = [
            // Ping switch
            ping.promise.probe(`192.168.25.10${this.cartNumber}`, pingConfig),
            // Ping PTZ1
            ping.promise.probe(`192.168.25.${this.cartNumber}1`, pingConfig),
            // Ping PTZ2
            ping.promise.probe(`192.168.25.${this.cartNumber}2`, pingConfig),
            // Ping mixer
            ping.promise.probe(`192.168.25.${this.cartNumber}3`, pingConfig),
            // Ping Internet
            ping.promise.probe('docs.fimav.us', pingConfig),
            // Handle Audio
            this.verifyAudio(),
        ];

        // Execute the pings
        const results = await Promise.all(promises).catch((err) => this.currentState.errors.push(err));

        if (!Array.isArray(results)) return;

        // Remove last result (audio)
        if (results) results.pop();

        // If we got here, no errors
        this.currentState.errors = [];

        // Iterate over the results and update the state
        let didUpdate = false;
        results.forEach((res, i) => {
            const out = res as PingResponse
            if (typeof out.alive !== 'boolean') return;
            switch (i) {
            case 0:
                if (this.currentState.switch !== out.alive) {
                    this.currentState.switch = out.alive;
                    didUpdate = true;
                }
                break;
            case 1:
                if (this.currentState.mixer !== out.alive) {
                    this.currentState.mixer = out.alive;
                    didUpdate = true;
                }
                break;
            case 2:
                if (this.currentState.camera1 !== out.alive) {
                    this.currentState.camera1 = out.alive;
                    didUpdate = true;
                }
                break;
            case 3:
                if (this.currentState.camera2 !== out.alive) {
                    this.currentState.camera2 = out.alive;
                    didUpdate = true;
                }
                break;
            case 4:
                if (this.currentState.internet !== out.alive) {
                    this.currentState.internet = out.alive;
                    didUpdate = true;
                }
                break;
            default:
                break;
            }
        });

        if (didUpdate) {
            // Print the change
            this.log(`HW Change: ${JSON.stringify(this.currentState, null, 2)}`);

            // Emit the change
            this.emitter.emit('hw-change', this.currentState);
        }
    }

    // Audio Promises
    private async verifyAudio() {
        return fetchAndParseAudioDevices(this.logs?.out ?? log).then((devices) => {
            const cmds: Promise<any>[] = []
            devices.forEach((device) => {
                if (device.name === 'OUT 1-2' && device.sub_name.includes('BEHRINGER X-AIR')) {
                    // We won't mess with mute status here, but we will mess with having it be set as the default device
                    if (device.default !== 'Render') {
                        // TODO: Show obtrustive dialog that doesn't allow the user close it until they click "OK" or dismiss it
                    }
                }
            });

            return Promise.all(cmds);
        }).catch((err) => {
            this.log(`Error muting audio: ${err}`);
        });
    }

    // Stop the service
    public stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    // Add a listener
    // eslint-disable-next-line
    public on(event: 'hw-change', listener: (arg: HWPingResponse) => void) {
        this.emitter.on(event, listener);
    }

    // Log a message
    private log(msg: string, severity: 'out' | 'err' = 'out') {
        if (!this.logs) throw new Error('Loggers have not been configured.');
        this.logs[severity].log(msg);
    }

    public get currentStatus() {
        return this.currentState;
    }

    public static get Instance(): HWPing {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}