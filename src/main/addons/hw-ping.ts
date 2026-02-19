import log from 'electron-log';
import ping, { PingResponse } from 'ping';
import HWPingResponse, { IpConfigState } from 'models/HWPingResponse';
import { EventEmitter } from 'stream';
import { networkInterfaces } from 'os';
import {
    EquipmentLogCategory,
    EquipmentLogType,
} from '../../models/EquipmentLog';
import { invokeLog } from '../window_components/signalR';
import { getCartNumberFromHostname } from '../util';
import { AddonLoggers } from './addon-loggers';
// import { fetchAndParseAudioDevices } from '../events/HWCheck';

// --- Subnet helpers ---

/* eslint-disable no-bitwise */
function ipToInt(ip: string): number {
    return (
        ip
            .split('.')
            .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0
    );
}

function isInSubnet(ip: string, subnet: string, prefixLen: number): boolean {
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(subnet) & mask);
}
/* eslint-enable no-bitwise */

function isSelfAssigned(ip: string): boolean {
    return ip.startsWith('169.254.');
}

function isTailscaleIp(ip: string): boolean {
    // Tailscale uses 100.64.0.0/10
    return isInSubnet(ip, '100.64.0.0', 10);
}

const pingConfig = {
    timeout: 3,
};

export default class HWPing {
    private static instance: HWPing;

    private interval: any = null;

    private ipInterval: any = null;

    private logs: AddonLoggers | null = null;

    private cartNumber: number = 0;

    private currentState: HWPingResponse = {
        camera1: false,
        camera2: false,
        mixer: false,
        switch: false,
        internet: false,
        errors: [],
        ip_errors: [],
        ip_warnings: [],
    };

    private lastIpState: IpConfigState = { errors: [], warnings: [] };

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
        if (this.ipInterval) {
            clearInterval(this.ipInterval);
            this.ipInterval = null;
        }

        // Initial checks
        this.ping();
        this.runIpCheck();

        // Start pinging every 10 seconds
        this.interval = setInterval(() => this.ping(), 10000);

        // Check IP config every 60 seconds
        this.ipInterval = setInterval(() => this.runIpCheck(), 60000);
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
        const results = await Promise.all(promises).catch((err) =>
            this.currentState.errors.push(err)
        );

        if (!Array.isArray(results)) return;

        // Remove last result (audio)
        if (results) results.pop();

        // If we got here, no errors
        this.currentState.errors = [];

        // Iterate over the results and update the state
        let didUpdate = false;
        results.forEach((res, i) => {
            const out = res as PingResponse;
            if (typeof out.alive !== 'boolean') return;
            switch (i) {
                case 0:
                    if (this.currentState.switch !== out.alive) {
                        this.currentState.switch = out.alive;
                        this.remoteLog('Switch', out.alive);
                        didUpdate = true;
                    }
                    break;
                case 1:
                    if (this.currentState.mixer !== out.alive) {
                        this.currentState.mixer = out.alive;
                        this.remoteLog('Mixer', out.alive);
                        didUpdate = true;
                    }
                    break;
                case 2:
                    if (this.currentState.camera1 !== out.alive) {
                        this.currentState.camera1 = out.alive;
                        this.remoteLog('Camera 1', out.alive);
                        didUpdate = true;
                    }
                    break;
                case 3:
                    if (this.currentState.camera2 !== out.alive) {
                        this.currentState.camera2 = out.alive;
                        this.remoteLog('Camera 2', out.alive);
                        didUpdate = true;
                    }
                    break;
                case 4:
                    if (this.currentState.internet !== out.alive) {
                        this.currentState.internet = out.alive;
                        this.remoteLog('Internet', out.alive);
                        didUpdate = true;
                    }
                    break;
                default:
                    break;
            }
        });

