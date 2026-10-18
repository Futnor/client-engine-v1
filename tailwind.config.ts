import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(-10px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 20px -5px hsl(var(--primary) / 0.4)" },
          "50%": { boxShadow: "0 0 40px -5px hsl(var(--primary) / 0.6)" },
        },
        // ── Soro-style landing-page motion (added v2.4.93) ──────────────
        // Slow drifting gradient blobs in the hero background.
        blob: {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "33%":      { transform: "translate3d(40px,-60px,0) scale(1.08)" },
          "66%":      { transform: "translate3d(-30px,30px,0) scale(0.94)" },
        },
        // Animated gradient sweep on hero gradient text.
        "gradient-shift": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%":      { backgroundPosition: "100% 50%" },
        },
        // Subtle vertical float for hero logo / decorative elements.
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%":      { transform: "translateY(-8px)" },
        },
        // Word-by-word hero headline reveal: blur + slide + fade in.
        "blur-in": {
          from: { opacity: "0", filter: "blur(12px)", transform: "translateY(18px)" },
          to:   { opacity: "1", filter: "blur(0)",   transform: "translateY(0)" },
        },
        // Glow rim that expands and fades — sits behind the CTA button.
        "glow-pulse": {
          "0%, 100%": { opacity: "0.55", transform: "scale(1)" },
          "50%":      { opacity: "0.85", transform: "scale(1.06)" },
        },
        // Shimmer sweep for "Live" / "New" pills.
        shimmer: {
          "0%":   { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(200%)" },
        },
        // ── Landing-bot delivery animation (12s loop) ──────────────────
        // Bot horizontal movement + delivery tilt.
        // 0–10%: wave at center.   10–25%: walk to LEFT (pickup).
        // 25–35%: pickup pause.    35–65%: walk to RIGHT (carry box).
        // 65–75%: deliver tilt.    75–90%: walk back to center.   90–100%: idle.
        "bot-pos": {
          "0%, 10%":   { transform: "translateX(0)" },
          "25%":       { transform: "translateX(-180px)" },
          "35%":       { transform: "translateX(-180px)" },
          "65%":       { transform: "translateX(180px)" },
          "75%":       { transform: "translateX(180px)" },
          "90%, 100%": { transform: "translateX(0)" },
        },
        // Wave at start (0–10%) and slight forward-lean delivery tilt at 70%.
        "bot-tilt": {
          "0%, 100%": { transform: "rotate(0deg)" },
          "2%":       { transform: "rotate(-8deg)" },
          "5%":       { transform: "rotate(9deg)" },
          "8%":       { transform: "rotate(-5deg)" },
          "10%":      { transform: "rotate(0deg)" },
          "67%, 73%": { transform: "rotate(0deg)" },
          "70%":      { transform: "rotate(10deg)" },
        },
        // Subtle continuous bob to imply "walking" — runs on its own faster cycle.
        "bot-bob": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%":      { transform: "translateY(-5px)" },
        },
        // Message box journey: spawn at LEFT, get picked up, travel with bot,
        // drop at RIGHT, fade and re-spawn at LEFT for the next loop.
        "box-journey": {
          "0%, 12%": {
            transform: "translateX(-260px) translateY(8px) scale(0.92) rotate(-4deg)",
            opacity: "0.95",
          },
          "20%": {
            transform: "translateX(-260px) translateY(0) scale(1) rotate(-2deg)",
            opacity: "1",
          },
          "28%": {
            transform: "translateX(-260px) translateY(-30px) scale(1) rotate(0deg)",
            opacity: "1",
          },
          "35%": {
            transform: "translateX(-180px) translateY(-70px) scale(1.02) rotate(0deg)",
            opacity: "1",
          },
          "65%": {
            transform: "translateX(180px) translateY(-70px) scale(1.02) rotate(0deg)",
            opacity: "1",
          },
          "70%": {
            transform: "translateX(255px) translateY(-30px) scale(1) rotate(4deg)",
            opacity: "1",
          },
          "78%": {
            transform: "translateX(260px) translateY(0) scale(1) rotate(2deg)",
            opacity: "1",
          },
          "85%": {
            transform: "translateX(260px) translateY(0) scale(0.85) rotate(0deg)",
            opacity: "0",
          },
          "86%, 99%": {
            transform: "translateX(-260px) translateY(8px) scale(0.92) rotate(-4deg)",
            opacity: "0",
          },
          "100%": {
            transform: "translateX(-260px) translateY(8px) scale(0.92) rotate(-4deg)",
            opacity: "0.95",
          },
        },
        // Antenna signal pulse on the bot (the radio waves above its head).
        "signal-pulse": {
          "0%, 100%": { opacity: "0.4", transform: "scale(0.95)" },
          "50%":      { opacity: "1",   transform: "scale(1.05)" },
        },
        // Soft ground-shadow that grows/shrinks with the bot's bob.
        "shadow-bob": {
          "0%, 100%": { transform: "scaleX(1)",   opacity: "0.5" },
          "50%":      { transform: "scaleX(0.9)", opacity: "0.35" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up":   "accordion-up 0.2s ease-out",
        "fade-in":   "fade-in 0.5s ease-out forwards",
        "slide-in":  "slide-in 0.3s ease-out forwards",
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        // Landing-page additions
        blob:             "blob 14s ease-in-out infinite",
        "gradient-shift": "gradient-shift 8s ease-in-out infinite",
        float:            "float 5s ease-in-out infinite",
        "blur-in":        "blur-in 0.9s cubic-bezier(0.16, 1, 0.3, 1) both",
        "glow-pulse":     "glow-pulse 3.2s ease-in-out infinite",
        shimmer:          "shimmer 2.4s ease-in-out infinite",
        // Landing-bot delivery animation
        "bot-pos":      "bot-pos 12s ease-in-out infinite",
        "bot-tilt":     "bot-tilt 12s ease-in-out infinite",
        "bot-bob":      "bot-bob 0.5s ease-in-out infinite",
        "box-journey":  "box-journey 12s ease-in-out infinite",
        "signal-pulse": "signal-pulse 1.4s ease-in-out infinite",
        "shadow-bob":   "shadow-bob 0.5s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
