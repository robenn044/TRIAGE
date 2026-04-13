# TRIAGE

TRIAGE is a voice-first tourist kiosk web app built for a Raspberry Pi 5 with a 7-inch display. It combines a live camera assistant, AI itinerary planner, and embedded maps into a kiosk-friendly tourist guide for Albania.

## Features

- Always-listening camera assistant with webcam capture, Groq vision responses, and natural text-to-speech
- Personalized itinerary planner tailored to city, interests, travel style, and group type
- In-app maps view plus recommendation links that open Google Maps for selected places
- Kiosk-friendly UI optimized for compact landscape displays
- Auto-lock flow with a shared `End Trip` control for resetting the experience between visitors

## Tech Stack

- React + Vite + TypeScript
- Tailwind CSS + shadcn/ui
- Groq API for vision + itinerary generation
- Vercel serverless function for production API proxy

## Local Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local env file:

   ```bash
   cp .env.example .env.local
   ```

3. Set your Groq key in `.env.local`:

   ```env
   GROQ_API_KEY=your_groq_api_key_here
   ```

4. Start the app:

   ```bash
   npm run dev
   ```

## Vercel Deployment

1. Import this repository into Vercel.
2. Add the environment variable `GROQ_API_KEY`.
3. Deploy normally — `vercel.json` handles the SPA rewrite and API route behavior.

## Raspberry Pi Kiosk Launch

```bash
chromium-browser --kiosk --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required https://your-vercel-url.vercel.app
```

## Validation

```bash
npm run lint
npm test
npm run build
```

## Notes

- Do not commit `.env.local` or real API keys.
- The app uses the rear/environment camera where available.
- In local development, `vite.config.ts` proxies `/api/ask` so Groq requests work without Vercel.
