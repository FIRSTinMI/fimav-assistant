import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Badge } from 'antd';
import {
    BellOutlined,
    MessageOutlined,
    RobotOutlined,
    SettingOutlined,
    VideoCameraOutlined,
} from '@ant-design/icons';
import AlertsResponse from 'models/AlertsResponse';
import './TabBar.css';

interface TabDef {
    key: string;
    label: string;
    icon: ReactNode;
    isActive: (_pathname: string) => boolean;
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
        label: 'vMix',
        icon: <VideoCameraOutlined />,
        isActive: (p) => p.startsWith('/vmix'),
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
];

export default function TabBar() {
    const nav = useNavigate();
    const { pathname } = useLocation();
    const [alertCount, setAlertCount] = useState(0);

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
            {tabs.map((t) => {
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
