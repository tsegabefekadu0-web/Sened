import type { Metadata, Viewport } from "next";
import {
  Abyssinica_SIL,
  Atkinson_Hyperlegible,
  Bricolage_Grotesque,
  Noto_Sans_Ethiopic,
  Noto_Serif_Ethiopic
} from "next/font/google";

import "./globals.css";
import { PressFeedback } from "@/components/ui/PressFeedback";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { VoxideAssistantLazy } from "@/components/assistant/VoxideAssistantLazy";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";
import { THEME_INIT_SCRIPT } from "@/lib/ui/theme";

// Self-hosted at build time by next/font, so no runtime request goes to Google.
const notoSans = Noto_Sans_Ethiopic({ subsets: ["ethiopic", "latin"], weight: ["400", "600", "700"], display: "swap", variable: "--font-noto-sans-ethiopic" });
const notoSerif = Noto_Serif_Ethiopic({ subsets: ["ethiopic", "latin"], weight: ["500", "700"], display: "swap", variable: "--font-noto-serif-ethiopic" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "600", "700", "800"], display: "swap", variable: "--font-bricolage" });
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], display: "swap", variable: "--font-atkinson" });
const abyssinica = Abyssinica_SIL({ subsets: ["ethiopic"], weight: "400", display: "swap", variable: "--font-abyssinica" });

export const metadata: Metadata = {
  title: "ሰነድ · Sened",
  description: "A shared ledger for your equb: say what was paid, the bank confirms it, everyone can see.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "Sened", statusBarStyle: "black-translucent" },
  other: { "mobile-web-app-capable": "yes" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: "/icons/icon-192.png"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1F6B4A"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const fonts = [notoSans, notoSerif, bricolage, atkinson, abyssinica].map((f) => f.variable).join(" ");
  return (
    <html lang="am" className={fonts} suppressHydrationWarning>
      <head>
        {/* Sets data-theme before first paint: saved choice, else the device preference. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-body antialiased">
        <ServiceWorkerRegistration />
        <PressFeedback />
        {/* One active group for the whole app. */}
        <ActiveGroupProvider>
          {children}
          {/* Headless: the English voice sheet drives it. Renders nothing without NEXT_PUBLIC_VOXIDE_KEY. */}
          <VoxideAssistantLazy headless />
        </ActiveGroupProvider>
      </body>
    </html>
  );
}
