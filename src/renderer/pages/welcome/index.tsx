import { useEffect, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { Button, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { storeStep } from 'renderer/web_utils/step_manager';
import StepManager from '../../components/StepManager';
import Event from '../../../models/Event';
import FiMLogo from '../../../../assets/fim_logo.png';
import './index.css';

const { Title } = Typography;

function Welcome() {
    const nav = useNavigate();

    const [currentEvent, setCurrentEvent] = useState<Event | null>(null);

    useEffect(() => {
        window.electron.ipcRenderer.on('new-event-info', (events: Event[]) => {
            const current = events.filter(
                (e) =>
                    new Date(e.startTime) <= new Date() &&
                    new Date(e.endTime) >= new Date()
            );
            if (current.length > 0) {
                setCurrentEvent(current[0]);
            }
        });
        window.electron.ipcRenderer.sendMessage('event-info', []);
    }, []);

    const handleNext = () => {
        storeStep(1);
        nav('/step/1');
    };

    return (
        <>
            <StepManager />
            <Space direction="vertical" className="welcome-page">
                <img
                    className="logo-bounce welcome-logo"
                    src={FiMLogo}
                    alt="FIRST in Michigan logo"
                />
                <Title level={1} className="welcome-title">
                    Welcome!
                </Title>
                <Title level={5} className="welcome-subtitle">
                    Thank you for signing up to volunteer as AV for{' '}
                    {currentEvent?.name ?? 'FIRST in Michigan'}
                </Title>

                <Button type="primary" size="large" onClick={handleNext}>
                    Let&apos;s Get Started{' '}
                    <RightOutlined className="btn-icon-bounce" />
                </Button>
            </Space>
        </>
    );
}

export default Welcome;
