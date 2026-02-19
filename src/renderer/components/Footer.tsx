import { Typography } from 'antd';
import {
    CheckCircleOutlined,
    CloseCircleOutlined,
    ExclamationCircleOutlined,
    WifiOutlined,
    AudioOutlined,
    CameraOutlined,
    DesktopOutlined,
} from '@ant-design/icons';
import { useContext } from 'react';
import StatusContext from 'renderer/hooks/status_state';
import './Footer.css';

const { Text } = Typography;

interface FooterStatusItemProps {
    ready: boolean;
    icon: ReturnType<typeof WifiOutlined>;
    label: string;
}

function FooterStatusItem({ ready, icon, label }: FooterStatusItemProps) {
    const stateIcon = ready ? <CheckCircleOutlined /> : <CloseCircleOutlined />;
    const stateClass = ready ? 'footer-icon--ready' : 'footer-icon--error';

    return (
        <span className="footer-item">
            <span className="footer-icon footer-icon--muted">{icon}</span>
            <span className={`footer-icon ${stateClass}`}>{stateIcon}</span>
            <Text className="footer-label">{label}</Text>
        </span>
    );
}

export default function AppFooter() {
    const { status } = useContext(StatusContext);
    const hw = status.hw_stats;

    const ipErrorCount = hw.ip_errors?.length ?? 0;
    const ipWarnCount = hw.ip_warnings?.length ?? 0;

    return (
        <div className="app-footer">
            {/* AutoAV log */}
            <span className="footer-item">
                <Text className="footer-label">
                    AutoAV: {status.auto_av_log ?? 'Unknown'}
                </Text>
            </span>

            <div className="footer-divider" />

            {/* HW status items */}
            <FooterStatusItem
                ready={hw.internet}
                icon={<WifiOutlined />}
                label="Network"
            />
            <FooterStatusItem
                ready={hw.mixer}
                icon={<AudioOutlined />}
                label="Mixer"
            />
            <FooterStatusItem
                ready={hw.camera1 || hw.camera2}
                icon={<CameraOutlined />}
                label="Camera 1"
            />
            <FooterStatusItem
                ready={hw.camera2}
                icon={<CameraOutlined />}
                label="Camera 2"
            />
            <FooterStatusItem
                ready={hw.switch}
                icon={<DesktopOutlined />}
                label="Switch"
            />

            <div className="footer-spacer" />

            {/* IP alert badges — right-aligned */}
            {ipErrorCount > 0 && (
                <span className="footer-alert-badge footer-alert-badge--error">
                    <ExclamationCircleOutlined />
                    <Text>
                        {ipErrorCount} IP{' '}
                        {ipErrorCount === 1 ? 'Error' : 'Errors'}
                    </Text>
                </span>
            )}
            {ipWarnCount > 0 && (
                <span className="footer-alert-badge footer-alert-badge--warning">
                    <ExclamationCircleOutlined />
                    <Text>
                        {ipWarnCount} IP{' '}
                        {ipWarnCount === 1 ? 'Warning' : 'Warnings'}
                    </Text>
                </span>
            )}
        </div>
    );
}
