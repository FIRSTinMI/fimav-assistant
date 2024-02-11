import { Space, Typography, Button } from "antd";
import { Steppable } from "models/steppable";
import StepBar from "renderer/components/StepBar";

function FallbackToDocs({ nextStep, previousStep }: Steppable) {
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