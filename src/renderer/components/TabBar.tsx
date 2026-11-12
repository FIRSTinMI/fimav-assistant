import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Badge } from 'antd';
import {
    BellOutlined,
    AppstoreOutlined,
    DesktopOutlined,
    MessageOutlined,
    RobotOutlined,
    SettingOutlined,
    VideoCameraOutlined,
    YoutubeFilled,
} from '@ant-design/icons';
import AlertsResponse from 'models/AlertsResponse';
import { AutoAVStatus } from 'models/AutoAVStatus';
import './TabBar.css';

interface TabDef {
    key: string;
    label: string;
    icon: ReactNode;
    isActive: (_pathname: string) => boolean;
    // Shown only when this says so (program / season); always shown if unset
    showIf?: (_s: AutoAVStatus) => boolean;
}

const tabs: TabDef[] = [
    {
        key: '/',
        label: 'Setup',
        icon: <SettingOutlined />,
        isActive: (p) => p === '/' || p.startsWith('/step'),
    },
    {
        key: '/vmix',
        label: 'vMix / X-Air',
        icon: <VideoCameraOutlined />,
        isActive: (p) => p.startsWith('/vmix'),
    },
    {
        key: '/bitfocus',
        label: 'Bitfocus',
        icon: <AppstoreOutlined />,
        isActive: (p) => p.startsWith('/bitfocus'),
    },
    {
        key: '/livecaptions',
        label: 'Live Captions',
        icon: <MessageOutlined />,
        isActive: (p) => p.startsWith('/livecaptions'),
    },
    {
        key: '/autoav',
        label: 'Auto AV',
        icon: <RobotOutlined />,
        isActive: (p) => p.startsWith('/autoav'),
    },
    {
        key: '/upload',
        label: 'Upload',
        icon: <YoutubeFilled />,
        isActive: (p) => p.startsWith('/upload'),
        // Off-season events only, FRC or FTC.
        showIf: (s) => s.uploader,
    },
    {
        key: '/audiencedisplay',
        label: 'Offseason AD',
        icon: <DesktopOutlined />,
        isActive: (p) => p.startsWith('/audiencedisplay'),
        // The custom audience display is FRC off-season only.
        showIf: (s) => s.program === 'frc' && s.season === 'off-season',
    },
];

export default function TabBar() {
    const nav = useNavigate();
    const { pathname } = useLocation();
    const [alertCount, setAlertCount] = useState(0);
    // null until AutoAV reports, so a conditional tab never flashes in.
    const [status, setStatus] = useState<AutoAVStatus | null>(null);

    // Program (FRC / FTC) and season come from AutoAV's status.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('autoav:status', (s: AutoAVStatus) =>
            setStatus(s)
        );
        ipcRenderer.sendMessage('autoav:getState', []);
        return off;
    }, []);

    const shown = (t: TabDef) => !t.showIf || (!!status && t.showIf(status));

    // Leave a page whose tab no longer applies (event turned in-season, or
    // the program changed).
    useEffect(() => {
        if (!status) return;
        if (tabs.some((t) => !shown(t) && t.isActive(pathname))) {
            nav('/autoav');
        }
        // shown reads status, a dep here already.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, pathname, nav]);

    // Subscribe to alerts and poll so the bell reflects unread count.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('alerts:alerts', (resp: AlertsResponse) =>
            setAlertCount(resp?.alerts?.length ?? 0)
        );
        const poll = () => ipcRenderer.sendMessage('alerts:getAlerts', []);
        poll();
        const timer = setInterval(poll, 5000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, []);

    const alertsActive = pathname.startsWith('/alerts');

    return (
        <div className="tab-bar">
            {tabs.filter(shown).map((t) => {
                const active = t.isActive(pathname);
                return (
                    <button
                        key={t.key}
                        type="button"
                        className={`tab-item${
                            active ? ' tab-item--active' : ''
                        }`}
                        onClick={() => nav(t.key)}
                    >
                        <span className="tab-icon">{t.icon}</span>
                        <span>{t.label}</span>
                    </button>
                );
            })}

            <div className="tab-spacer" />

            <button
                type="button"
                title="Notifications"
                className={`tab-item tab-bell${
                    alertsActive ? ' tab-item--active' : ''
                }`}
                onClick={() => nav('/alerts')}
            >
                <Badge dot count={alertCount} offset={[2, -2]}>
                    <BellOutlined className="tab-icon" />
                </Badge>
            </button>
        </div>
    );
}
