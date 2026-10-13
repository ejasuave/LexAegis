'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/review', label: 'Review' },
  { href: '/vault', label: 'Vault' },
  { href: '/history', label: 'History' },
  { href: '/verify', label: 'Verify' },
] as const;

export function NavBar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {ITEMS.map((item) => {
          const current = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center px-4 text-[0.875rem] ${
                  current
                    ? 'border-b-2 border-lj-cyan text-lj-text'
                    : 'border-b-2 border-transparent text-lj-secondary hover:text-lj-text'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
