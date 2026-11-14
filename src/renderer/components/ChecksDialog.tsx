import { useEffect, useState } from 'react';
import { Modal } from 'antd';
import ChecksList from './ChecksList';

// The Checks list, opened from "Checks" in the menu bar, the banner or a
// check notification.
export default function ChecksDialog() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const show = () => setOpen(true);
        window.addEventListener('fimav:openChecks', show);
        const off = window.electron?.ipcRenderer.on('app:openChecks', show);
        return () => {
            window.removeEventListener('fimav:openChecks', show);
            off?.();
        };
    }, []);
    return (
        <Modal
            title="Checks"
            open={open}
            onCancel={() => setOpen(false)}
            footer={null}
            width={900}
            destroyOnClose
        >
            <ChecksList />
        </Modal>
    );
}

export const openChecks = () =>
    window.dispatchEvent(new Event('fimav:openChecks'));
