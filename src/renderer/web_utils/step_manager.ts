export function storeStep(step: number) {
    window.electron.ipcRenderer.sendMessage('steps:set', [step]);
}

export function getStep(): Promise<number> {
    return new Promise((resolve) => {
        window.electron.ipcRenderer.once<number>(
            'steps:get',
            (step: number) => {
                resolve(step);
            }
        );

        window.electron.ipcRenderer.sendMessage('steps:get', []);
    });
}
