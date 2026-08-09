import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SettingOutlined, VideoCameraOutlined } from '@ant-design/icons';
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
        key: '/autoav',
        label: 'Auto AV',
        icon: <VideoCameraOutlined />,
        isActive: (p) => p.startsWith('/autoav'),
    },
];

export default function TabBar() {
    const nav = useNavigate();
    const { pathname } = useLocation();

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
        </div>
    );
}
