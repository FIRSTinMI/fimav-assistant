import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown,
    apiKey: unknown
};

export function createStore(): Store<AppConfig> {
    return new Store({
        schema: {
            signalrUrl: {
                type: 'string',
                default: 'https://fim-admin.evandoes.dev/AssistantHub'
            },
            apiKey: {
                type: 'string'
            }
        }
    });
}