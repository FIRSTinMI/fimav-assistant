import { Space, Typography } from 'antd';
import HWCheckResponse from 'models/HWCheckResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import StepBar from 'renderer/components/StepBar';

function InternetSetup({ nextStep, previousStep }: Steppable) {
    const [errors, setErrors] = useState<string[]>([]);
    const [ready, setReady] = useState<boolean>(false);

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.once<HWCheckResponse>(
            'hwcheck-response',
            (arg: HWCheckResponse) => {
                setErrors(arg.errors);
                setReady(true);
            }
        );
        window.electron.ipcRenderer.sendMessage('hwcheck', []);
    }, []); // only run once

    return (
        <>
            <Space
                direction="vertical"
                style={{ textAlign: 'center', width: '100%' }}
            >
                <Typography.Title level={1}>
                    Venue Internet Setup
                </Typography.Title>

                <Typography.Text>
                    Please plug in the venue ethernet into port <b>1</b> on the
                    Switch on the rear of the AV Cart (Upper-left most port)
                </Typography.Text>

                <Typography.Text>
                    <ReadyHandler
                        ready={ready ? ReadyState.Ready : ReadyState.NotReady}
                    />{' '}
                    Waiting for Internet...
                </Typography.Text>

                {errors && errors.length > 0 && (
                    <>
                        <Typography.Text>
                            Don&apos;t worry about any errors below. We&apos;ll help you
                            get these resolved soon!
                        </Typography.Text>
                        {errors.map((error) => (
                            <Typography.Text type="danger">
                                {error}
                            </Typography.Text>
                        ))}
                    </>
                )}
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showNext
                showPrev
                nextDisabled={!ready}
            />
        </>
    );
}

export default InternetSetup;
