import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, message } from 'antd';
import AddonControlRow from '../../components/AddonControlRow';
import './index.css';

interface LiveCaptionsStatus {
    running: boolean;
    version: string;
}

const SETTINGS_URL = 'http://localhost:3000/settings.html';

export default function LiveCaptionsPage() {
    const [status, setStatus] = useState<LiveCaptionsStatus | null>(null);
    const [busy, setBusy] = useState(false);

    // Subscribe to status and poll it while the tab is mounted.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'liveCaptions:status',
            (s: LiveCaptionsStatus) => {
                setStatus(s);
                setBusy(false);
            }
        );
        const poll = () =>
            ipcRenderer.sendMessage('liveCaptions:getStatus', []);
        poll();
        const timer = setInterval(poll, 3000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, []);

    const restart = useCallback(() => {
        setBusy(true);
        // The main process only reports running once the server actually answers
        // on :3000, so the iframe (mounted on running) loads a live server, not
        // a blank one. No blind reload timer needed.
        window.electron?.ipcRenderer.sendMessage('liveCaptions:restart', []);
    }, []);

    // Version click → check for updates; toast if latest, confirm dialog if not.
    const checkUpdate = useCallback(() => {
        if (!window.electron) return;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'liveCaptions:updateInfo',
            (info: {
                current: string;
                latest: string;
                updateAvailable: boolean;
            }) => {
                off();
                if (!info.updateAvailable) {
                    message.success(
                        `Live Captions is up to date (v${info.current})`
                    );
                    return;
                }
                Modal.confirm({
                    title: 'Update Live Captions?',
                    content: `A new version is available (v${info.current} → v${info.latest}). Updating now restarts Live Captions and will briefly interrupt captions.`,
                    okText: 'Update now',
                    cancelText: 'Not now',
                    onOk: () => {
                        setBusy(true);
                        ipcRenderer.sendMessage('liveCaptions:update', []);
                        message.info('Updating Live Captions');
                    },
                });
            }
        );
        ipcRenderer.sendMessage('liveCaptions:checkUpdate', []);
    }, []);

    const stop = useCallback(() => {
        setBusy(true);
        window.electron?.ipcRenderer.sendMessage('liveCaptions:stop', []);
    }, []);

    const running = !!status?.running;

    return (
        <div className="livecaptions-page">
            <AddonControlRow
                running={running}
                version={status?.version}
                onVersionClick={checkUpdate}
                versionTooltip="Click to check for updates"
                onStart={restart}
                onRestart={restart}
                onStop={stop}
                busy={busy}
            />

            <div className="livecaptions-frame">
                {running ? (
                    <iframe title="Live Captions settings" src={SETTINGS_URL} />
                ) : (
                    <Empty
                        description="Live Captions is stopped. Press Start to launch it and load its settings."
                        style={{ marginTop: 64 }}
                    />
                )}
            </div>
        </div>
    );
}
