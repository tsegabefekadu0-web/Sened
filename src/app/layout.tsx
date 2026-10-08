import type { Metadata, Viewport } from "next";
import { Noto_Sans_Ethiopic, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import { VoxideAssistantLazy } from "@/components/voice/VoxideAssistantLazy";
import { ActiveGroupProvider } from "@/lib/groups/useActiveGroup";

// Self-hosted at build time by next/font, so no runtime request goes to Google.
// The CSS variables are consumed first in the font stacks in globals.css and
// tailwind.config.js; the original family names stay behind them as fallbacks.
const notoSansEthiopic = Noto_Sans_Ethiopic({
  subsets: ["ethiopic", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-noto-sans-ethiopic"
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-plus-jakarta-sans"
});

export const metadata: Metadata = {
  title: "Sened (ሰነድ) — የህብረተሰብ እቁብ እና ዕድር አስተዳዳሪ",
  description: "Voice-Audited Community Treasury & Dispute-Free Trust Engine for Ethiopian Equbs and Iddirs.",
  // A manifest is not discoverable until the document references it, so this is
  // the single line that makes the offline console installable. The manifest
  // itself and the service worker are AGENT-4's (`public/manifest.json`,
  // `public/sw.js`); `src/app/layout.tsx` is A1's, which is why the link lived
  // as a filed request rather than an edit. See docs/requests/agent-4.md R2.
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Sened",
    statusBarStyle: "black-translucent"
  },
  // Chrome deprecated apple-mobile-web-app-capable (emitted above for iOS) in
  // favour of this standard tag; both are kept so neither platform loses it.
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
  themeColor: "#140F0D"
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="am" className={`${notoSansEthiopic.variable} ${plusJakartaSans.variable}`}>
      <body className="min-h-screen bg-[#F4EEE5] font-ethiopic antialiased selection:bg-terracotta-500 selection:text-white">
        <ServiceWorkerRegistration />
        {/* One active group for the whole app: a client provider inside this server layout. */}
        <ActiveGroupProvider>
          {children}
          {/* Once, here, so the voice widget survives navigation. Renders nothing without NEXT_PUBLIC_VOXIDE_KEY. */}
          <VoxideAssistantLazy />
        </ActiveGroupProvider>
      </body>
    </html>
  );
}
