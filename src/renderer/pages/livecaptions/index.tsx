import { useCallback, useEffect, useState } from 'react';
import { Empty, Modal, message } from 'antd';
import AddonControlRow from '../../components/AddonControlRow';
import { useLifecycleBusy, useOneShot } from '../../hooks/ipc_busy';
import './index.css';
import { AddonPhase } from '../../../models/AddonPhase';

interface LiveCaptionsStatus {
    running: boolean;
    phase?: AddonPhase;
    version: string;
}

interface UpdateInfo {
    current: string;
    latest: string;
    updateAvailable: boolean;
}

const SETTINGS_URL = 'http://localhost:3000/settings.html';

const poll = () =>
    window.electron?.ipcRenderer.sendMessage('liveCaptions:getStatus', []);

export default function LiveCaptionsPage() {
    const [status, setStatus] = useState<LiveCaptionsStatus | null>(null);
    const running = !!status?.running;
    const { busy, begin } = useLifecycleBusy(running);
    const oneShot = useOneShot();

    // Status: read once, then pushed by the main process on every change.
    useEffect(() => {
        if (!window.electron) return undefined;
        const off = window.electron.ipcRenderer.on(
            'liveCaptions:status',
            (s: LiveCaptionsStatus) => setStatus(s)
        );
        poll();
        return () => {
            off();
        };
    }, []);

    const restart = useCallback(() => {
        begin('restart');
        // The main process only reports running once the server actually answers
        // on :3000, so the iframe (mounted on running) loads a live server, not
        // a blank one. No blind reload timer needed.
        window.electron?.ipcRenderer.sendMessage('liveCaptions:restart', []);
    }, [begin]);

    // Version click → check for updates; toast if latest, confirm dialog if not.
    const checkUpdate = useCallback(() => {
        oneShot<UpdateInfo>(
            'liveCaptions:updateInfo',
            (info) => {
                if (!info.updateAvailable) {
                    message.success(`Up to date (v${info.current})`);
                    return;
                }
                Modal.confirm({
                    title: `Update to v${info.latest}`,
                    content: `v${info.current} → v${info.latest}`,
                    okText: 'Update',
                    cancelText: 'Not now',
                    onOk: () => {
                        begin('restart');
                        window.electron?.ipcRenderer.sendMessage(
                            'liveCaptions:update',
                            []
                        );
                        message.info('Updating');
                    },
                });
            },
            () =>
                window.electron?.ipcRenderer.sendMessage(
                    'liveCaptions:checkUpdate',
                    []
                ),
            () => message.error('Failed: no reply')
        );
    }, [oneShot, begin]);

    const stop = useCallback(() => {
        begin('stop');
        window.electron?.ipcRenderer.sendMessage('liveCaptions:stop', []);
    }, [begin]);

    return (
        <div className="livecaptions-page">
            <AddonControlRow
                running={running}
                phase={status?.phase}
                version={status?.version}
                onVersionClick={checkUpdate}
                versionTooltip="Updates"
                onStart={restart}
                onRestart={restart}
                onStop={stop}
                busy={busy}
            />

            <div className="livecaptions-frame">
                {running ? (
                    <iframe title="Live Captions settings" src={SETTINGS_URL} />
                ) : (
                    <Empty description="Stopped" style={{ marginTop: 64 }} />
                )}
            </div>
        </div>
    );
}
