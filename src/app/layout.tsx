import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CROWNFALL: The Last Light — Playable Web Port",
  description:
    "Browser port of the Godot 4 vertical slice of CROWNFALL: THE LAST LIGHT — a 2D medieval kingdom-building & survival adventure. Build, explore, recruit villagers and survive the Greedling night raids on Forgotten Shore.",
  keywords: [
    "Crownfall",
    "kingdom building game",
    "survival game",
    "Godot",
    "web game",
    "pixel art",
  ],
  authors: [{ name: "Crownfall Team" }],
  icons: {
    icon: "/assets/items/resources/items_resources_sheet.png",
  },
  openGraph: {
    title: "CROWNFALL: The Last Light — Playable Web Port",
    description:
      "Build a kingdom. Explore forgotten lands. Survive the darkness — in your browser.",
    siteName: "Crownfall",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
