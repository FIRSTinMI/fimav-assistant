import log from 'electron-log';
import { XMLParser } from 'fast-xml-parser';
import { invokeExpectResponse } from '../main/window_components/signalR';
import { getStore } from '../main/store';

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

        let streamInfo: StreamInfo[] = await invokeExpectResponse(
            'GetStreamInfo',
            'StreamInfo'
        );
        streamInfo = streamInfo.filter(info => info.rtmpKey && info.rtmpUrl);
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

        for (let idx = 0; idx < 3; idx += 1) {
            // We want to overwrite the index from the server so that we always start populating
            // the first stream
            let info = streamInfo[idx];
            if (info) {
                info.index = idx;
            } else {
                info = {
                    index: idx,
                    rtmpUrl: '',
                    rtmpKey: ''
                }
            }
            // We want to explicitly run these operations in order, we cannot make use of parallelization
            // TODO: Promise chain these so we can get out of the loop
            // eslint-disable-next-line no-await-in-loop
            await setStreamInfo(info);
        }
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

    public static get Instance(): VmixService {
        if (!this.instance) this.instance = new this();
        return this.instance;
    }
}
