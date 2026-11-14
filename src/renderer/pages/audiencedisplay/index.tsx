import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Modal, message } from 'antd';
import { AutoAVStatus } from 'models/AutoAVStatus';
import AddonControlRow from '../../components/AddonControlRow';
import { useLifecycleBusy, useOneShot } from '../../hooks/ipc_busy';
import './index.css';
import { AddonPhase } from '../../../models/AddonPhase';

interface AudienceDisplayStatus {
    running: boolean;
    phase?: AddonPhase;
    version: string;
}

interface UpdateInfo {
    current: string;
    latest: string;
    updateAvailable: boolean;
}

// The display's own operator page (profile, vMix setup, playoff config).
const PAGE_URL = 'http://127.0.0.1:3001/';

const poll = () =>
    window.electron?.ipcRenderer.sendMessage('audienceDisplay:getStatus', []);

export default function AudienceDisplayPage() {
    const [status, setStatus] = useState<AudienceDisplayStatus | null>(null);
    const running = !!status?.running;
    const { busy, begin } = useLifecycleBusy(running);
    const oneShot = useOneShot();
    // The custom display only runs when Settings picks it over the FMS one.
    // null until the first status, so the blocked state never flashes.
    const [selected, setSelected] = useState<boolean | null>(null);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on(
            'audienceDisplay:status',
            (s: AudienceDisplayStatus) => setStatus(s)
        );
        const offAutoav = ipcRenderer.on('autoav:status', (s: AutoAVStatus) =>
            setSelected(s.frcAudienceDisplay === 'customAd')
        );
        ipcRenderer.sendMessage('autoav:getState', []);
        poll();
        return () => {
            off();
            offAutoav();
        };
    }, []);

    const restart = useCallback(() => {
        begin('restart');
        window.electron?.ipcRenderer.sendMessage('audienceDisplay:restart', []);
    }, [begin]);

    const stop = useCallback(() => {
        begin('stop');
        window.electron?.ipcRenderer.sendMessage('audienceDisplay:stop', []);
    }, [begin]);

    // Version click: check for updates; toast if latest, confirm if not.
    const checkUpdate = useCallback(() => {
        oneShot<UpdateInfo>(
            'audienceDisplay:updateInfo',
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
                            'audienceDisplay:update',
                            []
                        );
                    },
                });
            },
            () =>
                window.electron?.ipcRenderer.sendMessage(
                    'audienceDisplay:checkUpdate',
                    []
                ),
            () => message.error('Failed: no reply')
        );
    }, [oneShot, begin]);

    return (
        <div className="ad-page">
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
                disabled={selected !== true}
            />
            <div className="ad-frame">
                {running && <iframe title="Audience display" src={PAGE_URL} />}
                {!running && selected && (
                    <Empty description="Stopped" style={{ marginTop: 64 }} />
                )}
                {!running && selected === false && (
                    <Empty
                        description="Custom AD off"
                        style={{ marginTop: 64 }}
                    >
                        <Button
                            type="primary"
                            onClick={() =>
                                window.electron?.ipcRenderer.sendMessage(
                                    'app:requestOpenSettings',
                                    []
                                )
                            }
                        >
                            Settings
                        </Button>
                    </Empty>
                )}
            </div>
        </div>
    );
}
