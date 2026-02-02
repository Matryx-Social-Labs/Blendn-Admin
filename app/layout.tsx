import type { Metadata } from "next";
import "./globals.css";


export const metadata: Metadata = {
  title: "Blendn",
  description: "A Social Media App to meet new people around you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="">

        {children}
      </body>
    </html>
  );
}
