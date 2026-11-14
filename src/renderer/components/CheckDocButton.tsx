import { Button, Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { CheckResult } from '../../models/Checks';

// Opens the docs.fimav.us page for this check in the browser.
export default function CheckDocButton({ check }: { check: CheckResult }) {
    if (!check.doc) return null;
    return (
        <Tooltip title="Docs">
            <Button
                size="small"
                icon={<QuestionCircleOutlined />}
                href={check.doc}
                target="_blank"
                aria-label="Docs"
            />
        </Tooltip>
    );
}
