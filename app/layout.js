import './globals.css';

export const metadata = {
  title: 'TypeSafe Pixels',
  description: 'Let Jev decide every pixel of a pixel-art image, one Score question per channel.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
