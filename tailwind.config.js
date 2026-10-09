/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/app/**/*.{js,ts,jsx,tsx,mdx}", "./src/components/**/*.{js,ts,jsx,tsx,mdx}", "./src/lib/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        card: "var(--card)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        soft: "var(--soft)",
        hair: "var(--hair)",
        hair2: "var(--hair2)",
        field: "var(--field)",
        prim: "var(--prim)",
        primt: "var(--primt)",
        shop: "var(--shop)",
        dng: "var(--dng)"
      },
      fontFamily: {
        body: ["var(--font-atkinson)", "var(--font-noto-sans-ethiopic)", "system-ui", "sans-serif"],
        ethiopic: ["var(--font-noto-sans-ethiopic)", "var(--font-atkinson)", "sans-serif"],
        serif: ["var(--font-noto-serif-ethiopic)", "var(--font-abyssinica)", "serif"],
        display: ["var(--font-bricolage)", "var(--font-atkinson)", "sans-serif"]
      },
      transitionTimingFunction: {
        snd: "cubic-bezier(.2,.8,.2,1)",
        emph: "cubic-bezier(.32,.72,0,1)",
        spring: "cubic-bezier(.34,1.56,.64,1)"
      },
      boxShadow: { lift: "var(--lift)" }
    }
  },
  plugins: []
};
