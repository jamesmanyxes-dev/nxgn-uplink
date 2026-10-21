# HANDOFF NOTE — Make the NXGN UPLINK site load faster (keep the video!)

## Context
This repo (`jamesmanyxes-dev/nxgn-uplink`) is the EVIL⁶⁶⁶ MD WhatsApp pairing site.
The OWNER LOVES the current look and the background VIDEO. The ONLY problem is slow
initial load. Do NOT remove the video, do NOT redesign. Optimize loading only.

## Where the time goes
1. Google Fonts (`Orbitron` + `Rajdhani`) are render-blocking over `fonts.googleapis.com` (slow in some regions).
2. The background video (`public/bg.webm`, 2.5MB) starts loading immediately alongside the HTML.
3. `body` has a CSS `background: url(poster.jpg)` — fine, it's 36KB, keep it.
4. No HTTP caching/headers beyond basic ones.

## What to do (in order)
1. **Self-host the fonts.** Download Orbitron (500,700,900) and Rajdhani (400,500,600,700) as woff2,
   put them in `public/fonts/`, add `@font-face` rules with `font-display: swap` in the `<style>`,
   and DELETE the two Google Fonts `<link>` tags. This removes the biggest render-block.
2. **Defer the video.** On the `<video id="bgv">` element: remove `autoplay` and `src`,
   add `preload="none"` and keep `poster="poster.jpg"`. Then in the JS, after the boot sequence
   finishes (`document.getElementById('boot').classList.add('done')` is inside the `bt` interval's
   else branch), set `bgv.src = '/bg.webm'; bgv.play()`. The user sees the poster instantly;
   the video fades in once the UI is interactive. Add a CSS fade: `#bgv{opacity:0;transition:opacity 1.2s}`
   and set `bgv.style.opacity='1'` when play starts.
3. **Preload the video during idle time.** After step 2 works, also add
   `<link rel="preload" as="fetch" href="/bg.webm">` — optional, test first.
4. **Cache headers.** If the server allows, serve `/bg.webm` and fonts with
   `Cache-Control: public, max-age=604800, immutable` so repeat visits are instant.

## Definition of done
- HTML paints with poster + full UI in under ~1s on a phone.
- Video starts only after the UI is visible (boot overlay done), fading in smoothly.
- No render-blocking external requests (fonts are local).

## Do NOT
- Do not remove the video, the embers canvas, the fog, the tilt, the sound, or any visual.
- Do not change the design, colors, text, or layout.
- Do not rename files/variables (server routes reference `/bg.webm` and `poster.jpg`).

## Env the server needs (already set on owner's Render, FYI)
SEYORI_PANEL_URL, SEYORI_PANEL_KEY, SEYORI_PANEL_SERVER,
SEYORI_PANEL2_KEY, SEYORI_PANEL2_SERVER, SEYORI_PANEL3_KEY, SEYORI_PANEL3_SERVER
