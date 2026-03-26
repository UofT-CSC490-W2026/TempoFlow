import { render, screen } from '@testing-library/react';
import React from 'react';

import Home from './page';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement('a', { href, ...props }, children),
}));

describe('Home page', () => {
  it('renders the main call-to-action links', () => {
    render(React.createElement(Home));

    expect(screen.getByRole('heading', { name: 'TempoFlow' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start session/i })).toHaveAttribute('href', '/upload');
    expect(screen.getByRole('link', { name: /open dashboard/i })).toHaveAttribute('href', '/dashboard');
  });

  it('highlights the local-first practice flow', () => {
    render(React.createElement(Home));

    expect(screen.getByText(/local-first mode/i)).toBeInTheDocument();
    expect(
      screen.getByText(/upload a reference clip and your practice clip/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/made for dancers, by dancers/i)).toBeInTheDocument();
  });
});