        if (didUpdate) {
            // Print the change
            this.log(
                `HW Change: ${JSON.stringify(this.currentState, null, 2)}`
            );

            // Emit the change
            this.emitter.emit('hw-change', this.currentState);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    private remoteLog(device: string, status: boolean) {
        const severity = status ? EquipmentLogType.Info : EquipmentLogType.Warn;

        invokeLog(`${device} is ${status ? 'online' : 'offline'}`, {
            severity,
            category: EquipmentLogCategory.HWPing_General,
        });
    }

    // Audio Promises
    // eslint-disable-next-line class-methods-use-this
    private async verifyAudio() {
        // this.log('Skipping audio check for now.');
        return Promise.resolve(null);
        // return fetchAndParseAudioDevices(this.logs?.out ?? log).then((devices) => {
        //     const cmds: Promise<any>[] = []
        //     devices.forEach((device) => {
        //         if (device.name === 'OUT 1-2' && device.sub_name.includes('BEHRINGER X-AIR')) {
        //             // We won't mess with mute status here, but we will mess with having it be set as the default device
        //             if (device.default !== 'Render') {
        //                 // TODO: Show obtrustive dialog that doesn't allow the user close it until they click "OK" or dismiss it
        //             }
        //         }
        //     });

        //     return Promise.all(cmds);
        // }).catch((err) => {
        //     this.log(`Error muting audio: ${err}`);
        // });
    }

    // Stop the service
    public stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.ipInterval) {
            clearInterval(this.ipInterval);
            this.ipInterval = null;
        }
    }

    // Add a listener
    /* eslint-disable */
    public on(
        event: 'hw-change',
        listener: (arg: HWPingResponse) => void
    ): void;

    public on(
        event: 'ip-config-changed',
        listener: (arg: IpConfigState) => void
    ): void;

    public on(event: string, listener: (arg: any) => void) {
        this.emitter.on(event, listener);
    }
    /* eslint-enable */

    // Run IP config check and emit if changed
    private runIpCheck() {
        const result = this.checkNetworkConfig();
        if (JSON.stringify(result) !== JSON.stringify(this.lastIpState)) {
            this.lastIpState = result;
            this.currentState.ip_errors = result.errors;
            this.currentState.ip_warnings = result.warnings;
            this.emitter.emit('ip-config-changed', result);
        }
    }

    // Check network interface config for anomalies
    public checkNetworkConfig(): IpConfigState {
        const errors: string[] = [];
        const warnings: string[] = [];

        const ifaces = networkInterfaces();
        const month = new Date().getMonth() + 1; // 1-indexed
        const isFrcSeason = month >= 2 && month <= 5;

        this.log(
            `IP check: interfaces found: ${Object.keys(ifaces).join(', ')}`
        );
        this.log(`IP check: FRC season: ${isFrcSeason} (month ${month})`);

        let fieldIp: string | undefined;
        let avIp: string | undefined;
        let internetIp: string | undefined;
        let tailscaleIp: string | undefined;
        let tailscaleFound = false;

        Object.keys(ifaces).forEach((name) => {
            const lower = name.toLowerCase();
            const addrs = ifaces[name] ?? [];
            const ipv4 = addrs.find((a) => a.family === 'IPv4');

            if (lower.includes('field')) {
                fieldIp = ipv4?.address;
                this.log(
                    `IP check: Field VLAN interface "${name}" -> ${
                        fieldIp ?? 'no IPv4'
                    }`
                );
            } else if (lower.includes('av')) {
                avIp = ipv4?.address;
                this.log(
                    `IP check: AV VLAN interface "${name}" -> ${
                        avIp ?? 'no IPv4'
                    }`
                );
            } else if (lower.includes('internet') || lower.includes('vlan10')) {
                internetIp = ipv4?.address;
                this.log(
                    `IP check: Internet VLAN interface "${name}" -> ${
                        internetIp ?? 'no IPv4'
                    }`
                );
            }

            // Tailscale: by name or by IP range (100.64.0.0/10)
            if (
                lower.includes('tailscale') ||
                (ipv4 && isTailscaleIp(ipv4.address))
            ) {
                tailscaleFound = true;
                tailscaleIp = ipv4?.address;
                this.log(
                    `IP check: Tailscale interface "${name}" -> ${
                        tailscaleIp ?? 'no IPv4'
                    }`
                );
            }
        });

        // --- Field VLAN ---
        const addFieldIssue = (msg: string) => {
            if (isFrcSeason) errors.push(msg);
            else warnings.push(msg);
        };

        if (!fieldIp) {
            addFieldIssue('Field VLAN is disconnected or not found.');
        } else if (isSelfAssigned(fieldIp)) {
            addFieldIssue(
                `Field VLAN has a self-assigned IP (${fieldIp}). Check cable or DHCP.`
            );
        } else if (!isInSubnet(fieldIp, '10.0.100.0', 24)) {
            addFieldIssue(
                `Field VLAN IP (${fieldIp}) is not in the expected 10.0.100.0/24 range.`
            );
        }

        // --- AV VLAN ---
        if (!avIp) {
            errors.push('AV VLAN is disconnected or not found.');
        } else if (isSelfAssigned(avIp)) {
            errors.push(
                `AV VLAN has a self-assigned IP (${avIp}). Check cable or static IP config.`
            );
        } else if (!isInSubnet(avIp, '192.168.25.0', 24)) {
            errors.push(
                `AV VLAN IP (${avIp}) is not in the expected 192.168.25.0/24 range.`
            );
        }

        // --- Internet VLAN ---
        if (internetIp) {
            if (isSelfAssigned(internetIp)) {
                errors.push(
                    `Internet VLAN has a self-assigned IP (${internetIp}). Check cable or DHCP.`
                );
            } else if (!isInSubnet(internetIp, '172.16.0.0', 12)) {
                warnings.push(
                    `Internet VLAN IP (${internetIp}) is not in the expected 172.16.0.0/12 range.`
                );
            }
        }

        // --- Tailscale ---
        if (!tailscaleFound) {
            warnings.push(
                'Tailscale network adapter not found or disconnected.'
            );
        } else if (!tailscaleIp || isSelfAssigned(tailscaleIp)) {
            warnings.push(
                `Tailscale has a self-assigned IP (${
                    tailscaleIp ?? 'unknown'
                }). Check Tailscale connection.`
            );
        }

        this.log(
            `IP check result: ${errors.length} error(s), ${warnings.length} warning(s)`
        );
        if (errors.length)
            this.log(`IP check errors: ${errors.join(' | ')}`, 'err');
        if (warnings.length)
            this.log(`IP check warnings: ${warnings.join(' | ')}`);

        return { errors, warnings };
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
