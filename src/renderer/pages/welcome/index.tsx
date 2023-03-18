import { RightOutlined } from "@ant-design/icons";
import { Space } from "antd";
import Button from "antd/es/button";
import Typography from "antd/es/typography";
import { useNavigate } from "react-router-dom";
import FiMLogo from "../../../../assets/fim_logo.png"


const Welcome = () => {
    
    const nav = useNavigate();

    const handleNext = () => {
        nav('/step/1');
    }

    return (
        <Space direction="vertical" style={{textAlign: "center"}}>
            <img className="logo-bounce" src={FiMLogo} style={{width: '30%', height: '30%'}} />
            <Typography.Title level={1} style={{marginTop: 0}}>Welcome!</Typography.Title>
            <Typography.Title level={5}>Thank you for signing up to voluenteer as AV for [insert event name here]</Typography.Title>

            <Button type="primary" size={"large"} onClick={handleNext}>Let's Get Started <RightOutlined className={'btn-icon-bounce'} /></Button>
        </Space>
    )
}

export default Welcome;