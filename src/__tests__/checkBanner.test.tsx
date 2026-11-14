import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import CheckBanner from '../renderer/components/CheckBanner';
import { CheckResult } from '../models/Checks';

let list: CheckResult[] = [];
jest.mock('../renderer/hooks/checks', () => ({
    __esModule: true,
    default: () => list,
    ignoreCheck: jest.fn(),
    fixCheck: jest.fn(),
}));
jest.mock('../renderer/components/ChecksDialog', () => ({
    openChecks: jest.fn(),
}));

const check = (id: string, state: CheckResult['state']): CheckResult => ({
    id,
    group: 'Stream',
    label: id,
    state,
    detail: `${id} detail`,
    ignoredUntil: null,
    fix: null,
    doc: null,
    hint: null,
});

describe('check banner', () => {
    it('three problems: three bars', () => {
        list = [
            check('a', 'warning'),
            check('b', 'warning'),
            check('c', 'critical'),
        ];
        render(<CheckBanner />);
        expect(screen.getAllByText(/detail$/)).toHaveLength(3);
        expect(screen.queryByText(/more problems/)).toBeNull();
    });

    it('four problems: the two worst, then +2 more', () => {
        list = [
            check('a', 'warning'),
            check('b', 'warning'),
            check('c', 'critical'),
            check('d', 'warning'),
        ];
        render(<CheckBanner />);
        expect(
            screen.getAllByText(/detail$/).map((e) => e.textContent)
        ).toEqual(['c detail', 'a detail']);
        expect(
            screen.getByText(/\+2 more problems detected/)
        ).toBeInTheDocument();
    });
});
