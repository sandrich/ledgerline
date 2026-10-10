import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '../components/layout/Providers';
import { TopBar } from '../components/layout/TopBar';
import '../styles/tokens.css';
import '../styles/app.css';

export const metadata: Metadata = {
  title: { default: 'ledgerline', template: '%s | ledgerline' },
  description: 'Self-hosted portfolio tracker for Ethereum and Arbitrum',
  applicationName: 'ledgerline',
};

export const viewport: Viewport = { themeColor: '#f5f3ee', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" />
        <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" />
      </head>
      <body>
        <a className="skip" href="#app">
          Skip to content
        </a>
        <div className="grain" aria-hidden="true" />
        <Providers>
          <TopBar />
          <main id="app">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
