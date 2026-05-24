# Fold Companion Pro — Design Specification

## Goal
Upgrade the existing Fold Companion app into "Fold Companion Pro" by transforming the UI into a premium dark glassmorphic design, fixing the PWA native experience, and ensuring long-term reliability through automated E2E testing and a comprehensive mock data strategy.

## Architecture & Data Flow
The application remains a local-first Progressive Web App (PWA) connecting to an `unfold` server (or a local mock) to fetch transactions. It uses the Anthropic Claude API for spending analysis. 

1.  **Frontend**: Single-page HTML/CSS/JS application.
2.  **PWA Context**: Service worker (`sw.js`) and manifest (`manifest.json`) for offline capabilities and "Add to Home Screen" functionality.
3.  **Data Source**: External `unfold` server (REST API returning JSON).
4.  **AI Engine**: Direct client-to-API calls to Anthropic's Claude.

## Core Requirements & Features

### 1. Visual & UI Upgrade (Dark Glassmorphism)
*   **Aesthetic**: Deep slate-black background (`#08090a` to `#0d0f12`), frosted glass cards (`backdrop-filter: blur(20px)`), subtle neon borders, and dynamic micro-animations.
*   **Typography**: Clean, highly readable sans-serif (Sora or Inter).
*   **Visualizations**: Custom SVG or Canvas-based charts showing:
    *   Cumulative monthly spend.
    *   Category breakdown doughnut/bar charts.
    *   Weekly spending patterns.

### 2. PWA Native Polish
*   **Service Worker**: Properly register `sw.js` within `index.html` to enable background caching.
*   **Icons**: Ensure `manifest.json` links to high-quality generated PWA app icons (e.g., `icon-192.png`, `icon-512.png`).
*   **Offline Mode**: Gracefully handle offline scenarios, caching past transactions and showing appropriate UI states.

### 3. Data Mocking Strategy (Dual Approach)
*   **Client-Side Demo Mode**: A "Demo Mode" toggle in the settings panel. When enabled, it populates `localStorage` with rich, high-fidelity mock transactions without requiring an external backend. This is for instant user exploration.
*   **External Mock Server**: A lightweight Node.js Express server (`mock_server.js`) that mimics the `unfold` API. It serves realistic JSON data on `http://localhost:5001`. This is used exclusively for automated testing.

### 4. Automated E2E Testing
*   **Framework**: Playwright.
*   **Scope**:
    *   Verify loading transactions from the mock server.
    *   Test saving and applying settings.
    *   Test the Demo Mode toggle.
    *   Mock the Anthropic API response to verify the chat UI renders correctly.

## Components & Changes

*   `[MODIFY]` `index.html`: Complete rewrite of the `<style>` block and UI structure. Add Demo Mode logic, chart rendering functions, and fix service worker registration.
*   `[MODIFY]` `sw.js`: Enhance caching strategy to robustly handle offline states.
*   `[MODIFY]` `manifest.json`: Add references to new PWA icons and ensure valid properties.
*   `[NEW]` `icon-192.png` & `icon-512.png`: Generated premium icons.
*   `[NEW]` `mock_server.js`: Node.js server for testing.
*   `[NEW]` `tests/e2e.test.js`: Playwright test suite.

## Error Handling & Edge Cases
*   **No API Key**: Prominent, friendly prompt to add the key in settings before chat unlocks.
*   **Unfold Server Down**: Fallback to cached data or prompt the user to try "Demo Mode" if they don't have an unfold server running.
*   **Invalid JSON from API**: Catch fetch errors and display a toast notification without crashing the app.

## Testing Strategy
1.  Run `node mock_server.js` on port `5001`.
2.  Run `npx serve .` on port `3000`.
3.  Execute `npx playwright test` to run the `e2e.test.js` suite against the local environment.
