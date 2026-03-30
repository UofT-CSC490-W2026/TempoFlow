import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Home from './page';

const mockUseSession = vi.fn();
const mockSignOut = vi.fn();

vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('next/image', () => ({
  default: ({
    src,
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string }) =>
    React.createElement('img', { src, alt, ...props }),
}));

describe('Home page', () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({ data: null, status: 'unauthenticated' });
    mockSignOut.mockReset();
  });

  it('renders the main call-to-action links for signed out users', () => {
    render(React.createElement(Home));

    expect(screen.getByRole('heading', { name: 'TempoFlow' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^start$/i })).toHaveAttribute('href', '/upload');
    expect(screen.getByRole('link', { name: /start session/i })).toHaveAttribute('href', '/upload');
    expect(screen.getAllByRole('link', { name: /log in/i })[0]).toHaveAttribute('href', '/login');
  });

  it('keeps the hero light on copy while showing the new dance vibe elements', () => {
    render(React.createElement(Home));

    expect(screen.getByText(/catch the groove/i)).toBeInTheDocument();
    expect(screen.getByText(/move cleaner/i)).toBeInTheDocument();
    expect(screen.getByText(/stay in pocket/i)).toBeInTheDocument();
    expect(screen.getByText(/^yolo$/i)).toBeInTheDocument();
  });

  it('shows dashboard and sign out controls for signed in users', () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: 'Tempo Tester' } },
      status: 'authenticated',
    });

    render(React.createElement(Home));

    expect(screen.getByRole('link', { name: /^dashboard$/i })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: /open dashboard/i })).toHaveAttribute('href', '/dashboard');

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: '/' });
  });
});
