type VmixSettings = {
    baseUrl: string;
    username: string;
    password: string;
};

export default class VmixRecordingService {
    private settings: VmixSettings;

    /**
     *
     */
    constructor(settings: VmixSettings) {
        this.settings = settings;
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

    async AddBrowserInput(url: string): Promise<void> {
        await fetch(
            `${this.settings.baseUrl}?Function=AddInput&Value=Browser|${url}`,
            {
                headers: this.createHeaders(),
            }
        );
    }

    async GetInputs(): Promise<string> {
        const response = await fetch(`${this.settings.baseUrl}`, {
            headers: this.createHeaders(),
        });
        return await response.text();
    }

    async RenameInput(guid: string, name: string): Promise<void> {
        await fetch(
            `${this.settings.baseUrl}?Function=SetInputName&Input=${guid}&Value=${name}`,
            {
                headers: this.createHeaders(),
            }
        );
    }
}
