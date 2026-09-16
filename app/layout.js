import { IBM_Plex_Sans, IBM_Plex_Mono, Silkscreen } from 'next/font/google';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });
const pixel = Silkscreen({ subsets: ['latin'], weight: ['400'], variable: '--font-pixel', display: 'swap' });

export const metadata = {
  title: 'TypeSafe Pixels',
  description: 'Let Jev decide every pixel of a pixel-art image, one Score question per channel.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${pixel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
