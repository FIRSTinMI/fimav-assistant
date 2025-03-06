import log from 'electron-log';
import { XMLParser } from 'fast-xml-parser';
import EventEmitter from 'events';
import { EquipmentLogCategory, EquipmentLogType } from '../models/EquipmentLog';
import { invokeLog } from '../main/window_components/signalR';
import { getStore } from '../main/store';

type VmixSettings = {
    baseUrl: string;
    username: string;
    password: string;
};

type StreamInfo = {
    index: number;
    rtmpUrl: string;
    rtmpKey: string;
};

export default class VmixService {
    private static instance: VmixService;

    private settings: VmixSettings;

    private emitter = new EventEmitter();

    constructor(settings?: VmixSettings) {
        if (settings) {
            this.settings = settings;
        } else {
            this.settings = getStore().get('vmixApi');
        }
    }

    updateSettings(settings: VmixSettings): void {
        this.settings = settings;
    }

    private createHeaders(): HeadersInit | undefined {
        if (this.settings.username && this.settings.password) {
            return {
                Authorization: `Basic ${Buffer.from(
                    `${this.settings.username}:${this.settings.password}`
                ).toString('base64')}`,
            };
        }
        return undefined;
    }

    async StartRecording(): Promise<void> {
        await fetch(`${this.settings.baseUrl}?Function=StartRecording`, {
            headers: this.createHeaders(),
        });
    }

    async StopRecording(): Promise<void> {
        await fetch(`${this.settings.baseUrl}?Function=StopRecording`, {
            headers: this.createHeaders(),
        });
    }

    async StartStream(streamNumber?: number): Promise<void> {
        ;
        const rsp = await fetch(
            `${this.settings.baseUrl}?Function=StartStreaming&Value=${streamNumber ?? ''}`,
            {
                headers: this.createHeaders(),
            }
        );

        if (!rsp.ok) {
            throw new Error(`Failed to start stream: ${await rsp.text()}`);
        }
    }

    async StopStream(streamNumber?: number): Promise<void> {
        ;
        const rsp = await fetch(
            `${this.settings.baseUrl}?Function=StopStreaming&Value=${streamNumber ?? ''}`,
            {
                headers: this.createHeaders(),
            }
        );

        if (!rsp.ok) {
            throw new Error(`Failed to stop stream: ${await rsp.text()}`);
        }
    }

    async SetStreamInfo(sInfo: StreamInfo[]): Promise<void> {
        const totalSupportedStreams = 3;
        const streamInfo = sInfo.filter(info => info.rtmpKey && info.rtmpUrl);

        // whatever index 0-totalSupportedStreams is missing we'll add it
        if (streamInfo.length < totalSupportedStreams) {
            for (let i = 0; i < totalSupportedStreams; i += 1) {
                if (!streamInfo.find(info => info.index === i)) {
                    streamInfo.push({
                        index: i,
                        rtmpUrl: '',
                        rtmpKey: ''
                    });
                }
            }
        }

        log.info(streamInfo);
        invokeLog(`Setting ${streamInfo.length} streams in vMix`, { 
            category: EquipmentLogCategory.Vmix_General, 
            extraInfo: { payloads: streamInfo.map(k => ({ i: k.index, url: k.rtmpUrl })) }, 
            severity: EquipmentLogType.Info 
        });

        const setStreamInfo = async (info: StreamInfo): Promise<void> => {
            info.rtmpUrl ??= '';
            info.rtmpKey ??= '';

            await fetch(
                `${this.settings.baseUrl}?Function=StreamingSetURL&Value=${info.index},${info.rtmpUrl}`,
                {
                    headers: this.createHeaders(),
                }
            );
            await fetch(
                `${this.settings.baseUrl}?Function=StreamingSetKey&Value=${info.index},${info.rtmpKey}`,
                {
                    headers: this.createHeaders(),
                }
            );
        };

        const chain = streamInfo.reduce(async (prev, info) => {
            await prev;
            return setStreamInfo(info);
        }, Promise.resolve());

        chain.then(() => {
            this.emitter.emit('streamInfoUpdated', true);
            return null;
        }).catch((err) => {
            this.emitter.emit('streamInfoUpdated', false);
            log.error('Failed to set stream info', err);
        });

        return chain;
    }

    async AddBrowserInput(url: string): Promise<void> {
        await fetch(
            `${this.settings.baseUrl}?Function=AddInput&Value=Browser|${url}`,
            {
                headers: this.createHeaders(),
            }
        );
    }

    async RenameInput(guid: string, name: string): Promise<void> {
        await fetch(
            `${this.settings.baseUrl}?Function=SetInputName&Input=${guid}&Value=${name}`,
            {
                headers: this.createHeaders(),
            }
        );
    }

    async GetBase(): Promise<any> {
        return fetch(`${this.settings.baseUrl}`, {
            headers: this.createHeaders(),
        })
            .then((response) => response.text())
            .then((xml) => {
                // Parse XML
                return new XMLParser({
                    ignoreAttributes: false,
                    attributeNamePrefix: '',
                }).parse(xml);
            });
    }

    async GetCurrentRecording(): Promise<string> {
        return this.GetBase().then((parsed) => {
            return parsed.vmix.recording.filename1;
        });
    }

    async isRecording(): Promise<boolean> {
        return this.GetBase().then((parsed) => {
            return parsed.vmix.recording['#text'] === 'True';
        });
    }

    getUrl(): string {
        return this.settings.baseUrl;
    }

    get events(): EventEmitter {
        return this.emitter;
    }

    public static get Instance(): VmixService {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
