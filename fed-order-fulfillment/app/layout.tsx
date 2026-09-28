import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Multi-Segment Order Fulfillment Control Tower',
  description: 'AI-powered fulfillment scenario analysis for federal, commercial, distributor, and D2C orders',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <header className="header">
            <h1>Multi-Segment Order Fulfillment Control Tower</h1>
            <p className="subtitle">AI-powered fulfillment planning for federal, commercial, distributor, and D2C orders</p>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
