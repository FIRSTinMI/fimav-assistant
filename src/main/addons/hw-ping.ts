import log from 'electron-log';
import ping from 'ping';
import HWPingResponse from 'models/HWPingResponse';
import { EventEmitter } from 'stream';
import { getCartNumberFromHostname } from '../util';
import { AddonLoggers } from './addon-loggers';

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
        errors: [],
    };

    private emitter: EventEmitter = new EventEmitter();

    constructor() {
        // Start new log files
        this.logs = {
            out: log.scope('autoav.out'),
            err: log.scope('autoav.err'),
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

        // Start pinging every 10 seconds
        this.interval = setInterval(this.ping, 10000);
    }

    // Ping the hardware
    private async ping() {
        const promises = [
            // TODO: Ensure these are the right IPs
            // Ping switch
            ping.promise.probe(`192.168.25.10${this.cartNumber}`, pingConfig),
            // Ping mixer
            ping.promise.probe(`192.168.25.${this.cartNumber}2`, pingConfig),
            // Ping PTZ1
            ping.promise.probe(`192.168.25.${this.cartNumber}3`, pingConfig),
            // Ping PTZ2
            ping.promise.probe(`192.168.25.${this.cartNumber}4`, pingConfig),
        ];

        // Execute the pings
        const results = await Promise.all(promises).catch((err) => this.currentState.errors.push(err));

        if (!Array.isArray(results)) return;

        // If we got here, no errors
        this.currentState.errors = [];

        // Iterate over the results and update the state
        let didUpdate = false;
        results.forEach((res, i) => {
            switch (i) {
                case 0:
                    if (this.currentState.switch !== res.alive) {
                        this.currentState.switch = res.alive;
                        didUpdate = true;
                    }
                    break;
                case 1:
                    if (this.currentState.mixer !== res.alive) {
                        this.currentState.mixer = res.alive;
                        didUpdate = true;
                    }
                    break;
                case 2:
                    if (this.currentState.camera1 !== res.alive) {
                        this.currentState.camera1 = res.alive;
                        didUpdate = true;
                    }
                    break;
                case 3:
                    if (this.currentState.camera2 !== res.alive) {
                        this.currentState.camera2 = res.alive;
                        didUpdate = true;
                    }
                    break;
                default:
                    break;
            }
        });

        if (didUpdate) {
            // Emit the change
            this.emitter.emit('hw-change', this.currentState);
        }
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