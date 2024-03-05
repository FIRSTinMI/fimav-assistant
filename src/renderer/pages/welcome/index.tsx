import { useEffect, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { Space } from 'antd';
import Button from 'antd/es/button';
import Typography from 'antd/es/typography';
import { useNavigate } from 'react-router-dom';
import { storeStep } from 'renderer/web_utils/step_manager';
import Event from '../../../models/Event';
import FiMLogo from '../../../../assets/fim_logo.png';

function Welcome() {
    const nav = useNavigate();

    const [currentEvent, setCurrentEvent] = useState<Event | null>(null);

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.on('new-event-info', (events: Event[]) => {
            const current = events.filter(
                (e) =>
                    new Date(e.start) <= new Date() &&
                    new Date(e.end) >= new Date()
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
        <Space direction="vertical" style={{ textAlign: 'center' }}>
            <img
                className="logo-bounce"
                src={FiMLogo}
                style={{ width: '30%', height: '30%' }}
                alt="FIRST in Michigan logo"
            />
            <Typography.Title level={1} style={{ marginTop: 0 }}>
                Welcome!
            </Typography.Title>
            <Typography.Title level={5}>
                Thank you for signing up to volunteer as AV for{' '}
                {currentEvent?.name ?? 'FIRST in Michigan'}
            </Typography.Title>

            <Button type="primary" size="large" onClick={handleNext}>
                Let&apos;s Get Started{' '}
                <RightOutlined className="btn-icon-bounce" />
            </Button>
        </Space>
    );
}

export default Welcome;
