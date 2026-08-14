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
        const rsp = await fetch(
            `${this.settings.baseUrl}?Function=StartStreaming&Value=${
                streamNumber ?? ''
            }`,
            {
                headers: this.createHeaders(),
            }
        );

        if (!rsp.ok) {
            throw new Error(`Failed to start stream: ${await rsp.text()}`);
        }
    }

    async StopStream(streamNumber?: number): Promise<void> {
        const rsp = await fetch(
            `${this.settings.baseUrl}?Function=StopStreaming&Value=${
                streamNumber ?? ''
            }`,
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
        const streamInfo = sInfo.filter((info) => info.rtmpKey && info.rtmpUrl);

        // whatever index 0-totalSupportedStreams is missing we'll add it
        if (streamInfo.length < totalSupportedStreams) {
            for (let i = 0; i < totalSupportedStreams; i += 1) {
                if (!streamInfo.find((info) => info.index === i)) {
                    streamInfo.push({
                        index: i,
                        rtmpUrl: '',
                        rtmpKey: '',
                    });
                }
            }
        }

        log.info(streamInfo);
        invokeLog(`Setting ${streamInfo.length} streams in vMix`, {
            category: EquipmentLogCategory.Vmix_General,
            extraInfo: {
                payloads: streamInfo.map((k) => ({
                    i: k.index,
                    url: k.rtmpUrl,
                })),
            },
            severity: EquipmentLogType.Info,
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

        chain
            .then(() => {
                this.emitter.emit('streamInfoUpdated', true);
                return null;
            })
            .catch((err) => {
                this.emitter.emit('streamInfoUpdated', false);
                log.error('Failed to set stream info', err);
            });

        return chain;
    }

    // List inputs (key + number + title + type) for pickers like the alliance
    // composite camera selector.
    async GetInputs(): Promise<
        { key: string; number: number; title: string; type: string }[]
    > {
        const parsed = await this.GetBase();
        const raw = parsed?.vmix?.inputs?.input;
        const list = Array.isArray(raw) ? raw : [raw].filter(Boolean);
        return list.map((i: any) => ({
            key: i.key,
            number: Number(i.number),
            title: i.title,
            type: i.type,
        }));
    }

    private vmixCall(inputKey: string, fn: string, value: string) {
        return fetch(
            `${this.settings.baseUrl}?Function=${fn}&Input=${encodeURIComponent(
                inputKey
            )}&Value=${encodeURIComponent(value)}`,
            { headers: this.createHeaders() }
        );
    }

    async AddColourInput(): Promise<void> {
        // vMix needs the pipe + hex colour: "Colour|#RRGGBB". Bare "Colour" is
        // rejected and silently adds nothing.
        await fetch(
            `${this.settings.baseUrl}?Function=AddInput&Value=${encodeURIComponent(
                'Colour|#000000'
            )}`,
            { headers: this.createHeaders() }
        );
    }

    // Create (or reuse) a dedicated "Alliance Selection Composite" input built
    // the way the custom AD does it: a blank colour input as the base (layer 0),
    // the EXISTING FMS/audience-display input as layer 1 (full frame), and the
    // selected camera as layer 2, positioned at the alliance-selection camera
    // box. The operator's own FMS/camera inputs are referenced as layers, not
    // duplicated. vMix 27+ SetLayer<N>Zoom/PanX/PanY does the positioning.
    async CreateAllianceComposite(
        fmsKey: string,
        cameraKey: string,
        zoom: number,
        panX: number,
        panY: number
    ): Promise<string> {
        const NAME = 'Alliance Selection Composite';
        let inputs = await this.GetInputs();
        let comp = inputs.find((i) => i.title === NAME);

        if (!comp) {
            const before = new Set(inputs.map((i) => i.key));
            await this.AddColourInput();
            // vMix registers the new input asynchronously; poll briefly for it.
            let added;
            for (let attempt = 0; attempt < 6 && !added; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    setTimeout(resolve, 300);
                });
                // eslint-disable-next-line no-await-in-loop
                inputs = await this.GetInputs();
                added = inputs.find((i) => !before.has(i.key));
            }
            if (!added)
                throw new Error(
                    'vMix did not add the colour input (check the vMix API is reachable)'
                );
            await this.RenameInput(added.key, NAME);
            inputs = await this.GetInputs();
            comp = inputs.find((i) => i.title === NAME) ?? added;
        }
        if (!comp) throw new Error('Could not create the composite input');

        // Assign the layers. SetMultiViewOverlay places an input onto a layer of
        // the target input (Value = "<layer>,<inputKey>"); MultiViewOverlay is
        // only a visibility toggle and takes just the layer number, which is why
        // the earlier attempt created the input but left it empty.
        // Layer 1 = FMS/AD (full frame), Layer 2 = camera (positioned).
        await this.vmixCall(comp.key, 'SetMultiViewOverlay', `1,${fmsKey}`);
        await this.vmixCall(comp.key, 'SetMultiViewOverlay', `2,${cameraKey}`);
        await this.vmixCall(comp.key, 'SetLayer2Zoom', String(zoom));
        await this.vmixCall(comp.key, 'SetLayer2PanX', String(panX));
        await this.vmixCall(comp.key, 'SetLayer2PanY', String(panY));
        return comp.key;
    }

    // Fetch vMix's configured recording folder so the Auto AV tab can show the
    // exact save path before any recording. vMix reports the record destination
    // as recording.filename1 (the directory it will write into).
    async GetRecordingFolder(): Promise<string | null> {
        const parsed = await this.GetBase();
        const rec = parsed?.vmix?.recording;
        // Attributes surface as properties (attributeNamePrefix: '').
        const file = rec?.filename1 ?? rec?.filename ?? rec?.setup;
        if (typeof file === 'string' && file.trim()) {
            const idx = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
            return idx > 0 ? file.slice(0, idx) : file;
        }
        return null;
    }

    // Reload a browser input by its (renamed) title, e.g. after live-captions
    // updated so the embedded page picks up the new build.
    async ReloadBrowserInput(name: string): Promise<void> {
        await fetch(
            `${this.settings.baseUrl}?Function=BrowserReload&Input=${encodeURIComponent(
                name
            )}`,
            { headers: this.createHeaders() }
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

    async SetInputAudioAlwaysOn(guid: string): Promise<void> {
        // Don't mix on transition in/out
        await fetch(
            `${this.settings.baseUrl}?Function=AudioAutoOff&Input=${guid}`,
            {
                headers: this.createHeaders(),
            }
        );
        // Ensure unmuted
        await fetch(`${this.settings.baseUrl}?Function=AudioOn&Input=${guid}`, {
            headers: this.createHeaders(),
        });
    }

    // Add a browser input pointing at the given URL, then rename the freshly
    // created input (vMix titles it "Browser <host>"). Returns the input key,
    // or null if it couldn't be found afterwards.
    private async addBrowserInputNamed(
        url: string,
        host: string,
        name: string
    ): Promise<string | null> {
        await this.AddBrowserInput(url);
        const parsed = await this.GetBase();
        const inputs = parsed?.vmix?.inputs?.input;
        const list = Array.isArray(inputs) ? inputs : [inputs].filter(Boolean);
        const match = list.find(
            (input: any) =>
                input?.type === 'Browser' &&
                input?.title === `Browser ${host}`
        );
        if (!match) return null;
        await this.RenameInput(match.key, name);
        return match.key;
    }

    async AddLiveCaptionsInput(): Promise<void> {
        const key = await this.addBrowserInputNamed(
            'http://127.0.0.1:3000/',
            '127.0.0.1',
            'Live Captions'
        );
        if (!key) throw new Error('Could not find the new Live Captions input');
    }

    async AddAudienceDisplayInput(): Promise<void> {
        const key = await this.addBrowserInputNamed(
            'http://10.0.100.5/AudienceDisplay',
            '10.0.100.5',
            'Audience Display'
        );
        if (!key)
            throw new Error('Could not find the new Audience Display input');
        await this.SetInputAudioAlwaysOn(key);
    }

    async GetBase(): Promise<any> {
        return fetch(`${this.settings.baseUrl}`, {
            headers: this.createHeaders(),
            signal: AbortSignal.timeout(5_000),
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

    async isStreaming(): Promise<boolean> {
        return this.GetBase().then((parsed) => {
            // vMix reports streaming the same shape as recording. It exposes
            // on/off only - never the key/URL or bandwidth.
            const s = parsed?.vmix?.streaming;
            if (s === undefined || s === null) return false;
            const text = typeof s === 'object' ? s['#text'] : s;
            return text === 'True' || text === true;
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
