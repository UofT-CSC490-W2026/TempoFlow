import Image from 'next/image';
import Link from 'next/link';

type AppHeaderProps = {
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

export function AppHeader({
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: AppHeaderProps) {
  return (
    <header className="sticky top-0 left-0 right-0 z-50 border-b border-sky-100 bg-white/85 backdrop-blur-md">
      <div className="flex items-center px-6 py-3">
        <div className="flex-1">
          <Link href="/" className="flex items-center">
            <Image
              src="/logo.png"
              alt="TempoFlow"
              width={140}
              height={40}
              className="rounded"
              priority
            />
          </Link>
        </div>

        <div className="flex flex-1 items-center justify-end gap-3">
          {secondaryHref && secondaryLabel ? (
            <Link
              href={secondaryHref}
              className="px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
            >
              {secondaryLabel}
            </Link>
          ) : null}

          <Link
            href={primaryHref}
            className="rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2 text-sm font-medium text-white transition-all hover:from-blue-600 hover:to-cyan-500"
          >
            {primaryLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}
