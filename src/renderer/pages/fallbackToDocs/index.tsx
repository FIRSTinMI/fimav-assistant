import { Space, Typography, Button, List } from "antd";
import HWPingResponse from "models/HWPingResponse";
import { Steppable } from "models/steppable";
import { useEffect, useState } from "react";
import ReadyHandler, { ReadyState } from "renderer/components/ReadyHandler";
import StepBar from "../../components/StepBar";

function FallbackToDocs({ nextStep, previousStep }: Steppable) {

    const [hw, setHw] = useState<HWPingResponse>({
        camera1: false,
        camera2: false,
        mixer: false,
        switch: false,
        internet: false,
        errors: [],
    });

    useEffect(() => {
        // We ping for this every 10 seconds, so we want to consistantly listen for it
        window.electron.ipcRenderer.on('hw-change', setHw);

        // This forces IPC to send us the current status
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []);

    return (
        <>
            <Space
                direction="vertical"
                size="large"
                style={{ textAlign: 'center', width: '100%' }}
            >
                <Typography.Title level={1}>
                    Check Out the Documentation
                </Typography.Title>

                <Typography.Text>
                    The FiM AV Docs can help you finish setting up your event.
                    Click the button below to visit them:
                </Typography.Text>

                <Button type="primary" href="https://docs.fimav.us/docs/day--1-and-0/" target="_blank">Visit the Docs</Button>

                <Typography.Title level={3} style={{ marginBottom: 0 }}>
                    HW Status:
                </Typography.Title>

                <List>
                    <List.Item>
                        <ReadyHandler ready={hw.camera1 ? ReadyState.Ready : ReadyState.Error} /> Camera 1
                    </List.Item>
                    <List.Item>
                        <ReadyHandler ready={hw.camera2 ? ReadyState.Ready : ReadyState.Error} /> Camera 2
                    </List.Item>
                    <List.Item>
                        <ReadyHandler ready={hw.mixer ? ReadyState.Ready : ReadyState.Error} /> Mixer
                    </List.Item>
                    <List.Item>
                        <ReadyHandler ready={hw.switch ? ReadyState.Ready : ReadyState.Error} /> Switch
                    </List.Item>
                    <List.Item>
                        <ReadyHandler ready={hw.internet ? ReadyState.Ready : ReadyState.Error} /> Internet
                    </List.Item>
                </List>
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showPrev
            />
        </>
    );
}

export default FallbackToDocs;