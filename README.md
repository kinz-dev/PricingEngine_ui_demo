# Pricing Engine UI (Vue 3 + Vite)

A Vue 3 single-page application that displays a custom order book (bids in green, asks in red) and a JSON configuration panel.

## Prerequisites
- Node.js 18+

Check your Node version:
```
node -v
```

## Run locally (development)
1. Install dependencies:
```
npm install
```
2. Start the dev server:
```
npm run dev
```
3. Open the URL printed in the terminal (typically http://localhost:5173).

## Build for production
```
npm run build
```
Then preview the built app locally:
```
npm run preview
```

## Notes
- This project uses Vite with Vue 3 Single File Components (SFCs).
- Main files:
  - `index.html` – Vite entry
  - `src/main.js` – bootstraps the Vue app
  - `src/App.vue` – app layout, styles, and logic

## Optional: Vue-compatible realtime table libraries
If you later want a production-grade grid/table:
- AG Grid Community (Vue wrapper) – feature-rich and fast.
- TanStack Table (Vue Table) – headless, flexible; style it yourself.

