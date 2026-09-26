/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        coffee: {
          DEFAULT: "#1A1412",
          950: "#0D0A08",
          900: "#140F0D",
          850: "#1A1412",
          800: "#241C18",
          700: "#322722",
          600: "#453630",
        },
        parchment: {
          DEFAULT: "#F5EFEB",
          50: "#FAF7F2",
          100: "#F5EFEB",
          200: "#EBE2D8",
          300: "#DDD0C2",
          800: "#2C241E",
          900: "#1C1612",
        },
        terracotta: {
          DEFAULT: "#C6532B",
          400: "#DE6A40",
          500: "#C6532B",
          600: "#A9411D",
          700: "#863214",
        },
        gold: {
          DEFAULT: "#D4A244",
          300: "#F3C769",
          400: "#E5B450",
          500: "#D4A244",
          600: "#B8862F",
        },
        verified: {
          bg: "#ECFDF5",
          border: "#A7F3D0",
          text: "#065F46",
          badge: "#10B981",
        },
        verification: "#16A34A",
        inkMuted: "#6F625D",
        line: "#DCCFC7",
        /*
         * Offline-first PWA — AGENT-4 (M6.1).
         *
         * Additive only. No existing token was renamed or removed, so A1-A3
         * code is unaffected. The three sync states get their own names so a
         * pending contribution can never be styled like a verified one by
         * accident, and `offline.*` covers the shell the treasurer uses with no
         * connection.
         */
        offline: {
          pending: "#B8862F",
          retry: "#8A6A22",
          rejected: "#A9411D",
          blocked: "#863214",
          surface: "#1C1612",
          raised: "#241C18",
          quiet: "#8B7C74"
        }
      },
      fontFamily: {
        ethiopic: ["Noto Sans Ethiopic", "Abyssinica SIL", "sans-serif"],
        sans: ["Plus Jakarta Sans", "Noto Sans Ethiopic", "Inter", "sans-serif"],
      },
      boxShadow: {
        debter: "0 16px 36px -8px rgba(13, 10, 8, 0.65), 0 4px 12px rgba(13, 10, 8, 0.4)",
        mic: "0 0 30px rgba(198, 83, 43, 0.45), 0 8px 24px rgba(198, 83, 43, 0.35)",
        card: "0 4px 16px -2px rgba(26, 20, 18, 0.08), 0 1px 3px rgba(26, 20, 18, 0.04)",
        soft: "0 18px 50px rgba(53, 32, 23, 0.10)",
      },
      animation: {
        "pulse-subtle": "pulseSubtle 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "wave-bar": "waveBar 1.2s ease-in-out infinite alternate",
        // AGENT-4: a slow breath on a *pending* badge only. Deliberately gentle —
        // a treasurer reading a queue of 40 unsynced contributions should not be
        // shown 40 flashing elements, and a pulse must never suggest progress
        // that is not actually happening.
        "offline-pulse": "offlinePulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        pulseSubtle: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.88", transform: "scale(1.03)" },
        },
        waveBar: {
          "0%": { height: "4px" },
          "100%": { height: "20px" },
        },
        offlinePulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.72" },
        },
      },
    },
  },
  plugins: [],
};
