import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Federal Order Fulfillment Control Tower',
  description: 'AI-powered federal order fulfillment scenario analysis',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <header className="header">
            <h1>Federal Order Fulfillment Control Tower</h1>
            <p className="subtitle">AI-powered scenario analysis for federal orders</p>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
