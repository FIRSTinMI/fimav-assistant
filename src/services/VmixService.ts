import log from 'electron-log';
import { invokeExpectResponse } from '../main/window_components/signalR';
import { getStore } from '../main/store';
import { XMLParser } from 'fast-xml-parser';

type VmixSettings = {
    baseUrl: string;
    username: string;
    password: string;
};

export default class VmixService {
    private static instance: VmixService;

    private settings: VmixSettings;

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

    async SetStreamInfo(): Promise<void> {
        type StreamInfo = {
            index: number;
            rtmpUrl: string;
            rtmpKey: string;
        };

        log.info('Setting stream info');

        const streamInfo: StreamInfo[] = await invokeExpectResponse(
            'GetStreamInfo',
            'StreamInfo'
        );
        log.info(streamInfo);

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

        await Promise.all(
            [0, 1, 2].map((idx) =>
                setStreamInfo(
                    streamInfo.find((info) => info.index === idx) ?? {
                        index: idx,
                        rtmpUrl: '',
                        rtmpKey: '',
                    }
                )
            )
        );
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

    public static get Instance(): VmixService {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
